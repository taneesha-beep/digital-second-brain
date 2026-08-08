'use strict';

/**
 * v3-tfidf.js — Phase 3.2. TF-IDF cosine over the full vocabulary.
 *
 *   v1:  |A ∩ B| / |A|          set intersection over 10 selected words
 *   v2:  |A ∩ B| / |A ∪ B|      the same sets, symmetric denominator
 *   v3:  cos(vA, vB)            w(t) = tf(t) · idf(t), every term, no selection
 *
 * WHAT THIS RUNG IS. PRIMER.md §3.4: the shipped algorithm computes a genuine
 * rarity signal — `count × idf × (1 + ln len)` — uses it to pick ten words, and
 * then THROWS EVERY NUMBER AWAY, treating those ten as an unordered set. A note
 * where `sourdough` appeared forty times and one where it appeared once are
 * identical to the linker. v3 is where that stops.
 *
 * It is NOT "the IDF finally gets a corpus". That premise was corrected on
 * 4 Aug 2026: every production caller already passes loadUserCorpus(...), so
 * the IDF has always been live. The rung is the cosine, and the full
 * vocabulary. Hence the label v3-tfidf, and hence registry.json's ladder-v2-v3
 * entry is renamed from `v3-idf` in the same commit that ships this file, per
 * its own _labelsAreForward note.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LEAVE-ONE-OUT IDF IS A GLOBAL PER-TERM CONSTANT HERE, AND THAT IS WHY THIS
 * IS A REAL COSINE.
 *
 * The obvious worry: leave-one-out idf is per-DOCUMENT, so the same term would
 * be weighted differently in the query vector and in the document vector, and
 * two vectors in differently-scaled spaces do not have a cosine between them.
 *
 * It does not happen. A document's vector only holds terms the document
 * CONTAINS, and for those df_loo = df − 1 always. So for every document D
 * containing t:
 *
 *      idf_loo(t, D) = ln((N−1+1) / ((df−1)+1)) + 1 = ln(N / df) + 1
 *
 * — no dependence on D. One global table, one vector space, and symmetry is
 * inherited from v2 rather than re-argued. Checked against v1's own arithmetic
 * over 500 corpus documents: max |Δ| = 0.
 *
 * The table below is still computed the long way, `ln((docCount+1)/(dfLoo+1))
 * + 1` with docCount = (N−1) || 1, rather than from the closed form. The two
 * agree for every N except N = 1, where v1's `|| 1` fallback makes docCount 1
 * and the closed form does not. Correctness by construction; the closed form is
 * the insight, not the implementation.
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT ADMITS A CANDIDATE, WHICH IS THE DECISION THIS RUNG COULD NOT INHERIT.
 *
 * v1 admitted on `threshold`, v2 on `minShared`, both with `cap`. A cosine is
 * CONTINUOUS, so §13.2's argument — that the threshold grid IS the achievable
 * score lattice, which is what made 2.7's sweep exhaustive rather than a sample
 * — does not transfer. There are 32 achievable v1 scores and 64 achievable v2
 * scores; there is no such set here. None of the three has a defensible
 * inherited value.
 *
 * DECISION: v3 admits every candidate sharing at least one term, ranks by
 * cosine, and returns the top k. No threshold, no cap.
 *
 *   threshold  DROPPED, not carried at 0 as v2 carried it. v2 kept an inert
 *              zero so a future sweep would be a param flip rather than a file
 *              edit. That reasoning rests on there being a lattice to sweep. A
 *              v3 threshold study needs a NEW methodological argument first,
 *              and a file edit is the right amount of friction for that;
 *              carrying the key would invite a value no argument supports.
 *
 *   cap        ABSENT, and pre-registered absent. §14.3 and types.js both
 *              recorded "v3 and v4 will carry no cap" at 3.1, BEFORE this file
 *              existed. Adding one now, after seeing 3.1's boundary p, is the
 *              metric-shopping §11.5 forbids. §13.2 measured the consequence in
 *              advance: every cap ≥ 10 is unobservable at kMax = 10, so an
 *              uncapped rung differs from v1/v2 at @10 only, by 0.005086.
 *              @1/@5/@8 — including the pre-registered primary — are
 *              cap-invariant by construction.
 *
 *   scorePrecision  DROPPED. In v1 toFixed(4) decided MEMBERSHIP (§7.7); in v2,
 *              tie structure over 64 achievable values. Here it would
 *              MANUFACTURE ties in a continuous score across ~15,000
 *              candidates and hand their order to index.js's lexicographic
 *              docid tiebreak. That is inheriting an artifact, not a rule.
 *
 *   minShared  PRESENT AT 1, WHICH IS INERT: candidates are gathered from the
 *              query's postings, so every one of them shares ≥ 1 term already.
 *              It is here as the ablation handle — the same pattern v2 used for
 *              `threshold: 0` (§14.3) — because the missing admission rule is a
 *              real variable and not a vacuous one. Measured before this file
 *              was written: 10.72% of v3's top-10 hits (2,471 of 23,040 across
 *              dev) share EXACTLY ONE term, so minShared 2 would delete one in
 *              nine returned documents. That arm is run and reported rather
 *              than argued away.
 *
 * CONSEQUENCE, STATED RATHER THAN SMOOTHED: the registered v2-vs-v3 comparison
 * prices a PACKAGE of three behavioural changes — similarity function,
 * vocabulary, and admission rule. compare-runs.js prints the count and says so.
 * Attribution lives in the ablations, exactly as §13.6's attribution lived in
 * the grid rather than in the comparison.
 * ─────────────────────────────────────────────────────────────────────────
 * COST, AND WHY THERE IS NO DOCUMENT-FREQUENCY CUTOFF.
 *
 * Measured on cooking (N = 27,325) before this file was written:
 *
 *   |V| 34,928 terms · Σ_t df_t 997,749 postings · Σ_t df_t² = 8.12e8
 *   max df 5,150 ("recipe", 18.8% of the corpus) · idf ∈ [2.6688, 11.2156]
 *   candidate pool per query: mean 15,067 of 27,325 (55%), p95 22,898
 *
 * Two costs that are routinely conflated, and only one of them is paid here:
 *
 *   per-query retrieval    Σ_{t∈q} df_t ≈ 31,000 postings visits. Over 2,304
 *                          dev queries, 71.4M. Seconds.
 *   all-pairs edge emission  Σ_t df_t² = 8.12e8 — CLAUDE.md's bound, and ~20×
 *                          the 4.07e7 a top-10 vocabulary costs. The EVAL NEVER
 *                          PAYS IT: it runs 2,304 queries, not 27,325². It is
 *                          Phase 4's problem, where the app rebuilds a graph.
 *
 * So there is no df cutoff, and if one ever becomes necessary it will be a
 * PARAM that lands in describe(handle).digest, never a silent constant — a
 * silent cutoff is exactly the "run that lies about itself" of §13.10.
 *
 * rank() collects every candidate rather than pre-truncating with ctx.k. That
 * is ~15,000 collect() calls per query where v1 made ~63, and the tempting
 * optimisation is for the retriever to keep its own top-k. It is not taken:
 * collecting everything is the version whose equivalence to the interface
 * contract needs no argument, because it IS the contract. If it ever has to
 * change, the replacement ships with a byte-identity proof against this one.
 */

