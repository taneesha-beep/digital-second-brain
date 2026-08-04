'use strict';

/**
 * metrics.js — Phase 2.3
 *
 * P@k, R@k, MRR and nDCG@k over one query's ranked list, plus the aggregation
 * across queries. Pure functions: a ranked list in, numbers out. No file
 * loading, no run-file parsing, no corpus.
 *
 * WHY THIS IS NOT IN backend/retrieval/. A test walks the require graph of
 * backend/retrieval/ and fails if anything resolves outside it, because that is
 * the property letting Phase 4.1 hand the app and the harness one import path.
 * Metrics are not part of that interface — the app never scores itself against
 * qrels — so putting them there would widen a boundary that exists for a
 * reason. They live beside the harness instead, and stay I/O-free anyway so
 * that 2.4's validation script can call them directly.
 *
 * ============================================================================
 * NOTHING HERE IS VALIDATED YET. Roadmap 2.4 diffs this implementation against
 * pytrec_eval and requires agreement to 1e-6. Until that passes, every number
 * this file produces is PROVISIONAL and may not be quoted anywhere.
 * ============================================================================
 *
 * THE CONVENTIONS THIS FILE IMPLEMENTS, WRITTEN DOWN SO 2.4 HAS A TARGET.
 * nDCG has several published variants and picking one by accident produces
 * numbers that are internally consistent, comparable across this project's own
 * retrievers, and not comparable to anything anyone else has published — while
 * looking completely normal. That is the failure mode, so the choices are
 * stated rather than left in the code:
 *
 *   gain(grade)   = 2^grade - 1        (exponential; grade 2 -> 3, grade 1 -> 1)
 *   discount(rank)= 1 / log2(rank + 1) (rank is 1-based, so rank 1 discounts to 1)
 *   DCG@k         = sum over the returned list, truncated at min(k, |returned|)
 *   IDCG@k        = the same sum over the query's judged grades sorted
 *                   descending, truncated at min(k, |judged|)
 *   nDCG@k        = DCG@k / IDCG@k, and null when IDCG@k is 0
 *
 * DCG TRUNCATES AT WHAT YOU RETURNED; IDCG TRUNCATES AT k. That asymmetry is
 * the whole reason a short result list scores lower at a larger k, and it is
 * where a naive implementation of nDCG@10 goes wrong. It is not incidental
 * here: v1-overlap carries cap 8, so on this corpus roughly 96% of dev queries
 * return exactly 8 results and every one of them exercises this path at k=10.
 *
 * TWO KINDS OF QUERY THAT LOOK ALIKE AND ARE NOT (see aggregate() below):
 *   - the retriever returned nothing        -> scores 0, counted in the mean
 *   - the query has no judgeable documents  -> null, EXCLUDED from the mean
 * The first is a retrieval failure. The second is a ground-truth gap, and
 * scoring it 0 would blame the retriever for the answer key.
 *
 * TIES ARE NOT THIS FILE'S PROBLEM, DELIBERATELY. Every function here is a
 * pure function of the *ordered* list it is handed, so two documents with equal
 * scores produce whatever the caller's order produces. Fixing that order is
 * retrieval/index.js's job (descending score, then lexicographic on the id).
 * Claiming tie-independence here would be claiming a guarantee this file cannot
 * make.
 */

/** gain = 2^grade - 1. Grade 2 (duplicate) is worth 3; grade 1 (linked) is 1. */
function gain(grade) {
  return Math.pow(2, grade) - 1;
}

/** 1-based rank. Rank 1 discounts to 1, not to a division by zero. */
function discount(rank) {
  return 1 / Math.log2(rank + 1);
}

function assertK(k) {
  if (!Number.isInteger(k) || k < 1) {
    throw new TypeError(`metrics: k must be a positive integer (got ${k})`);
  }
}

/**
 * Normalise the two inputs every metric takes.
 *
 * @param {string[]} ranked  docIds in rank order, best first
 * @param {Map<string, number>|Object} judgments  docId -> grade, positive only
 */
