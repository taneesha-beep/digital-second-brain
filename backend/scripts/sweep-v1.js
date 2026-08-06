#!/usr/bin/env node
'use strict';

/**
 * sweep-v1.js — Phase 2.7
 *
 * Sweep v1-overlap's two shipped constants — the `> 0.15` threshold and the
 * `slice(0, 8)` cap — against the dev split, and select a configuration.
 *
 *   npm run sweep:v1
 *   npm run sweep:v1 -- --fresh          # ignore cached grid points
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SWEPT, AND WHAT "k" MEANS
 *
 * The roadmap says "threshold and k". Those are two different objects and only
 * one of them is a knob:
 *
 *   - THE CAP is linker.service.js:36's slice(0, 8), carried as the `cap`
 *     param. That is the "top 8" and it is what is swept.
 *   - THE REPORTING k, {1, 5, 8, 10}, is a metric convention fixed at 2.3
 *     (EVALUATION.md §9.1) and validated against pytrec_eval at 2.4. Moving it
 *     changes the measuring instrument rather than the thing measured, which is
 *     two variables at once, and would make every point here incomparable to
 *     §12's baseline row. run-eval.js has no flag for it and this script does
 *     not add one.
 *
 * topN — the third unvalidated constant — is NOT swept here. It belongs to
 * roadmap 3.2, which already registers "full vocabulary versus top-10
 * truncation" as one of its one-variable ablations. And mechanically it is not
 * an orthogonal third axis at all: topN is the DENOMINATOR of `strength`, so
 * changing it redefines what every threshold on this grid means. A topN x
 * threshold grid is a two-variable change everywhere except along one edge.
 *
 * ---------------------------------------------------------------------------
 * THE THRESHOLD GRID IS THE SCORE LATTICE, NOT A DECIMAL RULER
 *
 * strength = Number((shared / d).toFixed(4)) with d = |query keywords| <= topN,
 * and the filter is strictly greater. So the retriever's behaviour is a STEP
 * FUNCTION of the threshold whose steps sit exactly at the achievable score
 * values — the Farey fractions s/d for 1 <= s <= d <= topN. Any threshold
 * inside a gap between two steps produces a byte-identical run.
 *
 * Sweeping {0} union those values is therefore EXHAUSTIVE over the parameter's
 * achievable behaviours rather than a sample of them, which is a much stronger
 * statement than "I tried twenty values" — and a 0.05-step ruler would both
 * waste points and straddle steps. The grid is derived from the algebra below
 * and then CHECKED against the scores the retriever actually emits.
 *
 * ---------------------------------------------------------------------------
 * BOTH AXES ARE MONOTONE PER QUERY, WHICH IS WHY THIS IS A VERIFICATION AND
 * NOT A SEARCH
 *
 *   CAP. index.js:166 is slice(0, min(k, cap)), so the list at cap c is a
 *   PREFIX of the list at any larger cap. DCG@k, R@k, P@k (which divides by k,
 *   §9.1, not by the number returned) and MRR@10 are all sums or first-hits
 *   over a prefix, so every one of them is monotone NON-DECREASING in the cap,
 *   for each individual query.
 *
 *   THRESHOLD. Candidates surviving t1 score > t1; the extra candidates
 *   admitted by lowering to t0 < t1 score <= t1. Since ordering is by
 *   descending score, the extras sort strictly BELOW every survivor, so
 *   lowering the threshold APPENDS TO THE TAIL and never reorders. Same four
 *   metrics, monotone NON-INCREASING in the threshold, per query.
 *
 * Two consequences, and the second is the reason this file argues the point at
 * this length:
 *
 *   1. A non-monotone grid point is a BUG in the runner or the retriever, not a
 *      discovery. Phase 4 below turns that into an assertion over all pairs.
 *   2. The argmax is forced by an argument that holds on EVERY sample — every
 *      subset of dev, every half, test, another corpus. So the usual
 *      max-of-N optimism, which is what makes "best of 342 configurations" a
 *      dishonest number, is structurally absent here. It is measured anyway in
 *      phase 6 rather than asserted.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS WRITTEN AND WHAT IS IGNORED — the §8.5 extension
 *
 * §8.5's rule is that evidence ABOUT the harness is committed and output FROM
 * it is not, with run sidecars committed on the grounds that "the provenance
 * does not regenerate". A sweep breaks that second premise in one direction:
 * the grid is committed code, and all 342 points share one set of
 * SHA-256-pinned inputs, one environment and one git commit, so per-point
 * provenance DOES regenerate. What does not regenerate is sweep-level.
 *
 * So the committed unit moves up a level, and the boundary becomes: a NAMED
 * configuration gets a sidecar in results/runs/; a GRID POINT gets a row in a
 * CSV. Grid runs land in results/sweeps/runs/, which is gitignored in full.
 * The rule is unchanged in spirit — commit the part that does not regenerate,
 * at the granularity at which it does not regenerate.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { index, search } = require('../retrieval');
const { paramsDigest } = require('../retrieval/types');
const v1 = require('../retrieval/v1-overlap');
const metrics = require('../eval/metrics');
const { mulberry32 } = require('../eval/bootstrap');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SITE = 'cooking';
const SPLIT = 'dev';
const RETRIEVER = 'v1-overlap';
const KS = [1, 5, 8, 10];
const SWEEP_DIR = path.join(REPO_ROOT, 'results', 'sweeps');
const RUN_DIR = path.join(SWEEP_DIR, 'runs');
const RUN_DIR_REL = 'results/sweeps/runs';

/**
 * THE SELECTION RULE, DECLARED BEFORE THE GRID RUNS.
 *
 * Written here, in the same commit as the grid, for the reason §11.5 gives for
 * the registry: a rule chosen after the numbers are visible is not a rule. The
 * primary metric is the registry's own — nDCG@8.
 *
 * The two tie-breaks exist because the plateau is expected, not hypothetical:
 * every threshold below the smallest achievable score behaves identically, and
 * every cap at or above the reporting depth behaves identically.
 *
 *   1. argmax nDCG@8.
 *   2. Among EXACT ties, argmax nDCG@10. This is the same mechanical-rather-
 *      than-observed reasoning the registry already accepted for the cap
 *      ablation's k=10 override: the cap acts at ranks 9 and 10, so nDCG@8
 *      cannot see it by construction. Reaching for @10 after seeing a null at
 *      @8 would be metric-shopping; declaring it in advance as a tie-break is
 *      not.
 *   3. Among still-exact ties, PREFER THE SHIPPED VALUE. A tie is not a reason
 *      to change what is deployed.
 */
