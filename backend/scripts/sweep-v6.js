'use strict';

/**
 * sweep-v6.js — Phase 3.5. The RRF constant, swept on dev.
 *
 *   cd backend && npm run sweep:v6           # reuses cached grid points
 *   cd backend && npm run sweep:v6 -- --fresh
 *
 * THE SELECTED POINT DOES NOT SHIP. §16.3's rule, settled at 3.3 so 3.4 and 3.5
 * do not re-litigate it: LADDER RUNGS SHIP UNTUNED; TUNING IS MEASURED BESIDE
 * THEM. registry.json's ladder-v5-v6 names `v6-hybrid`, which is RRF at the
 * published rrfK = 60, and the swept optimum ships separately as
 * `v6-hybrid-tuned`, EXPLORATORY. registry.json is NOT edited — an eighth entry
 * would retroactively tighten Holm from α/7 = 0.00714 to α/8 = 0.00625 for
 * every comparison already run.
 *
 * The selection rule is declared in this file, in the same commit, BEFORE the
 * grid runs. sweep-v4.js established that shape; it is the only thing that
 * makes "the tuned point does not ship" a decision rather than a reaction.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SWEEP EXPECTS, WRITTEN DOWN FIRST.
 *
 * 2.7's two axes were monotone PER QUERY, so its argmax was forced by an
 * argument holding on every subset and selection optimism came out at ~0.
 * 3.3's k1 × b had a genuine interior optimum and the same estimator put 44% of
 * the tuning margin down to optimism, with a NEGATIVE 5th percentile and ten
 * different configurations winning across 200 dev halves.
 *
 * rrfK is one continuous knob with an interior optimum and NO monotonicity to
 * lean on, so this sweep expects 3.3's shape rather than 2.7's, and §13.7's
 * estimator is the evidence rather than a confirmation. Reported whatever it
 * says.
 * ─────────────────────────────────────────────────────────────────────────
 * NO p95SearchMs COLUMN IN THE CSV, AND THAT IS 3.3's NOTICED-LIST ITEM CLOSED
 * FOR NEW TOOLS.
 *
 * 3.3 recorded it and 3.4 left it: the per-point p95 is an UNCONTROLLED laptop
 * figure, quoted nowhere, that sits in a results CSV looking like data. 3.3's
 * remedy was "either drop the column or label it as not-a-measurement".
 *
 * It is dropped here. It is NOT retrofitted into sweep-v4.js, and that is the
 * same decision 3.4 made for the same reason: renaming or removing it there
 * makes the script disagree with the committed v4-bm25-params.csv unless a
 * 1,327 s grid is re-run to regenerate a banked artifact for a cosmetic change,
 * and hand-editing the CSV produces a file the script cannot reproduce — worse
 * than the defect. So the defect survives in one committed artifact and stops
 * PROPAGATING, which is the whole content of "the last cheap moment". Still due
 * at 3.6, which is touching the sweep tooling anyway.
 *
 * The per-point wall time is not lost, only moved: it lives in the manifest's
 * `timingsMs`, where a reader meets it as provenance rather than as a column
 * beside four metrics.
 * ─────────────────────────────────────────────────────────────────────────
 * IT ADDS NO FIFTH COPY OF THE LOADERS. scripts/lib/run-io.js, per 3.3's narrow
 * rule — v6 adds no copy, it consolidates nothing. §11.1's reason for the
 * deliberate second copy still holds and consolidation is still 3.6's.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { paramsDigest } = require('../retrieval/types');
const v6 = require('../retrieval/v6-hybrid');
const metrics = require('../eval/metrics');
const { mulberry32 } = require('../eval/bootstrap');
const { readLines, sha256File, loadQrels, loadRun } = require('./lib/run-io');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SITE = 'cooking';
const SPLIT = 'dev';
const RETRIEVER = 'v6-hybrid';
const KS = [1, 5, 8, 10];
const SWEEP_DIR = path.join(REPO_ROOT, 'results', 'sweeps');
const RUN_DIR = path.join(SWEEP_DIR, 'runs');
const RUN_DIR_REL = 'results/sweeps/runs';

/**
 * THE GRID. A sample of a continuous axis, not a lattice — the same status
 * sweep-v4.js's grid has, and §13.2's exhaustiveness argument does not transfer.
 *
 *   rrfK = 0     1/rank. Maximally top-heavy: rank 1 is worth 2× rank 2, so a
 *                single system's top hit can dictate the fused order.
 *   rrfK large   1/(K+r) flattens toward (1/K)(1 − r/K), so the ordering tends
 *                to SUM OF RANKS, i.e. Borda. Not reachable; 1000 is the far
 *                endpoint standing in for it.
 *
 * 60 IS ON THE GRID DELIBERATELY. Every "what did tuning buy" margin has to be
 * measured against a point that is a ROW — sweep-v4.js hit the same shape with
 * b = 0.75 and §13.2 with the shipped 0.15, and both solved it by putting the
 * default on the grid explicitly. The phase-1 guard below fails the run if it
 * is absent rather than letting the margin be quoted against a separately-run
 * process.
 */