function normaliseJudgments(judgments) {
  if (judgments instanceof Map) return judgments;
  return new Map(Object.entries(judgments || {}));
}

/** Judged at grade >= 1. The qrels here are positive-only; grade 0 would not be. */
function isRelevant(judgments, docId) {
  const grade = judgments.get(docId);
  return typeof grade === 'number' && grade > 0;
}

/**
 * Precision@k — of the first k returned, what fraction was judged relevant.
 *
 * The denominator is k, not the number returned. A retriever that returns 2
 * results and gets both right has P@8 = 0.25, not 1.0: the eight slots were
 * available and six were left empty. Dividing by the number returned would
 * reward returning less, which is the wrong incentive to build into a baseline
 * that a cap already makes short.
 */
function precisionAtK(ranked, judgments, k) {
  assertK(k);
  const j = normaliseJudgments(judgments);
  let hits = 0;
  const limit = Math.min(k, ranked.length);
  for (let i = 0; i < limit; i += 1) {
    if (isRelevant(j, ranked[i])) hits += 1;
  }
  return hits / k;
}

/**
 * Recall@k — of the query's judged documents, what fraction appears in the
 * first k. Returns null when the query has no judged documents, because 0/0 is
 * not 0.
 */
function recallAtK(ranked, judgments, k) {
  assertK(k);
  const j = normaliseJudgments(judgments);
  let relevantTotal = 0;
  for (const grade of j.values()) if (grade > 0) relevantTotal += 1;
  if (relevantTotal === 0) return null;

  let hits = 0;
  const limit = Math.min(k, ranked.length);
  for (let i = 0; i < limit; i += 1) {
    if (isRelevant(j, ranked[i])) hits += 1;
  }
  return hits / relevantTotal;
}

/**
 * Reciprocal rank of the first relevant result, or 0 if there is none.
 *
 * 0 rather than null when nothing relevant is found: that is a real, reportable
 * failure to retrieve, not an unanswerable query. The unanswerable case is
 * caught upstream, by the caller checking whether the query has any judgeable
 * documents at all.
 *
 * Unbounded by k by convention — trec_eval's `recip_rank` searches the whole
 * run. The runner caps the list at k before calling, so what is reported here
 * is reciprocal rank within the retrieved depth; the sidecar records that k.
 */