const v1 = require('./v1-overlap');

const defaultParams = {
  /**
   * INHERITED from v1 and v2 — §12.1's decision, the shipped rule. Holding it
   * across three rungs is what keeps the ladder one-variable. It is newly
   * load-bearing here: v1 and v2 used idf only to SELECT ten words, v3 uses it
   * numerically in every score. `none` collapses idf to the constant ln2+1, so
   * the cosine becomes a pure TF cosine — which is §12.2's re-scoped ablation,
   * and the only form of "does the rarity signal help" this corpus can answer.
   */
  idfCorpus: 'leave-one-out',
  /**
   * CHANGED — null means the full vocabulary, and this is the rung. Fixed in
   * advance by roadmap 3.2 and PRIMER.md §6, so it is a declaration and not a
   * selection from the ablation that follows.
   */
  topN: null,
  /**
   * INHERITED at v1's value, and INERT at topN: null. The bonus only orders
   * terms for slice(0, topN), and there is no slice — so at v3's own
   * configuration it cannot do anything, which is what PRIMER.md §3.3
   * predicted ("v3 and v4 drop the select-top-10 stage entirely, so the bonus
   * is gone regardless"). Kept at the inherited value rather than deleted so
   * the ablation is a param flip, and proved inert by a byte-identical run
   * rather than asserted. It bites only in the topN: 10 arm, which is where
   * roadmap 3.2's length-bonus ablation is therefore measured.
   *
   * It is NOT part of the term weight. w(t) = tf · idf. Folding a word-length
   * bonus into a cosine weight would be a nonstandard invention this rung has
   * no reason to defend, and it would hand v4 a strange predecessor.
   */
  lengthBonus: true,
  /**
   * NEW, and inert at 1 — see the header block. The handle for the admission
   * ablation, not a rule v3 applies.
   */
  minShared: 1
};