const RRF_K_VALUES = [0, 1, 2, 5, 10, 20, 40, 60, 100, 200, 400, 700, 1000];

const SELECTION = {
  primary: { metric: 'ndcg', k: 8 },
  tieBreak: { metric: 'ndcg', k: 10 },
  thenPrefer: 'the published default',
  default: { rrfK: 60 },
  selectedDoesNotShip:
    'The selected point ships as v6-hybrid-tuned, EXPLORATORY. v6-hybrid is RRF at the published ' +
    'rrfK = 60 and is what registry.json ladder-v5-v6 names. Declared before the grid ran.'
};

/** 1.4 used 20260803, 2.5 …804, 2.7 …806, 3.3 …808. Different purpose, different stream. */
const SPLIT_HALF_SEED = 20260809;
const SPLIT_HALF_REPEATS = 200;

const fmt = (v, d = 4) => (v === null || v === undefined ? '—' : v.toFixed(d));

function fail(message) {
  const error = new Error(message);
  error.assertion = true;
  throw error;
}

function pointLabel(i) {
  return `v6-p${String(i + 1).padStart(3, '0')}`;
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
    '--param', `rrfK=${JSON.stringify(point.rrfK)}`,
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

  // Then nearest the published default, so a tie never resolves on grid order.
  plateau2.sort((a, c) =>
    (c.rrfK === SELECTION.default.rrfK ? 1 : 0) - (a.rrfK === SELECTION.default.rrfK ? 1 : 0) ||
    Math.abs(a.rrfK - SELECTION.default.rrfK) - Math.abs(c.rrfK - SELECTION.default.rrfK));

  return { selected: plateau2[0], plateau, plateau2, best };
}

function perQueryFor(point, queryIds, qrels) {
  const run = loadRun(path.join(RUN_DIR, `${point.label}.${SPLIT}.run`));
  const perQuery = queryIds.map((qid) =>
    metrics.scoreQuery(run.get(qid) || [], qrels.get(qid) || new Map(), KS));
  return { perQuery, aggregate: metrics.aggregate(perQuery, KS) };
}