function reciprocalRank(ranked, judgments) {
  const j = normaliseJudgments(judgments);
  for (let i = 0; i < ranked.length; i += 1) {
    if (isRelevant(j, ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Discounted cumulative gain over the returned list, truncated at k. */
function dcgAtK(ranked, judgments, k) {
  assertK(k);
  const j = normaliseJudgments(judgments);
  let dcg = 0;
  const limit = Math.min(k, ranked.length);
  for (let i = 0; i < limit; i += 1) {
    const grade = j.get(ranked[i]);
    if (typeof grade === 'number' && grade > 0) dcg += gain(grade) * discount(i + 1);
  }
  return dcg;
}

/**
 * The best DCG@k any ranking of this query's judgments could achieve: grades
 * sorted descending, truncated at k.
 *
 * Truncated at k, NOT at the number of judgments. A query with 12 judged
 * documents cannot place all 12 in the top 8, so its IDCG@8 uses the best 8
 * grades. Summing all 12 into the denominator would silently deflate every
 * nDCG on hub queries — and this corpus has hubs at 245, 209 and 103
 * judgments against a median of 1.
 */
function idcgAtK(judgments, k) {
  assertK(k);
  const j = normaliseJudgments(judgments);
  const grades = [];
  for (const grade of j.values()) if (grade > 0) grades.push(grade);
  grades.sort((a, b) => b - a);

  let idcg = 0;
  const limit = Math.min(k, grades.length);
  for (let i = 0; i < limit; i += 1) idcg += gain(grades[i]) * discount(i + 1);
  return idcg;
}

/**
 * nDCG@k, or null when the query has no judged documents.
 *
 * null rather than 0 is the load-bearing choice. 0/0 is undefined, and a query
 * nobody could have answered is not a query the retriever failed — folding it
 * in as 0 would move the mean by an amount attributable to the answer key
 * rather than to the algorithm. The caller counts and reports these separately.
 */
function ndcgAtK(ranked, judgments, k) {
  const idcg = idcgAtK(judgments, k);
  if (idcg === 0) return null;
  return dcgAtK(ranked, judgments, k) / idcg;
}

/**
 * Every metric for one query, at every requested k.
 *
 * @param   {string[]} ranked   docIds in rank order
 * @param   {Map|Object} judgments  docId -> grade
 * @param   {number[]} ks
 * @returns {Object} { judged, retrieved, mrr, p: {k: v}, r: {k: v}, ndcg: {k: v|null} }
 */
function scoreQuery(ranked, judgments, ks) {
  const j = normaliseJudgments(judgments);
  let judged = 0;
  for (const grade of j.values()) if (grade > 0) judged += 1;

  const p = {};
  const r = {};
  const ndcg = {};
  for (const k of ks) {
    p[k] = precisionAtK(ranked, j, k);
    r[k] = recallAtK(ranked, j, k);
    ndcg[k] = ndcgAtK(ranked, j, k);
  }

  return { judged, retrieved: ranked.length, mrr: reciprocalRank(ranked, j), p, r, ndcg };
}

/**
 * Mean each metric over the per-query scores from scoreQuery().
 *
 * TWO POPULATIONS, AND CONFLATING THEM IS THE POINT OF THIS FUNCTION.
 *
 *   - A query the retriever returned nothing for scores 0 everywhere and IS
 *     included. That matches trec_eval, which scores a qid present in qrels and
 *     absent from the run as 0, and it is also just correct: excluding them
 *     would inflate every metric by exactly the failure rate. Silent inflation
 *     of that kind is the same class of error as self-retrieval.
 *
 *   - A query with no judgeable documents scores null and IS EXCLUDED, then
 *     counted in `unjudgeable`. Its metrics are 0/0, not 0.
 *
 * On cooking these two populations are respectively non-empty and empty, both
 * measured. The distinction is implemented anyway, because it stops being true
 * on any other site and a mean that quietly absorbs 0/0 gives no sign of it.
 *
 * ONE POPULATION FOR EVERY COLUMN. Unjudgeable queries are dropped once, up
 * front, rather than per-metric. Left to fall out of each metric's own return
 * value they would be excluded from nDCG and R (which return null) and included
 * in P and MRR (which return 0), so the columns of a single printed row would
 * have different denominators — a table that looks uniform and is not. Every
 * mean below is over `scored`.
 *
 * @param   {Object[]} perQuery
 * @param   {number[]} ks
 */
function aggregate(perQuery, ks) {
  const n = perQuery.length;
  const judgeable = perQuery.filter((q) => q.judged > 0);

  const meanOf = (pick) => {
    let sum = 0;
    let count = 0;
    for (const q of judgeable) {
      const value = pick(q);
      if (value === null || value === undefined) continue;
      sum += value;
      count += 1;
    }
    return count === 0 ? null : sum / count;
  };

  const p = {};
  const r = {};
  const ndcg = {};
  for (const k of ks) {
    p[k] = meanOf((q) => q.p[k]);
    r[k] = meanOf((q) => q.r[k]);
    ndcg[k] = meanOf((q) => q.ndcg[k]);
  }

  const unjudgeable = n - judgeable.length;
  // Counted over the scored population, so it is the denominator the metric
  // means actually used rather than a count from a different population.
  let zeroResult = 0;
  for (const q of judgeable) if (q.retrieved === 0) zeroResult += 1;

  return {
    queries: n,
    scored: judgeable.length,
    unjudgeable,
    zeroResult,
    mrr: meanOf((q) => q.mrr),
    p,
    r,
    ndcg
  };
}

module.exports = {
  gain,
  discount,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  dcgAtK,
  idcgAtK,
  ndcgAtK,
  scoreQuery,
  aggregate
};
