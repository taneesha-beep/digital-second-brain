'use strict';

/**
 * sweep-v4.js — Phase 3.3. The k1 x b grid for v4-bm25 on dev.
 *
 *   cd backend && npm run sweep:v4          # reuses cached points
 *   cd backend && npm run sweep:v4 -- --fresh
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SWEEP IS *NOT*, AND THE DIFFERENCE IS THE WHOLE DESIGN.
 *
 * 2.7's sweep was a VERIFICATION. §13.2 derived that the threshold grid IS the
 * achievable score lattice, so the grid was exhaustive over the parameter's
 * behaviours rather than a sample of them; and §13.4 proved both axes monotone
 * PER QUERY, so the argmax was forced by an argument holding on every subset of
 * dev. That is what made §13.7's max-of-N optimism structurally ~0 and the
 * split-half estimate a formality that confirmed it.
 *
 * NONE OF THAT TRANSFERS. k1 and b are continuous with a genuine INTERIOR
 * optimum, and they INTERACT — the length normalisation changes what saturation
 * has left to do. So:
 *
 *   - This grid is a SAMPLE of a continuous space, stated as one everywhere.
 *   - There is no monotonicity to assert, so there is no checkMonotone phase.
 *     Its absence is deliberate; a monotonicity check that passed here would be
 *     measuring the sample's coarseness, not the parameter.
 *   - The selected point is a maximum of 108 noisy estimates and the max-of-N
 *     optimism is REAL. §13.7's split-half estimate therefore stops being a
 *     formality and becomes the actual evidence. Whatever it says is reported.
 * ─────────────────────────────────────────────────────────────────────────
 * THE SELECTION RULE, DECLARED BEFORE THE GRID RUNS.
 *
 * Written here, in the same commit as the grid, for §11.5's reason: a rule
 * chosen after the numbers are visible is not a rule. sweep-v1.js set the
 * precedent and this follows it exactly.
 *
 *   1. argmax nDCG@8 — the registry's own primary metric.
 *   2. Among EXACT ties, argmax nDCG@10. Declared in advance as a tie-break,
 *      which is what separates it from the metric-shopping §11.5 forbids.
 *   3. Among still-exact ties, PREFER THE DEFAULT (k1 = 1.2, b = 0.75). The
 *      analogue of 2.7's "prefer the shipped value": a tie is not a reason to
 *      leave the textbook.
 *   4. Among still-exact ties, the smaller |k1 - 1.2|, then the smaller
 *      |b - 0.75|. A continuous score makes an exact tie improbable rather than
 *      impossible, and an improbable case with no declared rule is how a
 *      selection stops being reproducible.
 *
 * AND THE PART THAT IS EASIEST TO LEAVE UNSAID, SO IT IS SAID FIRST:
 *
 *   THE SELECTED POINT DOES NOT BECOME v4-bm25.
 *
 * The rung ships at the defaults. §14.2 ruled that "a swept v2 measured against
 * an unswept v1 is not the registered experiment", and §11.5 put
 * sweep-tuned-vs-shipped on TEST because "sweeps select; they do not test". v3
 * was never swept, so registering a tuned BM25 against it would price a
 * 108-point dev search that the bootstrap resampling the same 2,304 queries
 * cannot see. The winner ships as v4-bm25-tuned, EXPLORATORY, p suppressed by
 * compare-runs.js because the pair is not in the registry — and registry.json
 * is NOT edited this session. An eighth entry would retroactively tighten Holm
 * from alpha/7 = 0.00714 to alpha/8 = 0.00625 for every comparison already run.
 * ─────────────────────────────────────────────────────────────────────────
 * THE RE-INDEX 3.3 BUDGETED FOR, AND WHY IT IS NOT BUILT.
 *
 * Roadmap 3.3 inherits from 2.7 the claim that "k1 and b both change the index,
 * so unlike 2.7's threshold and cap they cannot reuse a cached one", and asks
 * for ~30 lines of runner mode that indexes once and iterates post-index params.
 *
 * The claim is false for a standard BM25 and v4-bm25.js is built so that it
 * stays false: postings hold RAW tf, lengths are b-independent, and buildIndex()
 * never reads k1 or b. tests/retrieval.v4-bm25.test.js indexes at (1.2, 0.75)
 * and (2.5, 0.1) and asserts every persistent structure is identical.
 *
 * Given that, the runner mode buys only time — and much less of it than 2.7
 * expected. §13.10 measured a per-point re-index at 1.65 s of each 2.89 s point
 * (57%). Here index() is ~1.0 s against a ~11 s search, so it is under 10%. So
 * every point goes through scripts/run-eval.js unchanged, exactly as 2.7's did,
 * and for 2.7's better reason: a sweep that scores itself with different code
 * than the runs it is compared against is the unattributable result CLAUDE.md
 * forbids. The saving was never the point; the property was, and a test carries
 * it more cheaply than an optimisation.
 * ─────────────────────────────────────────────────────────────────────────
 * LABELS. 3.2's noticed-list: ablation labels encode params
 * (v3-tfidf-top10-minshared2) and k1/b are CONTINUOUS, so the scheme breaks
 * here. The resolution is a split rather than a replacement:
 *
 *   a run CITED IN PROSE gets a descriptive label   v4-bm25-b0, v4-bm25-tuned
 *   a GRID POINT gets an index                      v4-p001 ... v4-p108
 *
 * The params live in the CSV and the manifest, which is where §13.9 already put
 * them. Encoding 0.30000000000000004 in a filename was the failure mode; making
 * the eight cited runs unreadable would have been a different one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { index } = require('../retrieval');
const { paramsDigest } = require('../retrieval/types');
const v4 = require('../retrieval/v4-bm25');
const metrics = require('../eval/metrics');
const { mulberry32 } = require('../eval/bootstrap');
const { readLines, sha256File, loadQrels, loadRun } = require('./lib/run-io');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SITE = 'cooking';
const SPLIT = 'dev';
const RETRIEVER = 'v4-bm25';
const KS = [1, 5, 8, 10];
const SWEEP_DIR = path.join(REPO_ROOT, 'results', 'sweeps');
const RUN_DIR = path.join(SWEEP_DIR, 'runs');
const RUN_DIR_REL = 'results/sweeps/runs';

/**
 * THE GRID. A sample, not a lattice — see the header.
 *
 *   k1 = 0     tf(k1+1)/(tf+0) = 1. Binary tf; term frequency discarded. The
 *              endpoint, included so the axis has one.
 *   k1 -> inf  tf/(1 - b + b|D|/avgdl). Linear tf, saturation off. Not on the
 *              grid — it is a named run (v4-bm25-k1big) because it is a chain
 *              step, and putting an unreachable limit on a grid of reachable
 *              values would misdescribe the axis.
 *   b = 0      no length normalisation at all.
 *   b = 1      full.
 *
 * 9 x 12 = 108 points.
 *
 * b = 0.75 IS ON THE GRID DELIBERATELY AND BREAKS THE EVEN SPACING. A clean
 * 0, 0.1, ... 1.0 ruler does not contain the default, so every "what did tuning
 * buy" margin would be measured against a configuration that is not a row —
 * either quoted from the separately-run v4-bm25 (a different process, so a
 * different set of rounding-free-but-not-identical conditions) or silently
 * approximated by b = 0.7. 2.7 hit the same shape from the other side and
 * solved it the same way: §13.2 added the shipped 0.15 to the lattice
 * explicitly even though it is not an achievable score. The guard in phase 1
 * fails the run if the default is absent, which is how this was caught.
 */