const SELECTION = {
  primary: { metric: 'ndcg', k: 8 },
  tieBreak: { metric: 'ndcg', k: 10 },
  thenPrefer: 'the shipped value',
  shipped: { threshold: 0.15, cap: 8 }
};

/** Different purpose, different stream — 1.4 used 20260803, 2.5 uses 20260804. */
const SPLIT_HALF_SEED = 20260806;
const SPLIT_HALF_REPEATS = 200;

// ---------------------------------------------------------------------------
// Small shared helpers. These duplicate run-eval.js and compare-runs.js rather
// than importing them, for the reason compare-runs.js already records: those
// files are part of 2.2's and 2.4's evidence chains, and refactoring them to
// serve a new caller means the validated artifact and the audited artifact stop
// being the same bytes. The duplication is CHECKED, not assumed — phase 3
// asserts every re-derived aggregate against the point's own sidecar at exact
// float equality.
// ---------------------------------------------------------------------------

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadQrels(file) {
  const byQuery = new Map();
  for (const line of readLines(file)) {
    if (line === '') continue;
    const [qid, , docId, gradeText] = line.split(/\s+/);
    let row = byQuery.get(qid);
    if (!row) { row = new Map(); byQuery.set(qid, row); }
    row.set(docId, Number.parseInt(gradeText, 10));
  }
  return byQuery;
}

/** run file -> Map<qid, docid[]>, ordered by the RANK column (§ compare-runs). */
function loadRun(file) {
  const byQuery = new Map();
  for (const line of readLines(file)) {
    if (line === '') continue;
    const [qid, , docId, rankText] = line.split(/\s+/);
    let rows = byQuery.get(qid);
    if (!rows) { rows = []; byQuery.set(qid, rows); }
    rows.push({ docId, rank: Number.parseInt(rankText, 10) });
  }
  for (const [qid, rows] of byQuery) {
    rows.sort((x, y) => x.rank - y.rank);
    byQuery.set(qid, rows.map((r) => r.docId));
  }
  return byQuery;
}

function fail(message) {
  const error = new Error(message);
  error.assertion = true;
  throw error;
}

const fmt = (v, d = 4) => (v === null || v === undefined ? '—' : v.toFixed(d));

// ---------------------------------------------------------------------------
// Phase 1 — the grid
// ---------------------------------------------------------------------------

/**
 * Every threshold that produces a distinct run, derived from the score algebra.
 *
 * `strength` can only ever be Number((s/d).toFixed(precision)) for
 * 1 <= s <= d <= topN. Between two consecutive achievable values the kept set
 * is constant, so those values ARE the grid. 0 is prepended as the "no
 * threshold at all" point, below the smallest achievable score.
 */
function thresholdLattice(topN, precision) {
  const values = new Set([0]);
  for (let d = 1; d <= topN; d += 1) {
    for (let s = 1; s <= d; s += 1) values.add(Number((s / d).toFixed(precision)));
  }
  return [...values].sort((a, b) => a - b);
}

function pointLabel(threshold, cap) {
  return `sw-t${threshold.toFixed(4)}-c${cap === null ? 'null' : cap}`;
}

// ---------------------------------------------------------------------------
// Phase 2 — keyword-list lengths, which is what the threshold interacts with
// ---------------------------------------------------------------------------

/**
 * `> 0.15` IS NOT ONE RULE (§7.7). strength = shared/d with d the QUERY's
 * keyword count, so the number of shared words a threshold demands depends on
 * d: Number((1/d).toFixed(4)) > 0.15 holds for d <= 6, and a six-keyword note
 * therefore links on a SINGLE shared word where a ten-keyword note needs two.
 *
 * A scalar sweep averages those regimes into one curve. This measures HOW MUCH
 * of the corpus sits in each, so the averaging is quantified rather than
 * described — and so the answer can be "real in principle, negligible here" if
 * that is what the corpus says.
 */