/**
 * One global document-frequency pass, then one vector per document.
 *
 * The idf table is per-TERM and not per-document; the header derives why that
 * is exact for leave-one-out rather than an approximation of it.
 */
function buildIndex(docs, params) {
  if (!['leave-one-out', 'all', 'none'].includes(params.idfCorpus)) {
    throw new Error(`v3-tfidf: idfCorpus must be leave-one-out, all or none (got ${params.idfCorpus})`);
  }
  if (!(params.topN === null || (Number.isInteger(params.topN) && params.topN >= 1))) {
    // `slice(0, null)` returns [], so a null reaching a truncation path
    // silently empties every vector and every score becomes 0/0. Rejected at
    // index() rather than discovered as a run of zeroes.
    throw new Error(`v3-tfidf: topN must be null (full vocabulary) or a positive integer (got ${JSON.stringify(params.topN)})`);
  }
  if (!Number.isInteger(params.minShared) || params.minShared < 1) {
    throw new Error(`v3-tfidf: minShared must be a positive integer (got ${JSON.stringify(params.minShared)})`);
  }
  if (typeof params.lengthBonus !== 'boolean') {
    throw new Error(`v3-tfidf: lengthBonus must be a boolean (got ${JSON.stringify(params.lengthBonus)})`);
  }

  const n = docs.length;

  // Document frequency counts a document once per term, so the corpus side is
  // a Set and the title is NOT doubled — v1-overlap.js:200-207 verbatim, and
  // it must stay verbatim or the two rungs stop sharing an idf table.
  const dfSets = docs.map((doc) => new Set(v1.tokenise(`${doc.title || ''} ${doc.body || ''}`)));
  const globalDf = new Map();
  for (const set of dfSets) {
    for (const word of set) globalDf.set(word, (globalDf.get(word) || 0) + 1);
  }

  const idfOf = new Map();
  if (params.idfCorpus === 'none') {
    // keywords.js:76 — `docSets.length || 1` on an empty corpus, every df 0.
    const constant = Math.log((1 + 1) / (0 + 1)) + 1;
    for (const word of globalDf.keys()) idfOf.set(word, constant);
  } else {
    const docCount = params.idfCorpus === 'all' ? (n || 1) : ((n - 1) || 1);
    for (const [word, df] of globalDf) {
      // leave-one-out: a document's vector only holds terms it contains, and
      // for those df_loo = df − 1 for every such document. Hence one table.
      const effectiveDf = params.idfCorpus === 'all' ? df : df - 1;
      idfOf.set(word, Math.log((docCount + 1) / (effectiveDf + 1)) + 1);
    }
  }

  /**
   * TERM IDS ARE ASSIGNED IN SORTED VOCABULARY ORDER, AND EACH DOCUMENT'S
   * VECTOR IS STORED IN ASCENDING TERM ID. That is not tidiness — it is what
   * makes symmetry EXACT instead of approximate, and it was a test failure
   * before it was a decision.
   *
   * The dot product for A→B is accumulated by walking A's terms; for B→A, by
   * walking B's. Both sum the same products over the same shared terms, but
   * floating-point addition is not associative, so a different summation ORDER
   * gives a different last bit: on the fixture, score(A→B) came out
   * 0.14845859879756534 against 0.14845859879756532. Mathematically symmetric,
   * not bit-symmetric — and v2 established symmetry at EXACT float equality,
   * which this rung must not quietly weaken.
   *
   * With both vectors in ascending term id, both directions visit the shared
   * terms in the same order and multiply the same pair of weights (IEEE
   * multiplication is commutative), so the sums are bit-identical.
   *
   * The order is the sorted VOCABULARY rather than first-seen, because term
   * ids assigned as documents are processed would depend on corpus order — and
   * the accumulation order would with them, so a reversed corpus would produce
   * different last bits. globalDf's key SET is corpus-order-independent even
   * though its iteration order is not, so sorting it gives a canonical order
   * that survives both. Both properties are asserted by tests.
   */
  const vocabulary = [...globalDf.keys()].sort();
  const termIds = new Map();
  for (let t = 0; t < vocabulary.length; t += 1) termIds.set(vocabulary[t], t);

  const indexById = new Map();
  const idByIndex = new Array(n);
  const terms = new Array(n);    // Int32Array of term ids, ASCENDING
  const weights = new Array(n);  // Float64Array, aligned with terms
  const norms = new Float64Array(n);
  const postingsDocs = [];       // per term id: Int32Array of doc indices
  const postingsWeights = [];    // per term id: Float64Array, aligned

  const rawPostings = vocabulary.map(() => []);

  for (let i = 0; i < n; i += 1) {
    const doc = docs[i];
    indexById.set(doc.id, i);
    idByIndex[i] = doc.id;

    // keywords.js:59 — the title is tokenised and concatenated TWICE, so title
    // terms enter the term-frequency count at double weight. Inherited: this
    // rung changes how a pair of vectors is scored, not how a document is read.
    const titleTokens = v1.tokenise(doc.title || '');
    const allTokens = [...titleTokens, ...titleTokens, ...v1.tokenise(doc.body || '')];

    // A PLAIN OBJECT, not a Map, and that is load-bearing exactly as it is in
    // v1 (§7.4). JavaScript enumerates integer-like keys first in ascending
    // numeric order, so a numeric token such as "350" is hoisted to the front,
    // and the selection sort below is stable — so enumeration order breaks ties
    // between equal-scoring terms. A Map would preserve insertion order and
    // silently produce a different top-10, which would make the topN ablation
    // move two things at once.
    const tf = {};
    for (const word of allTokens) tf[word] = (tf[word] || 0) + 1;

    let entries = Object.entries(tf);
    if (params.topN !== null) {
      // v1's selection, verbatim in shape: count × idf × (1 + ln len), stable
      // descending sort, slice. The length bonus lives HERE and only here.
      const scored = entries.map(([word, count]) => ({
        word,
        count,
        score: count * idfOf.get(word) * (params.lengthBonus ? 1 + Math.log(word.length) : 1)
      }));
      scored.sort((a, b) => b.score - a.score);
      entries = scored.slice(0, params.topN).map((s) => [s.word, s.count]);
    }

    // Ascending term id — the canonical accumulation order. See above.
    entries.sort((x, y) => termIds.get(x[0]) - termIds.get(y[0]));

    const ids = new Int32Array(entries.length);
    const ws = new Float64Array(entries.length);
    let sumSq = 0;
    for (let j = 0; j < entries.length; j += 1) {
      const [word, count] = entries[j];
      const termId = termIds.get(word);
      // The weight is tf × idf. The length bonus is NOT in it — see the
      // defaultParams note.
      const weight = count * idfOf.get(word);
      ids[j] = termId;
      ws[j] = weight;
      sumSq += weight * weight;
      rawPostings[termId].push(i, weight);
    }
    terms[i] = ids;
    weights[i] = ws;
    norms[i] = Math.sqrt(sumSq);
  }

  // Weights are stored IN the postings list. Looking them up by scanning the
  // target's term array instead costs O(|D|) per postings visit, which is the
  // difference between seconds and minutes at 71M visits.
  for (let t = 0; t < rawPostings.length; t += 1) {
    const flat = rawPostings[t];
    const docsArr = new Int32Array(flat.length / 2);
    const wArr = new Float64Array(flat.length / 2);
    for (let j = 0, m = 0; j < flat.length; j += 2, m += 1) {
      docsArr[m] = flat[j];
      wArr[m] = flat[j + 1];
    }
    postingsDocs.push(docsArr);
    postingsWeights.push(wArr);
  }

  return {
    params,
    indexById,
    idByIndex,
    termIds,
    terms,
    weights,
    norms,
    postingsDocs,
    postingsWeights,
    // Scratch, reused across rank() calls and fully reset by each. search() is
    // serial, and the reset is in a finally block so a throw inside collect()
    // cannot leave a dirty accumulator for the next query to read.
    _acc: new Float64Array(n),
    _shared: new Int32Array(n),
    _touched: new Int32Array(n)
  };
}