/**
 * SELECTION BIAS. §13.7's estimator, unchanged in mechanism. Split dev in half,
 * redo the FULL selection on half A, and compare the margin the chosen point
 * earns on A against the margin the same point earns on held-out half B.
 *
 *   optimism = mean over repeats of ( margin(A) − margin(B) )
 *
 * The baseline is the DEFAULT configuration, since the margin being estimated is
 * "what tuning bought over the published constant". It stays entirely inside
 * dev; test is opened once, at 3.6. It bounds SELECTION optimism only.
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
    chosen.set(`rrfK=${bestRow.rrfK}`, (chosen.get(`rrfK=${bestRow.rrfK}`) || 0) + 1);

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

  const qrels = loadQrels(qrelsFile);
  const queryIds = readLines(splitFile);

  console.log(`sweep v6-hybrid rrfK on ${SITE}.${SPLIT}`);
  console.log(`  ${queryIds.length} queries\n`);

  // --- phase 1: the grid ----------------------------------------------------
  const defaults = v6.defaultParams;
  const points = RRF_K_VALUES.map((rrfK, i) => ({
    label: pointLabel(i),
    rrfK,
    digest: paramsDigest(RETRIEVER, { ...defaults, rrfK })
  }));
  console.log(`  phase 1  ${points.length} points on one axis`);
  console.log(`           rrfK ${RRF_K_VALUES.join(', ')}`);
  console.log(`           A SAMPLE of a continuous axis, not a lattice. §13.2's exhaustiveness`);
  console.log(`           argument does not transfer and no monotonicity is asserted.`);
  const defaultPoint = points.find((p) => p.rrfK === SELECTION.default.rrfK);
  if (!defaultPoint) fail('the published default rrfK is not on the grid — every margin would be quoted against a non-row');
  console.log(`           the published default (rrfK ${SELECTION.default.rrfK}) is on the grid: ${defaultPoint.label}\n`);

  // --- phase 2: rrfK is a scoring-time param --------------------------------
  // Asserted rather than assumed, in the shape sweep-v4.js used for k1/b: if
  // rrfK reached either component's index, a per-point rebuild would be
  // mandatory and the cached-point optimisation below would be silently wrong.
  const { index } = require('../retrieval');
  const probeDocs = [
    { id: 'a', title: 'salt', body: 'brine the bird in salt water overnight', vector: null },
    { id: 'b', title: 'brine', body: 'a salt brine for poultry', vector: null }
  ];
  // Synthetic vectors, deterministic, two dimensions — this probe is about
  // whether rrfK touches the index, not about retrieval quality.
  probeDocs[0].vector = Float32Array.from([1, 0]);
  probeDocs[1].vector = Float32Array.from([0.6, 0.8]);
  const hA = index(RETRIEVER, probeDocs, { rrfK: 0, dim: 2 });
  const hB = index(RETRIEVER, probeDocs, { rrfK: 1000, dim: 2 });
  const sameStructures =
    hA._state.bm25State.avgdl === hB._state.bm25State.avgdl &&
    hA._state.bm25State.vocabularySize === hB._state.bm25State.vocabularySize &&
    hA._state.denseState.matrix.every((v, i) => v === hB._state.denseState.matrix[i]);
  if (!sameStructures) fail('rrfK reached a component index — the cached-point design is wrong');
  console.log('  phase 2  rrfK does not touch either component index: structures identical at 0 vs 1000');
  console.log('           so a grid point is a re-score, and the cache keys on the params digest\n');

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
      rrfK: points[i].rrfK,
      digest: points[i].digest,
      ndcg: sidecar.metrics.ndcg,
      p: sidecar.metrics.p,
      r: sidecar.metrics.r,
      mrr: sidecar.metrics.mrr,
      lines: sidecar.output.lines,
      zeroResult: sidecar.queries.zeroResult,
      runSha256: sidecar.output.sha256,
      // Kept for the manifest's timings block, NOT for the CSV. See the header.
      p95Ms: sidecar.latencyMs.p95
    });
    const secs = (Date.now() - tGrid) / 1000;
    console.log(`             ${String(i + 1).padStart(3)}/${points.length}  rrfK ${String(points[i].rrfK).padStart(4)}  nDCG@8 ${fmt(rows[i].ndcg[8], 6)}  ${secs.toFixed(0)}s elapsed`);
  }
  const gridMs = Date.now() - tGrid;
  console.log(`           done in ${(gridMs / 1000).toFixed(1)}s${cachedCount ? ` (${cachedCount} cached)` : ''}\n`);

  // --- phase 4: the curve ---------------------------------------------------
  console.log('  phase 4  nDCG@8 against rrfK');
  for (const row of rows) {
    const marker = row.rrfK === SELECTION.default.rrfK ? '  <- published default' : '';
    console.log(`           rrfK ${String(row.rrfK).padStart(4)}  ${fmt(row.ndcg[8], 6)}${marker}`);
  }
  console.log('');

  // --- phase 5: selection ---------------------------------------------------
  const defaultRow = rows.find((r) => r.rrfK === SELECTION.default.rrfK);
  const { selected, plateau, plateau2 } = selectPoint(rows);
  console.log('  phase 5  selection by the rule declared in this file before the grid ran');
  console.log(`           default   rrfK ${defaultRow.rrfK}   nDCG@8 ${fmt(defaultRow.ndcg[8], 6)}  nDCG@10 ${fmt(defaultRow.ndcg[10], 6)}`);
  console.log(`           selected  rrfK ${selected.rrfK}   nDCG@8 ${fmt(selected.ndcg[8], 6)}  nDCG@10 ${fmt(selected.ndcg[10], 6)}`);
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
  console.log('');

  // --- write ----------------------------------------------------------------
  fs.mkdirSync(SWEEP_DIR, { recursive: true });
  const csvFile = path.join(SWEEP_DIR, 'v6-hybrid-params.csv');
  // NO p95SearchMs COLUMN. See the header — 3.3's noticed-list item, closed for
  // new tools. The per-point wall time lives in the manifest instead.
  const header = ['rrfK', 'label', 'digest8',
    ...KS.map((k) => `ndcg@${k}`), ...KS.map((k) => `p@${k}`), ...KS.map((k) => `r@${k}`),
    'mrr@10', 'runLines', 'zeroResultQueries'];
  const csvLines = [header.join(',')];
  for (const row of rows) {
    csvLines.push([
      row.rrfK, row.label, row.digest.slice(0, 8),
      ...KS.map((k) => row.ndcg[k].toFixed(6)),
      ...KS.map((k) => row.p[k].toFixed(6)),
      ...KS.map((k) => row.r[k].toFixed(6)),
      row.mrr.toFixed(6), row.lines, row.zeroResult
    ].join(','));
  }
  fs.writeFileSync(csvFile, `${csvLines.join('\n')}\n`);

  const manifest = {
    phase: '3.5',
    what: 'Sweep of v6-hybrid rrfK on the dev split. One row per grid point in v6-hybrid-params.csv.',
    gridIsASample:
      'rrfK is CONTINUOUS with a genuine interior optimum, so unlike 2.7 (§13.2) this grid is a SAMPLE ' +
      'of the axis rather than an exhaustive enumeration of its behaviours, and unlike §13.4 there is no ' +
      'per-query monotonicity to make the argmax forced. The split-half optimism estimate below is ' +
      'therefore the evidence about selection bias, not a confirmation of a structural argument.',
    noP95Column:
      "3.3's noticed-list, closed for new tools. The per-point p95 is an UNCONTROLLED laptop figure " +
      'quoted nowhere that sits in a results CSV looking like data, so this CSV does not carry it; the ' +
      'per-point wall time is in timingsMs instead. sweep-v4.js is deliberately NOT retrofitted — that ' +
      'would desynchronise the committed v4-bm25-params.csv unless a 1,327 s grid is re-run for a ' +
      'cosmetic change. The defect stops propagating; removing it from the banked artifact is 3.6\'s.',
    gitignoreNote:
      'Per-point run files and sidecars live in results/sweeps/runs/ and are gitignored, per §13.9: ' +
      'a named configuration gets a sidecar, a grid point gets a CSV row.',
    site: SITE,
    split: SPLIT,
    retriever: RETRIEVER,
    ksReported: KS,
    heldFixed: Object.fromEntries(Object.entries(defaults).filter(([k]) => k !== 'rrfK')),
    grid: { rrfK: RRF_K_VALUES, points: points.length },
    rrfKIsScoringTime: {
      claim: 'rrfK does not reach either component index, so a grid point is a re-score.',
      verified: sameStructures
    },
    selectionRule: SELECTION,
    inputs: [
      { name: 'corpus', file: path.relative(REPO_ROOT, corpusFile), sha256: sha256File(corpusFile) },
      { name: 'qrels', file: path.relative(REPO_ROOT, qrelsFile), sha256: sha256File(qrelsFile) },
      { name: 'split', file: path.relative(REPO_ROOT, splitFile), sha256: sha256File(splitFile) }
    ],
    default: { rrfK: defaultRow.rrfK, label: defaultRow.label, metrics: { ndcg: defaultRow.ndcg, p: defaultRow.p, r: defaultRow.r, mrr: defaultRow.mrr } },
    selected: { rrfK: selected.rrfK, label: selected.label, digest: selected.digest, metrics: { ndcg: selected.ndcg, p: selected.p, r: selected.r, mrr: selected.mrr } },
    plateauSize: { atPrimary: plateau.length, afterTieBreak: plateau2.length, ofPoints: rows.length },
    margin: {
      'ndcg@8': selected.ndcg[8] - defaultRow.ndcg[8],
      'ndcg@10': selected.ndcg[10] - defaultRow.ndcg[10],
      note: 'A SELECTION margin on dev, not a result. The rung ships at the published default; the tuned point is EXPLORATORY.'
    },
    optimism,
    perPointDigests: rows.map((r) => ({ label: r.label, rrfK: r.rrfK, digest: r.digest, runSha256: r.runSha256 })),
    timingsMs: {
      grid: gridMs,
      total: Date.now() - t0,
      // WITHOUT THESE TWO, `grid` IS A NUMBER THAT MEANS SOMETHING OTHER THAN
      // WHAT IT LOOKS LIKE. A cached point costs a file read, so `grid` covers
      // only the points that actually ran; divided by 13 it would understate
      // the per-point cost by however many were reused. That is the same defect
      // as the p95 column this file removed — a plausible figure in a committed
      // artifact that a reader will interpret wrongly — so the denominator is
      // recorded beside the numerator rather than left to be inferred.
      pointsRunFresh: points.length - cachedCount,
      pointsReusedFromCache: cachedCount,
      gridCoversFreshPointsOnly: true,
      perPointP95SearchMs: Object.fromEntries(rows.map((r) => [r.label, r.p95Ms])),
      perPointP95IsNotAMeasurement:
        'Uncontrolled laptop figures recorded as provenance, not as data. No performance claim rests ' +
        'on any of them; a controlled figure against a published budget is 6.5\'s job.'
    },
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
  fs.writeFileSync(path.join(SWEEP_DIR, 'v6-sweep.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`  wrote results/sweeps/v6-hybrid-params.csv (${rows.length} rows)`);
  console.log('        results/sweeps/v6-sweep.manifest.json');
  console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n  NEXT: the selected point is run as a NAMED configuration under the label');
  console.log('        v6-hybrid-tuned, and compared EXPLORATORILY against v6-hybrid:');
  console.log(`          npm run eval -- --retriever v6-hybrid --split dev --param rrfK=${selected.rrfK} --label v6-hybrid-tuned`);
  console.log('          npm run eval:compare v6-hybrid-tuned v6-hybrid');
}

try {
  main();
} catch (error) {
  console.error(`\n  FAILED: ${error.message}`);
  if (!error.assertion) console.error(error.stack);
  process.exit(1);
}
