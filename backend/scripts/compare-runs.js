#!/usr/bin/env node
'use strict';

/**
 * compare-runs.js — Phase 2.5
 *
 * Paired bootstrap significance testing between two run files.
 *
 *   npm run eval:compare v1-overlap-uncapped v1-overlap
 *   npm run eval:compare -- v1-overlap-uncapped v1-overlap --split dev
 *
 * ROADMAP 2.5's criterion is written `npm run eval:compare v1 v2`, and that
 * form works verbatim — npm passes bare words through. The `--` is npm's, not
 * this script's, and is needed only when a FLAG follows, since npm would
 * otherwise try to interpret it itself.
 *
 * A - B is the reported direction throughout, so name the candidate first.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE PER-QUERY SCORES COME FROM, AND WHY NOT FROM THE RUNNER
 *
 * They are RE-DERIVED from the written run file on every comparison, by
 * calling backend/eval/metrics.js — the module validated against pytrec_eval at
 * 2.4. run-eval.js computes per-query scores in memory and writes only the
 * aggregate into its sidecar, so the alternative was to change 2.2's runner to
 * persist a per-query file.
 *
 * That was rejected, and speed was not the reason. A persisted per-query file
 * is a SECOND SOURCE for the same number. When it and the run file disagree —
 * a stale file, an interrupted run, a hand-edited line — there is no
 * principled way to say which is right. Re-deriving has exactly one source of
 * truth, and it is the artifact EVALUATION.md §8.5 already guarantees
 * regenerates in ~3 s from SHA-256-pinned inputs.
 *
 * The provenance that a persisted file would have bought is obtained here
 * instead, and more cheaply:
 *
 *   - provenance comes from the COMMITTED sidecar (runid, param digest, every
 *     input hash, git commit, environment);
 *   - and the aggregate recomputed here is asserted against that sidecar's
 *     `metrics` block AT EXACT FLOAT EQUALITY. That is the same guard 2.4's
 *     Python side applied to scripts/emit-per-query-scores.js. A run file that
 *     has drifted from its sidecar fails loudly instead of being compared.
 *
 * WHAT IS NOT ARCHIVED, STATED PLAINLY. The per-query vectors themselves. A
 * comparison is reproducible only if the run files are — which §8.5 already
 * asserts, so this adds no new dependency, but it does mean the inputs to a
 * significance claim are derived data and the sidecar assert is what keeps
 * that honest.
 *
 * THE LOADERS BELOW DUPLICATE scripts/emit-per-query-scores.js, DELIBERATELY.
 * That file is part of 2.4's evidence chain — the bridge whose output
 * pytrec_eval was diffed against — and refactoring it to serve a new caller
 * would mean the validated artifact and the audited artifact are no longer the
 * same bytes. ~60 duplicated lines, and the duplication is CHECKED rather than
 * assumed: if this file's parse differed from that one's, the sidecar equality
 * assert would fail.
 *
 * RANK, NOT SCORE. The run file's RANK column is authoritative here, matching
 * the 2.4 bridge and for the reason recorded there: v1's scores take 18
 * distinct values across the whole dev run, so 88% of adjacent pairs are score
 * ties whose order is not recoverable from the score column. retrieval/index.js
 * fixed the order before the file was written.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const metrics = require('../eval/metrics');
const { pairedBootstrap } = require('../eval/bootstrap');
const { retrieverSource } = require('../eval/source-digest');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_KS = [1, 5, 8, 10];

// The seed lives here rather than in eval/bootstrap.js. The pure module takes
// `seed` as a required argument with NO default, so no call site can quietly
// obtain a reproducible-looking number without naming the seed it came from.
//
// 20260804, deliberately NOT 1.4's 20260803. Different purpose, different
// stream; sharing the constant would imply a coupling to the split shuffle
// that does not exist.
const DEFAULT_SEED = 20260804;

// B controls only MONTE CARLO error — the one error source that can be bought
// down with CPU. So it is chosen against the sampling error it estimates, not
// by convention. At the decision boundary that matters, p ~= 0.05, the Monte
// Carlo standard error is sqrt(0.05 * 0.95 / B) = 0.0022 at B = 10,000. That
// resolves the 0.05 threshold to about +/- 0.004: enough to decide
// significance, not enough to justify a third decimal. B = 100,000 buys that
// third decimal at 10x the cost and no decision in this project rests on it.
//
// Rather than leave that as arithmetic, the report PRINTS the Monte Carlo
// standard error next to p, so how much of the p-value is resampling noise is
// visible instead of taken on trust. --resamples raises it.
const DEFAULT_RESAMPLES = 10000;

const REGISTRY_FILE = path.join(REPO_ROOT, 'results', 'comparisons', 'registry.json');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    site: 'cooking',
    split: 'dev',
    ks: DEFAULT_KS,
    seed: DEFAULT_SEED,
    resamples: DEFAULT_RESAMPLES,
    alpha: 0.05,
    write: true,
    positional: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--seed' && value) { args.seed = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--resamples' && value) { args.resamples = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--alpha' && value) { args.alpha = Number.parseFloat(value); i += 1; }
    else if (flag === '--no-write') { args.write = false; }
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
    else args.positional.push(flag);
  }
  if (args.positional.length !== 2) {
    throw new Error(
      'expected exactly two run labels\n' +
      '  npm run eval:compare -- <labelA> <labelB> [--split dev] [--seed N] [--resamples N]\n' +
      '  A - B is the reported direction, so name the candidate first.'
    );
  }
  [args.a, args.b] = args.positional;
  return args;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

function fail(message) {
  const error = new Error(message);
  error.assertion = true;
  throw error;
}

/** TREC qrels: `qid 0 docid grade` -> Map<qid, Map<docid, grade>>. */
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