const K1_VALUES = [0, 0.3, 0.6, 0.9, 1.2, 1.6, 2.0, 2.5, 3.0];
const B_VALUES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0];

const SELECTION = {
  primary: { metric: 'ndcg', k: 8 },
  tieBreak: { metric: 'ndcg', k: 10 },
  thenPrefer: 'the textbook default',
  default: { k1: 1.2, b: 0.75 },
  selectedDoesNotShip:
    'The selected point ships as v4-bm25-tuned, EXPLORATORY. v4-bm25 is the default ' +
    'configuration and is what registry.json ladder-v3-v4 names. Declared before the grid ran.'
};

/** 1.4 used 20260803, 2.5 uses 20260804, 2.7 used 20260806. Different purpose, different stream. */
const SPLIT_HALF_SEED = 20260808;
const SPLIT_HALF_REPEATS = 200;

const fmt = (v, d = 4) => (v === null || v === undefined ? '—' : v.toFixed(d));

function fail(message) {
  const error = new Error(message);
  error.assertion = true;
  throw error;
}

function pointLabel(i) {
  return `v4-p${String(i + 1).padStart(3, '0')}`;
}

/** Every point goes through the same runner that produced the named runs. */
function runPoint(point, opts) {
  const runFile = path.join(RUN_DIR, `${point.label}.${SPLIT}.run`);
  const sidecarFile = `${runFile}.json`;

  if (!opts.fresh && fs.existsSync(sidecarFile) && fs.existsSync(runFile)) {
    const cached = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    // The digest is over {version, params}, so a cache hit means this run was
    // produced by the configuration the point names — not by something that
    // once carried the same label.
    if (cached.retriever && cached.retriever.digest === point.digest) {
      return { sidecar: cached, cached: true };
    }
  }

  execFileSync(process.execPath, [
    'scripts/run-eval.js',
    '--retriever', RETRIEVER,
    '--split', SPLIT,
    '--param', `k1=${JSON.stringify(point.k1)}`,
    '--param', `b=${JSON.stringify(point.b)}`,
    '--label', point.label,
    '--outdir', RUN_DIR_REL
  ], { cwd: path.join(REPO_ROOT, 'backend'), stdio: 'pipe' });

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

function selectPoint(rows) {
  const primary = (r) => r[SELECTION.primary.metric][SELECTION.primary.k];
  const secondary = (r) => r[SELECTION.tieBreak.metric][SELECTION.tieBreak.k];

  const best = Math.max(...rows.map(primary));
  const plateau = rows.filter((r) => primary(r) === best);

  const bestSecondary = Math.max(...plateau.map(secondary));
  const plateau2 = plateau.filter((r) => secondary(r) === bestSecondary);

  const defaultness = (r) =>
    (r.k1 === SELECTION.default.k1 ? 1 : 0) + (r.b === SELECTION.default.b ? 1 : 0);
  plateau2.sort((a, c) =>
    defaultness(c) - defaultness(a) ||
    Math.abs(a.k1 - SELECTION.default.k1) - Math.abs(c.k1 - SELECTION.default.k1) ||
    Math.abs(a.b - SELECTION.default.b) - Math.abs(c.b - SELECTION.default.b));

  return { selected: plateau2[0], plateau, plateau2, best };
}

function perQueryFor(point, queryIds, qrels) {
  const run = loadRun(path.join(RUN_DIR, `${point.label}.${SPLIT}.run`));
  const perQuery = queryIds.map((qid) =>
    metrics.scoreQuery(run.get(qid) || [], qrels.get(qid) || new Map(), KS));
  return { perQuery, aggregate: metrics.aggregate(perQuery, KS) };
}

/**
 * SELECTION BIAS. §13.7's estimator, unchanged in mechanism and changed in
 * status: there it measured a claim the monotonicity argument had already made,
 * and here it IS the claim. Repeatedly split dev in half, redo the FULL 108-point
 * selection on half A, and compare the margin the chosen point earns on A
 * against the margin the same point earns on held-out half B.
 *
 *   optimism = mean over repeats of ( margin(A) - margin(B) )
 *
 * The baseline is the DEFAULT configuration, since the margin being estimated is
 * "what tuning bought over the textbook". It stays entirely inside dev; test is
 * opened once, at 3.6, and a cross-validated optimism estimate is not a reason
 * to open it early. It bounds SELECTION optimism only — not the difference
 * between two samples of this corpus.
 */
function splitHalfOptimism(rows, vectors, baselineLabel, n, seed, repeats) {
  const rand = mulberry32(seed);
  const baseline = vectors.get(baselineLabel);
  const deltas = [];
  const chosen = new Map();

  const meanOver = (vec, idx) => {
    let sum = 0;
    for (const i of idx) sum += vec[i];
    return sum / idx.length;
  };

  for (let rep = 0; rep < repeats; rep += 1) {
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
    chosen.set(`k1=${bestRow.k1} b=${bestRow.b}`, (chosen.get(`k1=${bestRow.k1} b=${bestRow.b}`) || 0) + 1);

    const marginA = bestA - meanOver(baseline, a);
    const marginB = meanOver(vectors.get(bestRow.label), b) - meanOver(baseline, b);
    deltas.push(marginA - marginB);
  }

  deltas.sort((x, y) => x - y);
  return {
    repeats,
    seed,
    baseline: baselineLabel,
    mean: deltas.reduce((s, d) => s + d, 0) / deltas.length,
    p5: deltas[Math.floor(0.05 * deltas.length)],
    p95: deltas[Math.floor(0.95 * deltas.length)],
    max: deltas[deltas.length - 1],
    distinctChosen: chosen.size,
    chosen: [...chosen.entries()].sort((x, y) => y[1] - x[1])
  };
}

// ---------------------------------------------------------------------------

function main() {
  const fresh = process.argv.includes('--fresh');
  const t0 = Date.now();

  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${SITE}.jsonl`);
  const qrelsFile = path.join(REPO_ROOT, 'data', 'qrels', `${SITE}.qrels`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${SITE}.${SPLIT}.txt`);
  for (const file of [corpusFile, qrelsFile, splitFile]) {
    if (!fs.existsSync(file)) fail(`${path.relative(REPO_ROOT, file)} does not exist — see EVALUATION.md §1.`);
  }

  const docs = readLines(corpusFile).map((line) => JSON.parse(line));
  const qrels = loadQrels(qrelsFile);
  const queryIds = readLines(splitFile);

  console.log(`sweep v4-bm25 k1 x b on ${SITE}.${SPLIT}`);
  console.log(`  ${docs.length} docs · ${queryIds.length} queries\n`);

  // --- phase 1: the grid ----------------------------------------------------
  const defaults = v4.defaultParams;
  const points = [];
  for (const k1 of K1_VALUES) {
    for (const b of B_VALUES) {
      const params = { ...defaults, k1, b };
      points.push({
        label: pointLabel(points.length),
        k1,
        b,
        digest: paramsDigest(RETRIEVER, params)
      });
    }
  }
  console.log(`  phase 1  ${K1_VALUES.length} k1 x ${B_VALUES.length} b = ${points.length} points`);
  console.log(`           k1 ${K1_VALUES.join(', ')}`);
  console.log(`           b  ${B_VALUES.join(', ')}`);
  console.log(`           A SAMPLE of a continuous space, not a lattice. §13.2's exhaustiveness`);
  console.log(`           argument does not transfer and no monotonicity is asserted.`);
  const defaultPoint = points.find((p) => p.k1 === SELECTION.default.k1 && p.b === SELECTION.default.b);
  if (!defaultPoint) fail('the default configuration is not on the grid');
  console.log(`           the default (k1 ${SELECTION.default.k1}, b ${SELECTION.default.b}) is on the grid: ${defaultPoint.label}\n`);

  // --- phase 2: k1 and b do not touch the index -----------------------------
  // Asserted here, on the real corpus, and not only on the fixture in the test
  // suite — because the whole sweep design rests on the roadmap's claim being
  // wrong, and 27,325 documents is where it would matter if it were not.
  const tIndex = Date.now();
  const hA = index(RETRIEVER, docs, { k1: 1.2, b: 0.75 });
  const indexMs = Date.now() - tIndex;
  const hB = index(RETRIEVER, docs, { k1: 3.0, b: 0.0 });
  const sameStructures =
    hA._state.avgdl === hB._state.avgdl &&
    hA._state.vocabularySize === hB._state.vocabularySize &&
    hA._state.idf.every((v, i) => v === hB._state.idf[i]) &&
    hA._state.lengths.every((v, i) => v === hB._state.lengths[i]) &&
    hA._state.postingsTfs.every((p, t) => p.every((v, i) => v === hB._state.postingsTfs[t][i]));
  if (!sameStructures) {
    fail('k1/b changed the index at corpus scale — the sweep design and EVALUATION.md §16 are both wrong');
  }
  console.log(`  phase 2  k1/b do not touch the index: every structure identical at (1.2,0.75) vs (3.0,0.0)`);
  console.log(`           index() ${indexMs} ms · |V| ${hA._state.vocabularySize} · avgdl ${hA._state.avgdl.toFixed(3)}`);
  console.log(`           idf range [${hA._state.idfRange[0].toFixed(4)}, ${hA._state.idfRange[1].toFixed(4)}] · non-positive idf terms ${hA._state.nonPositiveIdfTerms}\n`);

  // --- phase 3: run the grid ------------------------------------------------
  console.log(`  phase 3  running ${points.length} points through scripts/run-eval.js`);
  const tGrid = Date.now();
  const rows = [];
  let cachedCount = 0;
  for (let i = 0; i < points.length; i += 1) {
    const { sidecar, cached } = runPoint(points[i], { fresh });
    if (cached) cachedCount += 1;
    rows.push({
      label: points[i].label,
      k1: points[i].k1,
      b: points[i].b,
      digest: points[i].digest,
      ndcg: sidecar.metrics.ndcg,
      p: sidecar.metrics.p,
      r: sidecar.metrics.r,
      mrr: sidecar.metrics.mrr,
      lines: sidecar.output.lines,
      zeroResult: sidecar.queries.zeroResult,
      runSha256: sidecar.output.sha256,
      p95Ms: sidecar.latencyMs.p95
    });
    if ((i + 1) % 10 === 0 || i === points.length - 1) {
      const secs = (Date.now() - tGrid) / 1000;
      console.log(`             ${String(i + 1).padStart(3)}/${points.length}  ${secs.toFixed(0)}s elapsed  (${(secs / (i + 1)).toFixed(2)}s/point)`);
    }
  }
  const gridMs = Date.now() - tGrid;
  console.log(`           done in ${(gridMs / 1000).toFixed(1)}s${cachedCount ? ` (${cachedCount} cached)` : ''}\n`);

  // --- phase 4: the surface -------------------------------------------------
  console.log('  phase 4  nDCG@8 surface');
  // toFixed(1) would print 0.75 as "0.8" and collide with the real 0.8 column.
  console.log(`           b:      ${B_VALUES.map((b) => String(b).padStart(7)).join('')}`);
  for (const k1 of K1_VALUES) {
    const cells = B_VALUES.map((b) => {
      const row = rows.find((r) => r.k1 === k1 && r.b === b);
      return fmt(row.ndcg[8], 4).padStart(7);
    });
    console.log(`           k1 ${String(k1).padStart(3)} ${cells.join('')}`);
  }
  console.log('');

  // --- phase 5: selection ---------------------------------------------------
  const defaultRow = rows.find((r) => r.k1 === SELECTION.default.k1 && r.b === SELECTION.default.b);
  const { selected, plateau, plateau2 } = selectPoint(rows);
  console.log('  phase 5  selection by the rule declared in this file before the grid ran');
  console.log(`           default   k1 ${defaultRow.k1} b ${defaultRow.b}   nDCG@8 ${fmt(defaultRow.ndcg[8], 6)}  nDCG@10 ${fmt(defaultRow.ndcg[10], 6)}`);
  console.log(`           selected  k1 ${selected.k1} b ${selected.b}   nDCG@8 ${fmt(selected.ndcg[8], 6)}  nDCG@10 ${fmt(selected.ndcg[10], 6)}`);
  console.log(`           plateau at the primary metric: ${plateau.length} of ${rows.length}; after the @10 tie-break: ${plateau2.length}`);
  console.log(`           margin    nDCG@8 ${(selected.ndcg[8] - defaultRow.ndcg[8]).toFixed(6)}   nDCG@10 ${(selected.ndcg[10] - defaultRow.ndcg[10]).toFixed(6)}`);
  console.log(`           ${SELECTION.selectedDoesNotShip}\n`);

  // --- phase 6: per-query, optimism -----------------------------------------
  console.log(`  phase 6  re-deriving per-query nDCG@8 from ${rows.length} run files through eval/metrics.js`);
  const vectors = new Map();
  for (const row of rows) {
    const { perQuery, aggregate } = perQueryFor(row, queryIds, qrels);
    if (aggregate.ndcg[8] !== row.ndcg[8] || aggregate.mrr !== row.mrr) {
      fail(`${row.label}: re-derived nDCG@8 ${aggregate.ndcg[8]} != sidecar ${row.ndcg[8]}`);
    }
    vectors.set(row.label, perQuery.map((q) => (q.ndcg[8] === null ? 0 : q.ndcg[8])));
  }
  console.log(`           all ${rows.length} aggregates match their sidecars at exact float equality\n`);

  const optimism = splitHalfOptimism(rows, vectors, defaultRow.label, queryIds.length, SPLIT_HALF_SEED, SPLIT_HALF_REPEATS);
  console.log(`  phase 6b split-half optimism, ${optimism.repeats} repeats, seed ${optimism.seed}`);
  console.log(`           mean margin(A) - margin(B) = ${optimism.mean.toFixed(6)}   [p5 ${optimism.p5.toFixed(6)}, p95 ${optimism.p95.toFixed(6)}]`);
  console.log(`           against a full-dev selection margin of ${(selected.ndcg[8] - defaultRow.ndcg[8]).toFixed(6)}`);
  console.log(`           distinct configurations chosen across the ${optimism.repeats} halves: ${optimism.distinctChosen}`);
  console.log(`           most frequent: ${optimism.chosen.slice(0, 4).map(([l, n]) => `${l} x${n}`).join(', ')}`);
  console.log(`           2.7 could lean on per-query monotonicity and call this a formality. Here it is the evidence.\n`);

  // --- write ----------------------------------------------------------------
  fs.mkdirSync(SWEEP_DIR, { recursive: true });
  const csvFile = path.join(SWEEP_DIR, 'v4-bm25-params.csv');
  const header = ['k1', 'b', 'label', 'digest8',
    ...KS.map((k) => `ndcg@${k}`), ...KS.map((k) => `p@${k}`), ...KS.map((k) => `r@${k}`),
    'mrr@10', 'runLines', 'zeroResultQueries', 'p95SearchMs'];
  const csvLines = [header.join(',')];
  for (const row of rows) {
    csvLines.push([
      row.k1, row.b, row.label, row.digest.slice(0, 8),
      ...KS.map((k) => row.ndcg[k].toFixed(6)),
      ...KS.map((k) => row.p[k].toFixed(6)),
      ...KS.map((k) => row.r[k].toFixed(6)),
      row.mrr.toFixed(6), row.lines, row.zeroResult, row.p95Ms.toFixed(6)
    ].join(','));
  }
  fs.writeFileSync(csvFile, `${csvLines.join('\n')}\n`);

  const manifest = {
    phase: '3.3',
    what: 'Sweep of v4-bm25 k1 x b on the dev split. One row per grid point in v4-bm25-params.csv.',
    gridIsASample:
      'k1 and b are CONTINUOUS with a genuine interior optimum, so unlike 2.7 (§13.2) this grid is a ' +
      'SAMPLE of the parameter space rather than an exhaustive enumeration of its behaviours, and unlike ' +
      '§13.4 there is no per-query monotonicity to make the argmax forced. The split-half optimism ' +
      'estimate below is therefore the evidence about selection bias, not a confirmation of a ' +
      'structural argument.',
    gitignoreNote:
      'Per-point run files and sidecars live in results/sweeps/runs/ and are gitignored, per §13.9: ' +
      'a named configuration gets a sidecar, a grid point gets a CSV row.',
    labelScheme:
      'Grid points are indexed (v4-p001...) with the params in this manifest and the CSV. 3.2 noticed ' +
      'that param-encoding labels break on continuous axes; runs cited in prose keep descriptive labels.',
    site: SITE,
    split: SPLIT,
    retriever: RETRIEVER,
    ksReported: KS,
    heldFixed: Object.fromEntries(Object.entries(defaults).filter(([k]) => k !== 'k1' && k !== 'b')),
    grid: { k1: K1_VALUES, b: B_VALUES, points: points.length },
    k1AndBAreScoringTime: {
      claimCorrected:
        'ROADMAP 3.3 asserts "k1 and b both change the index, so they cannot reuse a cached one". ' +
        'That is false for a standard BM25 and v4-bm25.js is built so it stays false: postings hold ' +
        'raw tf, the length ratio is b-independent, and buildIndex() never reads k1 or b.',
      verifiedAtCorpusScale: sameStructures,
      indexMs
    },
    selectionRule: SELECTION,
    inputs: [
      { name: 'corpus', file: path.relative(REPO_ROOT, corpusFile), sha256: sha256File(corpusFile) },
      { name: 'qrels', file: path.relative(REPO_ROOT, qrelsFile), sha256: sha256File(qrelsFile) },
      { name: 'split', file: path.relative(REPO_ROOT, splitFile), sha256: sha256File(splitFile) }
    ],
    default: { k1: defaultRow.k1, b: defaultRow.b, label: defaultRow.label, metrics: { ndcg: defaultRow.ndcg, p: defaultRow.p, r: defaultRow.r, mrr: defaultRow.mrr } },
    selected: { k1: selected.k1, b: selected.b, label: selected.label, digest: selected.digest, metrics: { ndcg: selected.ndcg, p: selected.p, r: selected.r, mrr: selected.mrr } },
    plateauSize: { atPrimary: plateau.length, afterTieBreak: plateau2.length, ofPoints: rows.length },
    margin: {
      'ndcg@8': selected.ndcg[8] - defaultRow.ndcg[8],
      'ndcg@10': selected.ndcg[10] - defaultRow.ndcg[10],
      note: 'A SELECTION margin on dev, not a result. The rung ships at the default; the tuned point is EXPLORATORY.'
    },
    optimism,
    perPointDigests: rows.map((r) => ({ label: r.label, k1: r.k1, b: r.b, digest: r.digest, runSha256: r.runSha256 })),
    timingsMs: { grid: gridMs, total: Date.now() - t0 },
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu: os.cpus()[0] ? os.cpus()[0].model : null,
      memoryGiB: Math.round(os.totalmem() / 1073741824),
      peakRssMiB: Math.round(process.memoryUsage().rss / 1048576)
    },
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(SWEEP_DIR, 'v4-sweep.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`  wrote results/sweeps/v4-bm25-params.csv (${rows.length} rows)`);
  console.log(`        results/sweeps/v4-sweep.manifest.json`);
  console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n  NEXT: the selected point is run as a NAMED configuration under the label`);
  console.log(`        v4-bm25-tuned, and compared EXPLORATORILY against v4-bm25:`);
  console.log(`          npm run eval -- --retriever v4-bm25 --split dev --param k1=${selected.k1} --param b=${selected.b} --label v4-bm25-tuned`);
  console.log(`          npm run eval:compare v4-bm25-tuned v4-bm25`);
}

try {
  main();
} catch (error) {
  console.error(`\n  FAILED: ${error.message}`);
  if (!error.assertion) console.error(error.stack);
  process.exit(1);
}