function wordsRequired(threshold, d) {
  for (let s = 1; s <= d; s += 1) {
    if (Number((s / d).toFixed(4)) > threshold) return s;
  }
  return null; // no number of shared words clears this threshold at this length
}

function keywordLengthProfile(handle, docs, queryIds) {
  const lengthOf = new Map();
  for (const doc of docs) lengthOf.set(doc.id, v1.keywordsFor(handle._state, doc.id).length);

  const tally = (ids) => {
    const hist = new Map();
    for (const id of ids) {
      const d = lengthOf.get(id);
      hist.set(d, (hist.get(d) || 0) + 1);
    }
    return hist;
  };

  return {
    lengthOf,
    corpus: tally(docs.map((d) => d.id)),
    dev: tally(queryIds)
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — run the grid through run-eval.js
// ---------------------------------------------------------------------------

/**
 * Every point goes through the SAME runner that produced the §12 baseline.
 *
 * That costs a redundant load + index() per point — threshold is applied in
 * rank() and cap in search(), so neither touches the index, and all 342 points
 * build an identical one. Roughly 1.65 s of each point's ~2.9 s is therefore
 * rebuilt work.
 *
 * Paid deliberately. The alternative — index once and re-implement the filter
 * and the cut here — is a SECOND implementation of the thing being measured,
 * outside the ten pre-search assertions, the input-hash checks and the
 * post-conditions on the written bytes. A sweep that quietly scores itself with
 * different code than the baseline it is compared against is exactly the
 * unattributable result CLAUDE.md forbids. Nine minutes is a cheap price.
 */
function runPoint(point, opts) {
  const runFile = path.join(RUN_DIR, `${point.label}.${SPLIT}.run`);
  const sidecarFile = `${runFile}.json`;

  if (!opts.fresh && fs.existsSync(sidecarFile) && fs.existsSync(runFile)) {
    const cached = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    // The digest is over {version, params}, so a cache hit means the cached run
    // was produced by the configuration this point names — not merely by
    // something that once had the same label.
    if (cached.retriever && cached.retriever.digest === point.digest) {
      return { sidecar: cached, cached: true };
    }
  }

  const args = [
    'scripts/run-eval.js',
    '--retriever', RETRIEVER,
    '--split', SPLIT,
    '--param', `threshold=${JSON.stringify(point.threshold)}`,
    '--param', `cap=${JSON.stringify(point.cap)}`,
    '--label', point.label,
    '--outdir', RUN_DIR_REL
  ];
  execFileSync(process.execPath, args, { cwd: path.join(REPO_ROOT, 'backend'), stdio: 'pipe' });

  const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
  if (sidecar.retriever.digest !== point.digest) {
    fail(
      `${point.label}: the runner produced digest ${sidecar.retriever.digest.slice(0, 8)},\n` +
      `  this script expected ${point.digest.slice(0, 8)}. The grid and the runner disagree\n` +
      `  about what configuration this point is, so the CSV row would misname its own run.`
    );
  }
  return { sidecar, cached: false };
}

// ---------------------------------------------------------------------------
// Phase 4 — monotonicity, asserted over every comparable pair
// ---------------------------------------------------------------------------

/**
 * The proof in the header banks on two claims about the ordering. Both are
 * checked here on the real grid rather than trusted, because a violation would
 * mean the prefix argument is false — which would be a defect in
 * retrieval/index.js's sort or truncation, and would invalidate the selection
 * bias argument that rests on it.
 */
function checkMonotone(rows, thresholds, caps) {
  const key = (t, c) => `${t}|${c}`;
  const by = new Map(rows.map((r) => [key(r.threshold, r.cap), r]));
  const columns = [['ndcg', 1], ['ndcg', 5], ['ndcg', 8], ['ndcg', 10],
    ['p', 8], ['r', 8], ['mrr', null]];
  const read = (row, [m, k]) => (m === 'mrr' ? row.mrr : row[m][k]);
  const violations = [];
  let compared = 0;

  // Non-decreasing in the cap, at fixed threshold.
  for (const t of thresholds) {
    for (let i = 1; i < caps.length; i += 1) {
      const lo = by.get(key(t, caps[i - 1]));
      const hi = by.get(key(t, caps[i]));
      if (!lo || !hi) continue;
      for (const col of columns) {
        compared += 1;
        if (read(hi, col) + 1e-12 < read(lo, col)) {
          violations.push(`cap ${caps[i - 1]}->${caps[i]} at threshold ${t}: ` +
            `${col[0]}@${col[1]} ${fmt(read(lo, col), 6)} -> ${fmt(read(hi, col), 6)}`);
        }
      }
    }
  }

  // Non-increasing in the threshold, at fixed cap.
  for (const c of caps) {
    for (let i = 1; i < thresholds.length; i += 1) {
      const lo = by.get(key(thresholds[i - 1], c));
      const hi = by.get(key(thresholds[i], c));
      if (!lo || !hi) continue;
      for (const col of columns) {
        compared += 1;
        if (read(hi, col) > read(lo, col) + 1e-12) {
          violations.push(`threshold ${thresholds[i - 1]}->${thresholds[i]} at cap ${c}: ` +
            `${col[0]}@${col[1]} ${fmt(read(lo, col), 6)} -> ${fmt(read(hi, col), 6)}`);
        }
      }
    }
  }

  return { compared, violations };
}

// ---------------------------------------------------------------------------
// Phase 5 — selection, by the rule declared at the top
// ---------------------------------------------------------------------------

function selectPoint(rows) {
  const primary = (r) => r[SELECTION.primary.metric][SELECTION.primary.k];
  const secondary = (r) => r[SELECTION.tieBreak.metric][SELECTION.tieBreak.k];

  const best = Math.max(...rows.map(primary));
  const plateau = rows.filter((r) => primary(r) === best);

  const bestSecondary = Math.max(...plateau.map(secondary));
  const plateau2 = plateau.filter((r) => secondary(r) === bestSecondary);

  // Rule 3: prefer the shipped value. Distance in "how many shipped values does
  // this point keep", then the smaller change on each axis.
  const shippedness = (r) =>
    (r.threshold === SELECTION.shipped.threshold ? 1 : 0) + (r.cap === SELECTION.shipped.cap ? 1 : 0);
  plateau2.sort((a, b) =>
    shippedness(b) - shippedness(a) ||
    Math.abs(a.threshold - SELECTION.shipped.threshold) - Math.abs(b.threshold - SELECTION.shipped.threshold) ||
    Math.abs((a.cap === null ? 99 : a.cap) - SELECTION.shipped.cap) -
      Math.abs((b.cap === null ? 99 : b.cap) - SELECTION.shipped.cap));

  return { selected: plateau2[0], plateau, plateau2, best };
}

// ---------------------------------------------------------------------------
// Phase 6 — per-query scores, stratification, and the optimism estimate
// ---------------------------------------------------------------------------

/**
 * Re-derive per-query nDCG@8 for a grid point from its written run file,
 * through the module validated at 2.4 — the same route compare-runs.js takes,
 * and for the same reason: one source of truth, and the point's own committed
 * aggregate is what checks the re-derivation.
 */
function perQueryFor(point, queryIds, qrels) {
  const runFile = path.join(RUN_DIR, `${point.label}.${SPLIT}.run`);
  const run = loadRun(runFile);
  const perQuery = queryIds.map((qid) =>
    metrics.scoreQuery(run.get(qid) || [], qrels.get(qid) || new Map(), KS));
  return { perQuery, aggregate: metrics.aggregate(perQuery, KS) };
}

/**
 * SELECTION BIAS, MEASURED RATHER THAN ONLY NAMED.
 *
 * Reporting the best of N configurations by its dev score reports a maximum of
 * N noisy estimates, and its expectation exceeds the truth by an amount that
 * grows with N. At N = 342 that is not a footnote.
 *
 * The structural argument in the header says the argmax here carries none of
 * that, because it is forced per query rather than picked out of noise. This
 * measures the claim instead of resting on it: repeatedly split dev in half,
 * redo the FULL selection on half A, and report the margin the chosen point
 * earns on A against the margin the same point earns on the held-out half B.
 *
 *   optimism = mean over repeats of ( margin(A) - margin(B) )
 *
 * It stays entirely inside dev — test is opened once, at 3.6, and a
 * cross-validated optimism estimate is not a reason to open it early. What it
 * cannot see is stated in the report: it bounds SELECTION optimism, not the
 * difference between two samples of the corpus.
 */
function splitHalfOptimism(rows, vectors, shippedLabel, n, seed, repeats) {
  const rand = mulberry32(seed);
  const shipped = vectors.get(shippedLabel);
  const deltas = [];
  const chosen = new Map();

  const meanOver = (vec, idx) => {
    let sum = 0;
    for (const i of idx) sum += vec[i];
    return sum / idx.length;
  };

  for (let rep = 0; rep < repeats; rep += 1) {
    // Fisher-Yates over query indices, then cut in half.
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const a = order.slice(0, Math.floor(n / 2));
    const b = order.slice(Math.floor(n / 2));

    let bestRow = null;
    let bestA = -Infinity;
    for (const row of rows) {
      const m = meanOver(vectors.get(row.label), a);
      if (m > bestA + 1e-15) { bestA = m; bestRow = row; }
    }
    chosen.set(bestRow.label, (chosen.get(bestRow.label) || 0) + 1);

    const marginA = bestA - meanOver(shipped, a);
    const marginB = meanOver(vectors.get(bestRow.label), b) - meanOver(shipped, b);
    deltas.push(marginA - marginB);
  }

  deltas.sort((x, y) => x - y);
  return {
    repeats,
    seed,
    mean: deltas.reduce((s, d) => s + d, 0) / deltas.length,
    p5: deltas[Math.floor(0.05 * deltas.length)],
    p95: deltas[Math.floor(0.95 * deltas.length)],
    max: deltas[deltas.length - 1],
    chosen: [...chosen.entries()].sort((x, y) => y[1] - x[1])
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const fresh = process.argv.includes('--fresh');
  const t0 = Date.now();

  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${SITE}.jsonl`);
  const qrelsFile = path.join(REPO_ROOT, 'data', 'qrels', `${SITE}.qrels`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${SITE}.${SPLIT}.txt`);
  for (const file of [corpusFile, qrelsFile, splitFile]) {
    if (!fs.existsSync(file)) fail(`${path.relative(REPO_ROOT, file)} does not exist. See docs/EVALUATION.md §1.`);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const docs = readLines(corpusFile).map((l) => JSON.parse(l));
  const qrels = loadQrels(qrelsFile);
  const queryIds = readLines(splitFile);

  console.log(`sweep v1-overlap on ${SITE}.${SPLIT}`);
  console.log(`  ${docs.length} docs · ${queryIds.length} queries · runner results/runs -> ${RUN_DIR_REL}\n`);

  // --- phase 1: the grid ----------------------------------------------------
  const defaults = v1.defaultParams;
  const lattice = thresholdLattice(defaults.topN, defaults.scorePrecision);

  /**
   * THE SHIPPED 0.15 IS NOT A LATTICE POINT, and that is a finding rather than
   * an inconvenience.
   *
   * 0.15 = 3/20, and no s/d with d <= 10 equals it. The nearest achievable
   * scores either side are 1/7 = 0.1429 and 1/6 = 0.1667, so `> 0.15` keeps
   * exactly what `> 0.1429` keeps: the shipped constant is one arbitrary point
   * inside a behavioural plateau, not a distinguishable setting. It is added to
   * the grid explicitly so the CSV carries the deployed configuration as its own
   * row, and phase 3b then CHECKS the equivalence on the written bytes instead
   * of leaving it as arithmetic.
   */
  const shippedIsLatticePoint = lattice.includes(SELECTION.shipped.threshold);
  const thresholds = shippedIsLatticePoint
    ? lattice
    : [...lattice, SELECTION.shipped.threshold].sort((a, b) => a - b);
  const shippedEquivalent = [...lattice].reverse().find((t) => t < SELECTION.shipped.threshold);
  const caps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // cap: null is run only at the two thresholds that matter, as a degeneracy
  // CHECK rather than a column: run-eval.js calls search(handle, q, 10) and
  // index.js:166 is slice(0, min(k, cap)), so every cap >= 10 is byte-identical
  // to null. Running the whole column would be 33 duplicate runs asserting one
  // fact 33 times.
  const nullProbes = [SELECTION.shipped.threshold, 0];

  const points = [];
  for (const threshold of thresholds) {
    for (const cap of caps) points.push({ threshold, cap });
  }
  for (const threshold of nullProbes) points.push({ threshold, cap: null });
  for (const point of points) {
    point.label = pointLabel(point.threshold, point.cap);
    point.digest = paramsDigest(RETRIEVER, { ...defaults, threshold: point.threshold, cap: point.cap });
  }

  console.log(`  phase 1  grid: ${thresholds.length} thresholds x ${caps.length} caps + ${nullProbes.length} cap:null probes = ${points.length} points`);
  console.log(`           thresholds are the achievable score lattice s/d, 1<=s<=d<=${defaults.topN}:`);
  console.log(`           ${thresholds.map((t) => t.toFixed(4)).join(' ')}`);
  if (!shippedIsLatticePoint) {
    console.log(`           NOTE the shipped ${SELECTION.shipped.threshold} is NOT a lattice point — 3/20 is not s/d for any d<=${defaults.topN}.`);
    console.log(`           It sits between ${shippedEquivalent} (1/7) and the next value up, so it is one arbitrary`);
    console.log(`           point inside a plateau. Added to the grid explicitly; checked at phase 3b.`);
  }
  console.log('');

  // --- phase 2: keyword lengths --------------------------------------------
  const tIndex = Date.now();
  const handle = index(RETRIEVER, docs, {});
  const profile = keywordLengthProfile(handle, docs, queryIds);
  console.log(`  phase 2  keyword-list lengths (index built in ${Date.now() - tIndex} ms)`);
  const devTotal = queryIds.length;
  const lengths = [...profile.corpus.keys()].sort((a, b) => a - b);
  for (const d of lengths) {
    const devN = profile.dev.get(d) || 0;
    console.log(`             d=${String(d).padStart(2)}  corpus ${String(profile.corpus.get(d)).padStart(6)}` +
      `  dev ${String(devN).padStart(5)} (${((devN / devTotal) * 100).toFixed(2)}%)` +
      `  words needed at 0.15: ${wordsRequired(0.15, d) ?? '—'}`);
  }
  const shortDev = lengths.filter((d) => d <= 6).reduce((s, d) => s + (profile.dev.get(d) || 0), 0);
  console.log(`           dev queries in the d<=6 "links on one shared word" regime: ${shortDev} (${((shortDev / devTotal) * 100).toFixed(2)}%)\n`);

  // Cross-check the derived lattice against the scores the retriever emits, so
  // the exhaustiveness claim is measured rather than argued from the algebra.
  const observed = new Set();
  for (const qid of queryIds) {
    for (const hit of search(handle, qid, 10)) observed.add(hit.score);
  }
  const latticeSet = new Set(lattice);
  const unexpected = [...observed].filter((s) => !latticeSet.has(s));
  if (unexpected.length > 0) {
    fail(`the retriever emitted ${unexpected.length} score(s) outside the derived lattice: ${unexpected.slice(0, 5).join(', ')}`);
  }
  console.log(`  phase 2b lattice check: ${observed.size} distinct scores observed at the shipped config, all in the derived lattice\n`);

  // --- phase 3: run the grid ------------------------------------------------
  console.log(`  phase 3  running ${points.length} points through scripts/run-eval.js`);
  const tGrid = Date.now();
  const rows = [];
  let cachedCount = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const { sidecar, cached } = runPoint(point, { fresh });
    if (cached) cachedCount += 1;
    rows.push({
      label: point.label,
      threshold: point.threshold,
      cap: point.cap,
      digest: point.digest,
      ndcg: sidecar.metrics.ndcg,
      p: sidecar.metrics.p,
      r: sidecar.metrics.r,
      mrr: sidecar.metrics.mrr,
      lines: sidecar.output.lines,
      zeroResult: sidecar.queries.zeroResult,
      runSha256: sidecar.output.sha256,
      p95Ms: sidecar.latencyMs.p95
    });
    if ((i + 1) % 25 === 0 || i === points.length - 1) {
      const secs = (Date.now() - tGrid) / 1000;
      console.log(`             ${String(i + 1).padStart(3)}/${points.length}  ${secs.toFixed(0)}s elapsed` +
        `  (${(secs / (i + 1)).toFixed(2)}s/point)`);
    }
  }
  const gridMs = Date.now() - tGrid;
  console.log(`           done in ${(gridMs / 1000).toFixed(1)}s${cachedCount ? ` (${cachedCount} cached)` : ''}\n`);

  // --- phase 3b: the shipped threshold's plateau, checked on written bytes ---
  // Arithmetic says `> 0.15` and `> 0.1429` keep the same set. This asserts it
  // on the run files themselves, which is the difference between a claim about
  // the algebra and a claim about the artifact. The DIGESTS differ (the params
  // differ, so the provenance must record that) while the RESULTS do not —
  // which is exactly the shape of "an arbitrary point inside a plateau".
  //
  // The comparison is over the first FIVE columns, not the whole line. Field 6
  // is the runid, `<label>.<split>.<digest8>`, and both halves of it differ by
  // construction — so a raw SHA-256 of the two files can never match and would
  // be a check that always fails for a reason unrelated to retrieval. What is
  // compared is `qid Q0 docid rank score`, which is the retrieval.
  const plateauCheck = [];
  const retrievalSha = (label) => {
    const body = readLines(path.join(RUN_DIR, `${label}.${SPLIT}.run`))
      .map((line) => line.split(' ').slice(0, 5).join(' ')).join('\n');
    return crypto.createHash('sha256').update(body).digest('hex');
  };
  if (!shippedIsLatticePoint) {
    for (const cap of caps) {
      const a = rows.find((r) => r.threshold === SELECTION.shipped.threshold && r.cap === cap);
      const b = rows.find((r) => r.threshold === shippedEquivalent && r.cap === cap);
      const shaA = retrievalSha(a.label);
      plateauCheck.push({ cap, identical: shaA === retrievalSha(b.label), retrievalSha256: shaA });
    }
    const allSame = plateauCheck.every((c) => c.identical);
    console.log(`  phase 3b shipped-threshold plateau: threshold ${SELECTION.shipped.threshold} vs ${shippedEquivalent}, ` +
      `retrieval columns byte-identical at ${plateauCheck.filter((c) => c.identical).length}/${caps.length} caps`);
    if (!allSame) fail('the shipped threshold does not reproduce its lattice neighbour — the lattice derivation is wrong');
    console.log(`           digests differ (params differ, so provenance records it); results do not.\n`);
  }

  // --- phase 4: monotonicity ------------------------------------------------
  const mono = checkMonotone(rows, thresholds, caps);
  console.log(`  phase 4  monotonicity: ${mono.compared} adjacent-pair comparisons, ${mono.violations.length} violations`);
  for (const v of mono.violations.slice(0, 10)) console.log(`           !! ${v}`);
  if (mono.violations.length > 0) {
    console.log(`           A violation means the prefix argument is false, which would be a defect in`);
    console.log(`           retrieval/index.js's sort or truncation — not a tuning discovery.`);
  }
  console.log('');

  // --- phase 5: selection ---------------------------------------------------
  const shippedRow = rows.find((r) => r.threshold === SELECTION.shipped.threshold && r.cap === SELECTION.shipped.cap);
  if (!shippedRow) fail('the shipped configuration is not in the grid');
  const { selected, plateau, plateau2 } = selectPoint(rows);

  console.log(`  phase 5  selection by the rule declared in this file before the grid ran`);
  console.log(`           primary ${SELECTION.primary.metric.toUpperCase()}@${SELECTION.primary.k}` +
    `, tie-break ${SELECTION.tieBreak.metric.toUpperCase()}@${SELECTION.tieBreak.k}, then prefer ${SELECTION.thenPrefer}`);
  console.log(`           shipped   threshold ${shippedRow.threshold} cap ${shippedRow.cap}` +
    `  nDCG@8 ${fmt(shippedRow.ndcg[8])}  nDCG@10 ${fmt(shippedRow.ndcg[10])}`);
  console.log(`           selected  threshold ${selected.threshold} cap ${selected.cap}` +
    `  nDCG@8 ${fmt(selected.ndcg[8])}  nDCG@10 ${fmt(selected.ndcg[10])}`);
  console.log(`           plateau at the primary metric: ${plateau.length} of ${rows.length} points; after the @10 tie-break: ${plateau2.length}`);
  console.log(`           margin    nDCG@8 ${(selected.ndcg[8] - shippedRow.ndcg[8]).toFixed(6)}` +
    `   nDCG@10 ${(selected.ndcg[10] - shippedRow.ndcg[10]).toFixed(6)}\n`);

  // --- phase 6: per-query, stratification, optimism -------------------------
  console.log(`  phase 6  re-deriving per-query nDCG@8 from ${rows.length} run files through eval/metrics.js`);
  const tPq = Date.now();
  const vectors = new Map();
  for (const row of rows) {
    const { perQuery, aggregate } = perQueryFor(row, queryIds, qrels);
    // The point's own sidecar aggregate is the check on the re-derivation, at
    // exact float equality — the guard compare-runs.js applies for the same
    // reason. A run file that has drifted from its sidecar fails here.
    if (aggregate.ndcg[8] !== row.ndcg[8] || aggregate.mrr !== row.mrr) {
      fail(`${row.label}: re-derived nDCG@8 ${aggregate.ndcg[8]} != sidecar ${row.ndcg[8]}`);
    }
    vectors.set(row.label, perQuery.map((q) => (q.ndcg[8] === null ? 0 : q.ndcg[8])));
    row.perQuery = perQuery;
  }
  console.log(`           ${((Date.now() - tPq) / 1000).toFixed(1)}s, all ${rows.length} aggregates match their sidecars at exact float equality\n`);

  // Stratified by the query's keyword-list length — the length-conditioned view
  // of a scalar sweep, as an ANALYSIS rather than as a reparameterization.
  const strata = [
    { name: 'd<=6  (links on 1 shared word at 0.15)', test: (d) => d <= 6 },
    { name: 'd>=7  (needs 2 shared words at 0.15)', test: (d) => d >= 7 }
  ];
  console.log('  phase 6b stratified by |query keywords|');
  const strataReport = [];
  for (const stratum of strata) {
    const idx = queryIds.map((q, i) => [q, i]).filter(([q]) => stratum.test(profile.lengthOf.get(q))).map(([, i]) => i);
    const row = { name: stratum.name, n: idx.length };
    for (const [tag, r] of [['shipped', shippedRow], ['selected', selected]]) {
      const sub = idx.map((i) => r.perQuery[i]);
      row[tag] = idx.length === 0 ? null : metrics.aggregate(sub, KS);
    }
    strataReport.push(row);
    console.log(`           ${stratum.name.padEnd(40)} n=${String(row.n).padStart(5)}` +
      (row.n === 0 ? '  —' :
        `  shipped nDCG@8 ${fmt(row.shipped.ndcg[8])}  selected ${fmt(row.selected.ndcg[8])}`));
  }
  console.log('');

  const optimism = splitHalfOptimism(rows, vectors, shippedRow.label, queryIds.length, SPLIT_HALF_SEED, SPLIT_HALF_REPEATS);
  console.log(`  phase 6c split-half optimism, ${optimism.repeats} repeats, seed ${optimism.seed}`);
  console.log(`           mean margin(A) - margin(B) = ${optimism.mean.toFixed(6)}` +
    `   [p5 ${optimism.p5.toFixed(6)}, p95 ${optimism.p95.toFixed(6)}]`);
  console.log(`           configuration chosen on half A: ` +
    optimism.chosen.slice(0, 3).map(([l, n]) => `${l} x${n}`).join(', '));
  console.log('');

  // --- write ----------------------------------------------------------------
  fs.mkdirSync(SWEEP_DIR, { recursive: true });
  const csvFile = path.join(SWEEP_DIR, 'v1-threshold.csv');
  const header = ['threshold', 'cap', 'wordsRequiredAtD10', 'label', 'digest8',
    ...KS.map((k) => `ndcg@${k}`), ...KS.map((k) => `p@${k}`), ...KS.map((k) => `r@${k}`),
    'mrr@10', 'runLines', 'zeroResultQueries', 'p95SearchMs'];
  const csvLines = [header.join(',')];
  for (const row of rows) {
    csvLines.push([
      row.threshold, row.cap === null ? 'null' : row.cap, wordsRequired(row.threshold, 10) ?? '',
      row.label, row.digest.slice(0, 8),
      ...KS.map((k) => row.ndcg[k].toFixed(6)),
      ...KS.map((k) => row.p[k].toFixed(6)),
      ...KS.map((k) => row.r[k].toFixed(6)),
      row.mrr.toFixed(6), row.lines, row.zeroResult, row.p95Ms.toFixed(6)
    ].join(','));
  }
  fs.writeFileSync(csvFile, `${csvLines.join('\n')}\n`);

  const manifest = {
    phase: '2.7',
    what: 'Sweep of v1-overlap threshold x cap on the dev split. One row per grid point in v1-threshold.csv.',
    gitignoreNote:
      'Per-point run files and sidecars live in results/sweeps/runs/ and are gitignored. ' +
      'EVALUATION.md §8.5 committed sidecars because per-run provenance does not regenerate; ' +
      'at grid scale it does — the grid is committed code and every point shares one set of ' +
      'pinned inputs, one environment and one commit — so the committed unit moves up to this ' +
      'sweep-level manifest. A named configuration gets a sidecar; a grid point gets a CSV row.',
    site: SITE,
    split: SPLIT,
    retriever: RETRIEVER,
    ksReported: KS,
    heldFixed: Object.fromEntries(Object.entries(defaults).filter(([k]) => k !== 'threshold' && k !== 'cap')),
    grid: {
      thresholds,
      thresholdsAre: `the achievable score lattice Number((s/d).toFixed(${defaults.scorePrecision})) for 1<=s<=d<=${defaults.topN}, plus 0`,
      shippedThresholdIsLatticePoint: shippedIsLatticePoint,
      shippedThresholdNote: shippedIsLatticePoint ? null :
        `${SELECTION.shipped.threshold} = 3/20 is not s/d for any d <= ${defaults.topN}, so it is not an achievable score and not a ` +
        `distinguishable setting. It behaves exactly as ${shippedEquivalent} (1/7) does — verified byte-identical on the run files at ` +
        `every cap. It is added to the grid explicitly so the CSV carries the deployed configuration as a row.`,
      shippedThresholdPlateauCheck: plateauCheck,
      caps,
      capNullProbes: nullProbes,
      capNullNote: 'run-eval.js searches at k=10 and index.js:166 is slice(0, min(k, cap)), so every cap >= 10 is byte-identical to null',
      points: points.length
    },
    selectionRule: SELECTION,
    inputs: [
      { name: 'corpus', file: path.relative(REPO_ROOT, corpusFile), sha256: sha256File(corpusFile) },
      { name: 'qrels', file: path.relative(REPO_ROOT, qrelsFile), sha256: sha256File(qrelsFile) },
      { name: 'split', file: path.relative(REPO_ROOT, splitFile), sha256: sha256File(splitFile) }
    ],
    shipped: { threshold: shippedRow.threshold, cap: shippedRow.cap, label: shippedRow.label, metrics: { ndcg: shippedRow.ndcg, p: shippedRow.p, r: shippedRow.r, mrr: shippedRow.mrr } },
    selected: { threshold: selected.threshold, cap: selected.cap, label: selected.label, digest: selected.digest, metrics: { ndcg: selected.ndcg, p: selected.p, r: selected.r, mrr: selected.mrr } },
    plateauSize: { atPrimary: plateau.length, afterTieBreak: plateau2.length, ofPoints: rows.length },
    margin: {
      'ndcg@8': selected.ndcg[8] - shippedRow.ndcg[8],
      'ndcg@10': selected.ndcg[10] - shippedRow.ndcg[10],
      note: 'A SELECTION margin on dev, not a result. The registered tuned-vs-shipped comparison is on test, at 3.6.'
    },
    monotonicity: mono,
    keywordLengths: {
      corpus: Object.fromEntries([...profile.corpus.entries()].sort((a, b) => a[0] - b[0])),
      dev: Object.fromEntries([...profile.dev.entries()].sort((a, b) => a[0] - b[0])),
      devShortRegime: shortDev
    },
    strata: strataReport.map((s) => ({
      name: s.name, n: s.n,
      shipped: s.shipped ? { ndcg: s.shipped.ndcg, mrr: s.shipped.mrr } : null,
      selected: s.selected ? { ndcg: s.selected.ndcg, mrr: s.selected.mrr } : null
    })),
    optimism,
    perPointDigests: rows.map((r) => ({ label: r.label, threshold: r.threshold, cap: r.cap, digest: r.digest, runSha256: r.runSha256 })),
    timingsMs: { grid: gridMs, total: Date.now() - t0 },
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu: os.cpus()[0] ? os.cpus()[0].model : null,
      totalMemMiB: Math.round(os.totalmem() / 1048576)
    },
    git: (() => {
      try {
        const run = (a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
        return { commit: run(['rev-parse', 'HEAD']), dirty: run(['status', '--porcelain', '--untracked-files=no']) !== '' };
      } catch { return { commit: null, dirty: null }; }
    })(),
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(SWEEP_DIR, 'v1-sweep.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`  written  ${path.relative(REPO_ROOT, csvFile)} (${rows.length} rows)`);
  console.log(`           results/sweeps/v1-sweep.manifest.json`);
  console.log(`  total    ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

try {
  main();
} catch (err) {
  console.error(`\nsweep failed: ${err.message}`);
  if (!err.assertion) console.error(err.stack);
  process.exit(1);
}