/**
 * Accumulate the sparse dot product over the query's postings, then finalise.
 *
 * NO GUARD ON THE DENOMINATOR, DELIBERATELY — v2's precedent. A zero-norm
 * document has no terms at all, so it appears in no postings list and can never
 * be a candidate; as a query it gathers no candidates and returns nothing. If
 * that reasoning is ever wrong, assertHits rejects a non-finite score rather
 * than a plausible one reaching a run file.
 */
function rank(state, queryDoc, ctx) {
  const { params, indexById, idByIndex, terms, weights, norms, postingsDocs, postingsWeights } = state;
  const acc = state._acc;
  const shared = state._shared;
  const touched = state._touched;

  const qi = indexById.get(queryDoc.id);
  const qTerms = terms[qi];
  const qWeights = weights[qi];
  const qNorm = norms[qi];

  let nTouched = 0;
  try {
    // Query terms are visited in vector order, which is fixed at index time, so
    // the accumulation order — and therefore the last bits of every sum — is
    // deterministic. Floating-point addition is not associative and a
    // comparison asserts against a sidecar at exact float equality.
    for (let j = 0; j < qTerms.length; j += 1) {
      const termId = qTerms[j];
      const qw = qWeights[j];
      const bucket = postingsDocs[termId];
      const bucketW = postingsWeights[termId];
      for (let b = 0; b < bucket.length; b += 1) {
        const di = bucket[b];
        if (shared[di] === 0) {
          touched[nTouched] = di;
          nTouched += 1;
          acc[di] = 0;
        }
        acc[di] += qw * bucketW[b];
        shared[di] += 1;
      }
    }

    for (let z = 0; z < nTouched; z += 1) {
      const di = touched[z];
      if (di === qi) continue;
      if (shared[di] < params.minShared) continue;
      const score = acc[di] / (qNorm * norms[di]);
      if (!(score >= 0 && score <= 1 + 1e-9)) {
        // The formula guarantees [0, 1]: every weight is positive, since
        // idf = ln((docCount+1)/(df+1)) + 1 >= 1 for df <= docCount. A
        // violation is a defect in the norms or the accumulator, not an edge
        // case, so it stops rather than reaching a run file.
        throw new Error(
          `v3-tfidf: cosine ${score} outside [0,1] for ${queryDoc.id} -> ${di}. ` +
            'Every term weight is positive, so this is a defect in the norm or the accumulator.'
        );
      }
      // explain carries the COUNT of shared terms, not the terms themselves.
      // v1 and v2 emit sharedKeywords, which is ~2 strings; here it would be
      // ~30 strings for each of ~15,000 candidates on each of 2,304 queries —
      // 35M arrays allocated to describe candidates discarded one line later.
      // The count is what the admission ablation reads, and Phase 7.4's
      // explainability panel needs one pair at a time, not the whole run.
      ctx.collect(idByIndex[di], score, { shared: shared[di] });
    }
  } finally {
    for (let z = 0; z < nTouched; z += 1) {
      const di = touched[z];
      acc[di] = 0;
      shared[di] = 0;
    }
  }
}

/**
 * How many terms this document's vector carries. Not part of retrieval —
 * scripts/analyse-rungs.js stratifies by it, and at 3.1 it read the equivalent
 * straight out of v1's private `_state.keywordsById`, which crashed on the
 * first rung that does not store keyword lists.
 *
 * The quantity is NOT comparable to v1's and v2's. Theirs is the length of a
 * top-10 selection — capped at 10, and 96.1% of the corpus sits exactly there.
 * This one is the count of distinct terms: mean 36.5, p50 30, max 1,021 on
 * cooking. analyse-rungs prints which it used rather than assuming they agree.
 */
function termCount(state, docId) {
  return state.terms[state.indexById.get(docId)].length;
}

module.exports = {
  version: 'v3-tfidf',
  defaultParams,
  buildIndex,
  rank,
  termCount,
  /**
   * A cosine is symmetric, and §15.8 records that v3 kept it AT REAL COST —
   * term ids are sorted so the two directions accumulate their float sums
   * bit-identically. Exact float equality, not approximate agreement, which is
   * what the test checks.
   */
  symmetric: true
};