/** run file -> Map<qid, docid[]>, ordered by the RANK column. */
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

/**
 * Load one side of the comparison: the run file, its sidecar, and the
 * per-query scores re-derived through metrics.js in SPLIT FILE ORDER.
 *
 * Split order, not run-file order, because run-eval.js scored in split order
 * and the sidecar equality assert below is at exact float equality — floating
 * point addition is not associative, so a different accumulation order can
 * legitimately produce a different last bit. Matching the order removes that as
 * an explanation for a mismatch, which is what makes a mismatch informative.
 */
function loadSide(label, args, queryIds, qrels) {
  const runFile = path.join(REPO_ROOT, 'results', 'runs', `${label}.${args.split}.run`);
  const sidecarFile = `${runFile}.json`;

  if (!fs.existsSync(runFile)) {
    fail(
      `${path.relative(REPO_ROOT, runFile)} does not exist.\n` +
      `  Run files are gitignored derived data (EVALUATION.md §8.5) and regenerate in ~3 s.\n` +
      (fs.existsSync(sidecarFile)
        ? `  Its sidecar IS committed and names the command:\n    ${JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).command}`
        : `  No sidecar either, so there is no record of how to rebuild it.`)
    );
  }
  if (!fs.existsSync(sidecarFile)) {
    fail(
      `${path.relative(REPO_ROOT, sidecarFile)} does not exist.\n` +
      `  The sidecar carries the provenance this comparison quotes, and its committed\n` +
      `  metrics block is what checks the re-derivation below. A run file without one\n` +
      `  cannot be traced, so it is not compared.`
    );
  }

  const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
  const run = loadRun(runFile);

  const perQuery = [];
  for (const qid of queryIds) {
    perQuery.push(metrics.scoreQuery(run.get(qid) || [], qrels.get(qid) || new Map(), args.ks));
  }
  const aggregate = metrics.aggregate(perQuery, args.ks);

  return {
    label,
    runFile,
    sidecarFile,
    sidecar,
    runSha256: sha256File(runFile),
    run,
    perQuery,
    aggregate,
    zeroResultIds: queryIds.filter((qid) => !run.has(qid))
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * The re-derivation must reproduce the runner, bit for bit.
 *
 * This is the assert that replaces persisting a per-query file. run-eval.js
 * scored an in-memory list; this scored the written bytes. Nothing guarantees
 * those agree — a truncated write, a run file regenerated under different
 * params next to an old sidecar, an edited line — so it is checked rather than
 * assumed, at exact float equality rather than to a tolerance. A tolerance here
 * would be a place for a real drift to hide.
 */
function assertMatchesSidecar(side, ks) {
  const recorded = side.sidecar.metrics;
  if (!recorded) {
    fail(`${path.relative(REPO_ROOT, side.sidecarFile)} has no metrics block to check against.`);
  }

  const mismatches = [];
  const check = (name, got, want) => {
    if (got === want) return;
    if (got === null && want === null) return;
    mismatches.push(`    ${name}: re-derived ${got}, sidecar ${want}`);
  };
  for (const k of ks) {
    check(`nDCG@${k}`, side.aggregate.ndcg[k], recorded.ndcg?.[String(k)] ?? recorded.ndcg?.[k]);
    check(`P@${k}`, side.aggregate.p[k], recorded.p?.[String(k)] ?? recorded.p?.[k]);
    check(`R@${k}`, side.aggregate.r[k], recorded.r?.[String(k)] ?? recorded.r?.[k]);
  }
  check('MRR', side.aggregate.mrr, recorded.mrr);

  if (mismatches.length > 0) {
    fail(
      `${side.label}: scores re-derived from the run file do not match its committed sidecar.\n` +
      mismatches.join('\n') + '\n' +
      `    run file  ${path.relative(REPO_ROOT, side.runFile)}\n` +
      `              sha256 ${side.runSha256}\n` +
      `    sidecar   ${path.relative(REPO_ROOT, side.sidecarFile)}\n` +
      `              records sha256 ${side.sidecar.output?.sha256}\n` +
      `  The run file and the sidecar came from different runs, or the run file has been\n` +
      `  edited. Regenerate it:\n` +
      `    ${side.sidecar.command}`
    );
  }

  // Independent of the metrics, and a sharper diagnostic when it is the one
  // that trips: the sidecar records the SHA-256 of the bytes the runner wrote.
  if (side.sidecar.output?.sha256 && side.sidecar.output.sha256 !== side.runSha256) {
    fail(
      `${side.label}: the run file's bytes do not match the sha256 its sidecar recorded.\n` +
      `    on disk  ${side.runSha256}\n` +
      `    sidecar  ${side.sidecar.output.sha256}\n` +
      `  The metrics happened to agree anyway, which makes this the more useful signal:\n` +
      `  the file changed in a way the aggregate did not notice. Regenerate it:\n` +
      `    ${side.sidecar.command}`
    );
  }
}

/**
 * Pairing requires one thing and one thing only: both runs answered the SAME
 * QUERIES. That is guaranteed here by construction — both sides are scored over
 * the split file, in split order — so this asserts the guarantee rather than
 * discovering it, and it is a hard failure because an unpaired difference
 * vector is not a difference vector.
 *
 * NOT the same question as whether the two runs have the same zero-result
 * queries. A retriever that returns results where another returned none is a
 * better retriever, not an unpairable one — that query scores 0 on one side and
 * something on the other, which is exactly the difference the test is for. The
 * zero-result sets are reported below as information, never as a gate. The two
 * are easy to conflate and only one of them can invalidate the pairing.
 */
function assertPairable(a, b, queryIds) {
  if (a.perQuery.length !== queryIds.length || b.perQuery.length !== queryIds.length) {
    fail(
      `pairing is broken: ${a.label} scored ${a.perQuery.length} queries, ` +
      `${b.label} scored ${b.perQuery.length}, split holds ${queryIds.length}.`
    );
  }
  const inSplit = new Set(queryIds);
  const aExtra = [...a.run.keys()].filter((q) => !inSplit.has(q));
  const bExtra = [...b.run.keys()].filter((q) => !inSplit.has(q));
  if (aExtra.length > 0 || bExtra.length > 0) {
    fail(
      `a run file holds queries outside the split:\n` +
      `    ${a.label}: ${aExtra.length}   ${b.label}: ${bExtra.length}\n` +
      `  The run and the split were produced from different builds, so the pairing\n` +
      `  would silently be over a different population than the one reported.`
    );
  }
}

// ---------------------------------------------------------------------------
// Pre-registration
// ---------------------------------------------------------------------------

/**
 * Look the pair up in results/comparisons/registry.json.
 *
 * A registered pair gets a p-value. An unregistered one gets its difference and
 * its interval and an explicit note where the p-value would be. Enforcing it
 * here rather than in prose is the entire point: adding a comparison means
 * editing and committing the registry, which timestamps the decision in git
 * history. A pre-registration that can be amended silently is not one.
 */
function lookUpRegistration(a, b, split) {
  if (!fs.existsSync(REGISTRY_FILE)) {
    fail(
      `${path.relative(REPO_ROOT, REGISTRY_FILE)} does not exist.\n` +
      `  It is what decides whether a comparison may report a p-value. Running without\n` +
      `  it would make every comparison exploratory by accident rather than by decision.`
    );
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const entry = registry.comparisons.find(
    (c) => c.a === a && c.b === b && c.split === split
  );
  // Registered in the other direction is still the registered experiment; only
  // the sign of the reported difference changes, and the report names its own
  // direction. Refusing it would be pedantry that pushes people to add a
  // duplicate entry, which is the thing the registry exists to prevent.
  const reversed = registry.comparisons.find(
    (c) => c.a === b && c.b === a && c.split === split
  );
  // 3.6. The registry keys on (a, b, split), and until now the report collapsed
  // two different situations into one word. "This pair is not in the registry"
  // is true of v6-vs-v4 — a comparison nobody registered — and equally true of
  // v6-vs-v5 ON TEST, which is the fifth ladder step, pre-registered at 2.5, run
  // on the split it was not registered for. Both correctly get their p-value
  // suppressed; they are not the same fact about the experiment, and a reader
  // of the test reports has to be able to tell which one they are holding.
  const otherSplit = (entry || reversed) ? null : registry.comparisons.find(
    (c) => (c.a === a && c.b === b) || (c.a === b && c.b === a)
  );
  return {
    registry,
    entry: entry || reversed || null,
    reversed: !entry && Boolean(reversed),
    otherSplit: otherSplit || null,
    primary: (entry || reversed)?.primaryMetric || registry.primaryMetric
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(value, digits = 4) {
  if (value === null || value === undefined) return '-';
  return value.toFixed(digits);
}

/** ASCII '+' / '-' rather than a typographic minus, so the report greps. */
/**
 * The interval as the generated sentence must express it.
 *
 * The sentence names the winner first, so a negative difference swaps A and B —
 * and the interval has to be re-expressed in that same swapped direction. That
 * is a NEGATION AND A SWAP OF THE ENDPOINTS, [lo, hi] -> [-hi, -lo]. §11.2
 * proved the bootstrap interval mirrors exactly under the swap, which is the
 * property that lets registry.json accept a registered pair in either
 * direction; this is that same mirror applied to one printed line.
 *
 * FIXED AT 3.6, AFTER IT HAD REACHED TWO COMMITTED ARTIFACTS. The old
 * expression was [min(|lo|,|hi|), max(|lo|,|hi|)] inline in the writer. It
 * agrees with the mirror above whenever the endpoints share a sign, and is
 * nonsense the moment the interval STRADDLES ZERO: it drops the minus sign and
 * turns a true [-0.004541, +0.005812] into [0.0045, 0.0058], an interval that
 * appears to exclude zero. So the corruption struck nulls only, in the one line
 * of the report most likely to be quoted, while the grid and the §5 header
 * directly above it stayed correct throughout — which is why no prose in
 * EVALUATION.md was ever wrong, and also why nobody noticed for two rungs.
 *
 * Extracted from the writer for one reason: it was untestable inline, and a
 * formatter that can silently invert a conclusion is exactly what a test should
 * hold. tests/compare-sentence.test.js is that test.
 */
function sentenceInterval(meanDifference, ci) {
  return meanDifference > 0 ? [ci[0], ci[1]] : [-ci[1], -ci[0]];
}

function signed(value, digits = 4) {
  if (value === null || value === undefined) return '-';
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;
}

/** A bootstrap cannot resolve below 1/(B+1), so it says so instead of printing 0. */
function formatP(boot) {
  return boot.p <= boot.pFloor ? `<${boot.pFloor.toFixed(4)}` : fmt(boot.p);
}

/**
 * Same defect and same fix as run-eval.js's, but the exclusion has to be
 * NARROWER here, and the difference is the whole point of not writing
 * `:(exclude)results`.
 *
 * This tool's own output is results/comparisons/<A>-vs-<B>.<split>.txt, so
 * writing one dirtied the tree and the next comparison recorded dirty=true.
 * Those .txt files are excluded.
 *
 * results/comparisons/registry.json is NOT, and must never be. It is an INPUT,
 * and §11.5's entire enforcement mechanism is that adding or amending a
 * pre-registered comparison requires a commit — "a pre-registration that can be
 * amended silently is not one". A report generated against an uncommitted
 * registry edit is exactly the case this flag should be shouting about.
 *
 * The committed run SIDECARS under results/runs/ are not excluded either, for
 * the same reason: they are inputs to the comparison, and §11.1 already asserts
 * the re-derived aggregate against them.
 */
function gitProvenance() {
  const run = (a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  try {
    return {
      commit: run(['rev-parse', 'HEAD']),
      dirty: run([
        'status', '--porcelain', '--untracked-files=no',
        '--', '.', ':(exclude)results/comparisons/*.txt'
      ]) !== '',
      dirtyMeans:
        'uncommitted changes to tracked files, EXCLUDING this tool\'s own reports ' +
        '(results/comparisons/*.txt). registry.json and the run sidecars are inputs and ARE counted.'
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** The two runs' params, side by side, with the differing keys named. */
function paramDiff(a, b) {
  const pa = a.sidecar.retriever?.params || {};
  const pb = b.sidecar.retriever?.params || {};
  const keys = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort();
  const rows = keys.map((key) => ({
    key,
    a: pa[key],
    b: pb[key],
    differs: JSON.stringify(pa[key]) !== JSON.stringify(pb[key])
  }));
  const versionA = a.sidecar.retriever?.version;
  const versionB = b.sidecar.retriever?.version;
  if (versionA !== versionB) {
    rows.unshift({ key: 'version', a: versionA, b: versionB, differs: true });
  }
  return rows;
}

function buildReport(ctx) {
  const { a, b, args, registration, results, primaryKey, queryIds } = ctx;
  const out = [];
  const w = (line = '') => out.push(line);

  const rule = '='.repeat(78);
  const thin = '-'.repeat(78);

  w(`PAIRED BOOTSTRAP — ${a.label}  vs  ${b.label}`);
  w(`roadmap 2.5 · ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`);
  w(rule);
  w();
  w('  Direction is A − B throughout. A is the first label on the command line.');
  w();

  // --- 1. what is being compared -------------------------------------------
  w('1. THE TWO RUNS');
  w(thin);
  for (const side of [a, b]) {
    const tag = side === a ? 'A' : 'B';
    w(`  ${tag}  ${side.label}`);
    w(`     runid    ${side.sidecar.runId}`);
    w(`     digest   ${side.sidecar.retriever?.digest}`);
    w(`     source   ${side.sidecar.retrieverSource?.digest || '(not recorded — run predates 3.2)'}`);
    w(`     run      ${path.relative(REPO_ROOT, side.runFile)}`);
    w(`              sha256 ${side.runSha256}  (gitignored; regenerates in ~3 s)`);
    w(`     sidecar  ${path.relative(REPO_ROOT, side.sidecarFile)}  (committed)`);
    w(`     command  ${side.sidecar.command}`);
    w();
  }

  const diff = paramDiff(a, b);
  const changed = diff.filter((r) => r.differs);
  w('  parameters, and how many of them moved:');
  for (const row of diff) {
    const mark = row.differs ? '  <-- differs' : '';
    w(`     ${row.key.padEnd(16)} A ${String(JSON.stringify(row.a)).padEnd(16)} B ${String(JSON.stringify(row.b)).padEnd(16)}${mark}`);
  }
  w();
  if (changed.length === 1) {
    w(`  ONE variable changed (${changed[0].key}). The difference below is attributable to it.`);
  } else if (changed.length === 0) {
    w('  !! NO parameter differs between these two runs. Any difference below is');
    w('     therefore not attributable to a parameter — check the labels before');
    w('     reading anything into it.');
  } else {
    w(`  !! ${changed.length} variables changed at once: ${changed.map((r) => r.key).join(', ')}.`);
    w('     CLAUDE.md: never change two variables at once — an unattributable result is');
    w('     worthless. Printed rather than refused, because a rung comparison changes');
    w('     `version` legitimately; but if `version` is not the only entry above, the');
    w('     difference below cannot be assigned to any one cause.');
  }
  w();

  // --- 1b. the source the runs were produced from ---------------------------
  // The param digest covers {version, params}. It does NOT cover code, and from
  // 3.1 onward rungs share code — v2 imports v1's buildIndex, v3 imports its
  // tokeniser — so an edit to v1-overlap.js moves v2's and v3's numbers with no
  // change to either param digest. Opened on 3.1's noticed-list, closed here.
  w('  the SOURCE each run was produced from, re-hashed now and compared:');
  for (const side of [a, b]) {
    const tag = side === a ? 'A' : 'B';
    const recorded = side.sidecar.retrieverSource;
    if (!recorded) {
      w(`     ${tag}  not recorded — this run predates 3.2 and cannot be checked.`);
      continue;
    }
    let current = null;
    try {
      current = retrieverSource(side.sidecar.retriever.version);
    } catch (err) {
      w(`     ${tag}  cannot re-hash: ${err.message}`);
      continue;
    }
    if (current.digest === recorded.digest) {
      w(`     ${tag}  ${recorded.digest.slice(0, 16)}…  MATCHES the working tree (${recorded.files.length} files)`);
    } else {
      const byPath = new Map(current.files.map((f) => [f.path, f.sha256]));
      const moved = recorded.files.filter((f) => byPath.get(f.path) !== f.sha256).map((f) => f.path);
      const added = current.files.filter((f) => !recorded.files.some((r) => r.path === f.path)).map((f) => f.path);
      w(`     ${tag}  ${recorded.digest.slice(0, 16)}…  DIFFERS from the working tree`);
      // Named rather than left as a digest mismatch. Adding a rung edits
      // index.js and legitimately moves every earlier run's source digest, and
      // "index.js differs" is a self-explaining line where a bare mismatch is
      // an alarm with no content.
      for (const p of [...moved, ...added.map((p) => `${p} (new)`)]) w(`         ${p}`);
    }
  }
  const srcA = a.sidecar.retrieverSource?.digest;
  const srcB = b.sidecar.retrieverSource?.digest;
  if (srcA && srcB && srcA === srcB && a.sidecar.retriever?.version !== b.sidecar.retriever?.version) {
    w('     Both sides hash identically while naming different versions, which cannot');
    w('     happen if each retriever lives in a file named after its version. Check the labels.');
  }
  w();

  // --- 2. population --------------------------------------------------------
  w('2. THE PAIRED POPULATION');
  w(thin);
  w(`  split                ${args.site}.${args.split} — ${queryIds.length} queries`);
  w(`  scored               A ${a.aggregate.scored}   B ${b.aggregate.scored}   (unjudgeable and excluded: A ${a.aggregate.unjudgeable}, B ${b.aggregate.unjudgeable})`);
  w(`  identical qid set    ASSERTED — both sides scored over the split file, in split order.`);
  w('                       This is the only thing pairing requires, and it is a hard');
  w('                       failure if it does not hold.');
  w();
  const zeroA = new Set(a.zeroResultIds);
  const zeroB = new Set(b.zeroResultIds);
  const onlyA = a.zeroResultIds.filter((q) => !zeroB.has(q));
  const onlyB = b.zeroResultIds.filter((q) => !zeroA.has(q));
  w(`  zero-result queries  A ${a.zeroResultIds.length}   B ${b.zeroResultIds.length}   both ${a.zeroResultIds.length - onlyA.length}`);
  if (onlyA.length === 0 && onlyB.length === 0) {
    w('                       The two sets are IDENTICAL.');
  } else {
    w(`                       only A: ${onlyA.length}${onlyA.length ? ` (${onlyA.slice(0, 5).join(', ')}${onlyA.length > 5 ? ', …' : ''})` : ''}`);
    w(`                       only B: ${onlyB.length}${onlyB.length ? ` (${onlyB.slice(0, 5).join(', ')}${onlyB.length > 5 ? ', …' : ''})` : ''}`);
  }
  w('                       Reported, never gated. A retriever that returns results');
  w('                       where the other returned none is a better retriever, not an');
  w('                       unpairable one — that query is exactly the difference the');
  w('                       test exists to measure.');
  w();
  w(`  re-derivation        both sides re-scored from the WRITTEN run file through`);
  w(`                       backend/eval/metrics.js (validated at 2.4), and each`);
  w(`                       aggregate asserted against its committed sidecar at EXACT`);
  w(`                       float equality. Passed.`);
  w();

  // --- 3. pre-registration --------------------------------------------------
  w('3. PRE-REGISTRATION');
  w(thin);
  if (registration.entry) {
    w(`  status               PRE-REGISTERED — "${registration.entry.id}"`);
    if (registration.reversed) {
      w('                       (registered as B vs A; only the sign of the difference');
      w('                        changes, and this report names its own direction)');
    }
    w(`  registry             ${path.relative(REPO_ROOT, REGISTRY_FILE)}`);
    w(`  primary metric       ${registration.primary.metric.toUpperCase()}@${registration.primary.k}`);
    if (registration.entry.primaryMetricOverride) {
      w('                       declared in advance, overriding the family default of ' +
        `${registration.registry.primaryMetric.metric.toUpperCase()}@${registration.registry.primaryMetric.k}:`);
      for (const line of registration.entry.primaryMetricOverride) {
        if (line !== '') w(`                         ${line}`);
      }
    }
    w(`  family               ${registration.registry.comparisons.length} registered comparisons`);
    w(`  correction           ${registration.registry.correction.method}, family-wise alpha ${registration.registry.correction.familyWiseAlpha}`);
    w('                       NOT applied here. Holm needs every p in the family at once,');
    w('                       and the family fills up one rung per session across Phase 3.');
    w('                       The p below is RAW. Adjust when the family is complete.');
    if (registration.entry.caveat) {
      w();
      for (const line of registration.entry.caveat) w(`                       ${line}`);
    }
  } else if (registration.otherSplit) {
    w(`  status               OFF-SPLIT — registered as "${registration.otherSplit.id}", but on ` +
      `${registration.otherSplit.split}, not ${args.split}.`);
    w(`  registry             ${path.relative(REPO_ROOT, REGISTRY_FILE)}`);
    w(`  family               ${registration.registry.comparisons.length} registered comparisons; this pair is one of`);
    w(`                       them, registered on ${registration.otherSplit.split}`);
    w();
    w('  Differences and intervals below are printed in full. The p-value is SUPPRESSED,');
    w('  and the reason is not that nobody thought about this comparison — it is that the');
    w(`  experiment was registered on ${registration.otherSplit.split} and a p computed here would be a second,`);
    w('  unregistered test of the same hypothesis on fresh data. §11.5: the family is');
    w('  CONSTRAINED first and corrected second, and the constraint includes the split.');
    w('  Read the interval. If it excludes zero, that is a real statement about this');
    w('  split; it is just not the pre-registered one, and it does not enter Holm.');
  } else {
    w('  status               EXPLORATORY — this pair is not in the registry.');
    w(`  registry             ${path.relative(REPO_ROOT, REGISTRY_FILE)}`);
    w(`  family               ${registration.registry.comparisons.length} registered comparisons, none matching`);
    w('                       (' + `${a.label} vs ${b.label} on ${args.split}` + ')');
    w();
    w('  Differences and intervals below are printed in full. p-values are SUPPRESSED.');
    w('  Six rungs is 15 pairwise comparisons; times 13 metrics is 195 p-values, about');
    w('  10 of which come up significant at 0.05 on pure noise. To make this comparison');
    w('  testable, add it to the registry and commit — which puts the decision in git');
    w('  history, dated, which is the only thing that makes a pre-registration credible.');
  }
  w();

  // --- 4. the grid ----------------------------------------------------------
  w('4. DIFFERENCES AND 95% INTERVALS, EVERY METRIC');
  w(thin);
  w('  metric        mean A     mean B        A − B    95% CI              differ   p');
  w('  ' + '-'.repeat(76));
  for (const row of results) {
    const isPrimary = row.key === primaryKey;
    const pCell = !registration.entry ? '   -' : isPrimary ? formatP(row.boot) : '   .';
    w(
      `  ${(isPrimary ? '*' : ' ')}${row.name.padEnd(11)}` +
      `${fmt(row.meanA).padStart(7)}   ` +
      `${fmt(row.meanB).padStart(7)}   ` +
      `${signed(row.boot.observedMeanDifference).padStart(9)}   ` +
      `[${signed(row.boot.ci[0])}, ${signed(row.boot.ci[1])}]  ` +
      `${String(row.boot.differing).padStart(5)}   ` +
      pCell
    );
  }
  w();
  w('  * = the pre-registered primary metric. p is reported for that metric only.');
  w('  . = computed but not reported: one pre-registered metric per comparison is what');
  w('      keeps a p-value from being read thirteen times. The CI is the honest summary');
  w('      for every other row, and it is printed for all of them.');
  w();

  // --- 5. the primary result ------------------------------------------------
  const primary = results.find((r) => r.key === primaryKey);
  w(`5. PRIMARY RESULT — ${primary.name}`);
  w(thin);
  const boot = primary.boot;

  /**
   * `reportP` is false on the family-default row printed under §5b. That block
   * is not a second hypothesis test — it is the check that an override's stated
   * mechanism held — so it gets the difference and the interval and no p-value.
   */
  const renderResult = (row, reportP) => {
  const boot = row.boot;
  const primary = row;
  if (boot.degenerate) {
    w(`  IDENTICAL — 0 of ${boot.n} queries differ at ${primary.name}.`);
    w();
    w(`  mean difference      ${fmt(boot.observedMeanDifference, 6)}`);
    w(`  ${Math.round(boot.ciLevel * 100)}% CI               [${fmt(boot.ci[0], 6)}, ${fmt(boot.ci[1], 6)}]    zero-width BY CONSTRUCTION,`);
    w('                                               not by resampling agreement');
    if (registration.entry && reportP) {
      w(`  p                    ${formatP(boot)}      every centred resample mean is exactly`);
      w('                                     0, so |mean*| >= |observed| holds for all');
      w('                                     B. This falls out of the ASL definition;');
      w('                                     it is not a special case in the code.');
    } else if (reportP) {
      w('  p                    suppressed (exploratory)');
    } else {
      w('  p                    not reported — see the heading above');
    }
    w();
    w(`  What this says: the two runs rank identically at k=${primary.k}. It is NOT evidence`);
    w('  that the two retrievers are equivalent — look at the same pair at a larger k');
    w('  before concluding anything. No bootstrap can distinguish two vectors that are');
    w('  the same vector, and reporting a p-value here as though it had resolved');
    w('  something would be the failure this case was chosen to catch.');
  } else {
    const better = boot.observedMeanDifference > 0 ? a.label : b.label;
    const worse = boot.observedMeanDifference > 0 ? b.label : a.label;
    const magnitude = Math.abs(boot.observedMeanDifference);
    w(`  mean difference      ${signed(boot.observedMeanDifference, 6)}`);
    w(`  ${Math.round(boot.ciLevel * 100)}% CI               [${signed(boot.ci[0], 6)}, ${signed(boot.ci[1], 6)}]`);
    if (registration.entry && reportP) {
      w(`  p (two-sided ASL)    ${formatP(boot)}  +/- ${fmt(boot.pMonteCarloSe)} Monte Carlo`);
      w(`                       floor ${boot.pFloor.toFixed(5)} at B = ${boot.resamples}; the bootstrap has no`);
      w('                       standing to resolve below that and does not print 0');
    } else if (reportP) {
      w('  p                    suppressed (exploratory — see §3)');
    } else {
      w('  p                    not reported — see the heading above');
    }
    w();
    w(`  queries differing    ${boot.differing} of ${boot.n} (${((boot.differing / boot.n) * 100).toFixed(1)}%)`);
    w(`                       ${a.label} ahead on ${boot.aBetter}, ${b.label} ahead on ${boot.bBetter}`);
    w(`  effective n          ${boot.differing} — the CLT here runs on the queries that moved,`);
    w(`                       not on all ${boot.n}. This is why the test is a bootstrap and`);
    w('                       not a paired t-test: a point mass at zero with a thin slab');
    w('                       is where the normal approximation to the mean is worst.');
    w(`  mean over those      ${signed(boot.meanOverDiffering, 6)} — the overall mean is this number`);
    w(`                       diluted by the ${boot.n - boot.differing} queries at exactly zero`);
    w();
    // The sentence names the winner first, so when the difference is negative
    // it swaps A and B — and the interval has to be re-expressed in that same
    // swapped direction, which is a NEGATION AND A SWAP OF THE ENDPOINTS,
    // [lo, hi] -> [-hi, -lo]. §11.2 proved that mirrors exactly, which is the
    // property that lets the registry accept a pair in either direction.
    //
    // FIXED AT 3.6, AND IT HAD REACHED TWO COMMITTED ARTIFACTS. This line used
    // to build the interval as [min(|lo|,|hi|), max(|lo|,|hi|)]. That agrees
    // with the negate-and-swap above whenever both endpoints share a sign, and
    // is nonsense the moment the interval STRADDLES ZERO: it drops the minus
    // and reports [0.0045, 0.0058] for a true [-0.004541, +0.005812]. The
    // corruption therefore struck only nulls, and only in the one line most
    // likely to be quoted, while the grid and the §5 header above it stayed
    // correct. §18.5a's fusion ablation and §18.6's tuned-vs-v5 comparison are
    // the two committed reports it reached; both are regenerated, and the prose
    // that cites them was never wrong because it quoted the §5 header.
    const [sentLo, sentHi] = sentenceInterval(boot.observedMeanDifference, boot.ci);
    w('  THE SENTENCE:');
    w(`    ${better} beats ${worse} by ${magnitude.toFixed(4)} ${primary.name},`);
    w(`    ${Math.round(boot.ciLevel * 100)}% CI [${signed(sentLo, 4)}, ${signed(sentHi, 4)}]` +
      (registration.entry && reportP ? `, p = ${formatP(boot)}.` : ' (p not reported).'));
    if (boot.ci[0] <= 0 && boot.ci[1] >= 0) {
      w();
      w('    The interval STRADDLES ZERO. Whatever the p-value says, the data is');
      w('    consistent with no difference at all, and the sentence above should not');
      w('    be written anywhere without this line beside it.');
    }
  }
  };

  renderResult(primary, true);
  w();

  // --- 5b. the metric the override moved away from --------------------------
  //
  // Printed ONLY when the registry entry declares a primaryMetricOverride. An
  // override is a claim that the family-default metric cannot see the effect;
  // this is that claim checked rather than asserted, on the same run, in the
  // same report. It is NOT a second hypothesis test and it carries no p-value —
  // one pre-registered p per comparison is the whole point of §3.
  //
  // It is also the path that exercises the degenerate branch above in
  // production output rather than only in the unit tests, which matters because
  // the all-zero difference vector is the case a significance harness is most
  // likely to get catastrophically wrong.
  const defaultKey = `${registration.registry.primaryMetric.metric}@${registration.registry.primaryMetric.k}`;
  const defaultRow = results.find((r) => r.key === defaultKey);
  if (registration.entry?.primaryMetricOverride && defaultRow && defaultRow !== primary) {
    w(`5b. THE METRIC THE OVERRIDE MOVED AWAY FROM — ${defaultRow.name}`);
    w(thin);
    w(`  The family default is ${defaultRow.name}; this comparison declared ${primary.name} instead,`);
    w('  in advance, on the mechanical grounds quoted in §3. Here is that ground');
    w('  checked rather than asserted. No p-value: this is not a second test, and one');
    w('  pre-registered p per comparison is what §3 exists to enforce.');
    w();
    renderResult(defaultRow, false);
    w();
  }

  // --- 6. how the randomness is pinned --------------------------------------
  w('6. HOW THE RANDOMNESS IS PINNED');
  w(thin);
  w(`  prng                 ${boot.prng}, seeded — the same generator build-splits.js`);
  w('                       uses at 1.4. Math.random() cannot be seeded in Node, and a');
  w('                       p-value that changes between runs is not a result.');
  w(`  seed                 ${boot.seed}`);
  w(`  resamples            ${boot.resamples}`);
  w('                       chosen against the sampling error it estimates, not by');
  w('                       convention: at p ~= 0.05 the Monte Carlo standard error is');
  w('                       sqrt(0.05 * 0.95 / B) = 0.0022 here, which resolves the 0.05');
  w('                       threshold to about ± 0.004 — enough to decide significance,');
  w('                       not enough to justify a third decimal. The se is printed');
  w('                       above so that is visible rather than trusted.');
  w(`  interval             percentile, over the ${boot.resamples} resampled means, as a pair of`);
  w('                       order statistics at index floor(alpha/2 * B) and its mirror');
  w('                       B-1-that. Symmetric by construction, so comparing A against');
  w('                       B and B against A give exactly mirrored intervals — the');
  w('                       registry accepts a registered pair in either direction, so');
  w('                       both orders will be run. The obvious nearest-rank convention');
  w('                       is off by one order statistic under that swap; a mirror test');
  w('                       caught it, worth ~2e-4 on real dev data.');
  w('  p-value              centred (shifted) bootstrap ASL — differences shifted to');
  w('                       mean zero under H0, then |mean*| >= |observed| counted, with');
  w('                       the (1+r)/(B+1) convention. Smucker, Allan & Carterette');
  w('                       (2007). NOT the interval inversion PRIMER §5.5 describes;');
  w(`                       that reading is the raw count below.`);
  w(`  resamples favouring  A ${boot.resamplesFavouringA}   B ${boot.resamplesFavouringB}   tied ${boot.resamplesTied}`);
  w('                       PRIMER §5.5\'s "9,800 of 10,000 still ahead" reading, under');
  w('                       its own name. Deliberately not labelled a second p-value:');
  w('                       two p-values in one report is an invitation to quote the');
  w('                       smaller one.');
  w();

  // --- 7. environment -------------------------------------------------------
  const git = gitProvenance();
  w('7. ENVIRONMENT');
  w(thin);
  w(`  node                 ${process.version}`);
  w(`  platform             ${os.platform()} ${os.release()} ${os.arch()}`);
  w(`  git commit           ${git.commit}${git.dirty ? '  (tracked files dirty)' : ''}`);
  w(`  scorer               backend/eval/metrics.js — validated against pytrec_eval at`);
  w('                       2.4, max |delta| 1.11e-16. results/metric-validation.txt');
  w(`  bootstrap            backend/eval/bootstrap.js`);
  w();
  w('  Absolute figures remain LOWER BOUNDS (EVALUATION.md §5.1): the judgments are');
  w('  positive-only and incomplete, so an unjudged relevant document scores as a miss.');
  w('  The DIFFERENCE above is the number that survives that, because both runs face the');
  w('  identical incomplete key. Validation and incompleteness are two separate');
  w('  qualifiers and neither one retires the other.');
  w();
  w(rule);

  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  const qrelsFile = path.join(REPO_ROOT, 'data', 'qrels', `${args.site}.qrels`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${args.site}.${args.split}.txt`);
  for (const file of [qrelsFile, splitFile]) {
    if (!fs.existsSync(file)) {
      fail(`${path.relative(REPO_ROOT, file)} does not exist. See docs/EVALUATION.md §1.`);
    }
  }

  console.log(`compare ${args.a} vs ${args.b} on ${args.site}.${args.split}\n`);

  const queryIds = readLines(splitFile).filter((line) => line !== '');
  const qrels = loadQrels(qrelsFile);

  const a = loadSide(args.a, args, queryIds, qrels);
  const b = loadSide(args.b, args, queryIds, qrels);

  assertMatchesSidecar(a, args.ks);
  assertMatchesSidecar(b, args.ks);
  assertPairable(a, b, queryIds);

  const registration = lookUpRegistration(args.a, args.b, args.split);

  // The metric grid. Every row gets a bootstrap; only the primary row's p-value
  // is printed. Computing them all and reporting one is deliberate — the cost
  // is milliseconds and the alternative is not knowing whether the primary row
  // is representative.
  const rows = [];
  for (const k of args.ks) rows.push({ key: `ndcg@${k}`, name: `nDCG@${k}`, k, pick: (q) => q.ndcg[k] });
  for (const k of args.ks) rows.push({ key: `p@${k}`, name: `P@${k}`, k, pick: (q) => q.p[k] });
  for (const k of args.ks) rows.push({ key: `r@${k}`, name: `R@${k}`, k, pick: (q) => q.r[k] });
  const kMax = Math.max(...args.ks);
  rows.push({ key: `mrr@${kMax}`, name: `MRR@${kMax}`, k: kMax, pick: (q) => q.mrr });

  const results = rows.map((row) => {
    const differences = [];
    let meanASum = 0;
    let meanBSum = 0;
    let counted = 0;
    for (let i = 0; i < queryIds.length; i += 1) {
      const qa = a.perQuery[i];
      const qb = b.perQuery[i];
      // Unjudgeable queries return null and are excluded from BOTH sides
      // together, so the paired population is the same population the aggregate
      // means used. metrics.js §aggregate makes that decision once, up front,
      // rather than per metric; this mirrors it rather than re-deciding it.
      const va = row.pick(qa);
      const vb = row.pick(qb);
      if (va === null || va === undefined || vb === null || vb === undefined) continue;
      differences.push(va - vb);
      meanASum += va;
      meanBSum += vb;
      counted += 1;
    }
    return {
      ...row,
      meanA: counted === 0 ? null : meanASum / counted,
      meanB: counted === 0 ? null : meanBSum / counted,
      boot: pairedBootstrap(differences, {
        seed: args.seed,
        resamples: args.resamples,
        alpha: args.alpha
      })
    };
  });

  const primaryKey = `${registration.primary.metric}@${registration.primary.k}`;
  if (!results.some((r) => r.key === primaryKey)) {
    fail(
      `the registry names ${primaryKey.toUpperCase()} as the primary metric, but this run reports ` +
      `only k in {${args.ks.join(', ')}}.`
    );
  }

  const report = buildReport({ a, b, args, registration, results, primaryKey, queryIds });
  console.log(report);

  if (args.write) {
    const outFile = path.join(
      REPO_ROOT, 'results', 'comparisons', `${args.a}-vs-${args.b}.${args.split}.txt`
    );
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const temp = `${outFile}.tmp`;
    const fd = fs.openSync(temp, 'w');
    try {
      fs.writeFileSync(fd, report);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, outFile);
    console.log(`  written to ${path.relative(REPO_ROOT, outFile)}`);
  }
}

// Guarded so tests/compare-sentence.test.js can require this file for the one
// pure function it exports without running a comparison as a side effect. The
// CLI behaviour is unchanged: `node scripts/compare-runs.js ...` is still the
// main module and still runs.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\ncompare failed: ${err.message}`);
    if (!err.assertion) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { sentenceInterval };
