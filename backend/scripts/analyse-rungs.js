'use strict';

/**
 * analyse-rungs.js — the stratified and mechanism analysis behind a ladder
 * comparison. Phase 3.1, generalised so later rungs do not rewrite it.
 *
 *   npm run analyse:rungs -- --a v2-jaccard --b v1-overlap --split dev
 *
 * WHY THIS IS A COMMITTED SCRIPT AND NOT A ONE-OFF. EVALUATION.md §14.6 quotes
 * a stratified table and a retrieved-document-length distribution, and
 * CLAUDE.md's rule is that a number is not claimable without the file it came
 * from. compare-runs.js answers "is the difference real"; it deliberately does
 * not answer "where did the difference come from", because that question is
 * per-rung and would bloat the significance report. So it lives here.
 *
 * READ-ONLY, on the same reasoning as analyze-ground-truth.js at 1.5: it
 * describes artifacts whose SHA-256s are published, and a script that only
 * reads cannot invalidate the thing it describes. It writes nothing and it is
 * not in any number's provenance chain — it re-derives from the written run
 * files through the same validated metrics.js the runner used.
 *
 * IT DUPLICATES THE RUN/QRELS LOADERS, and that is the standing decision
 * recorded at §11.1 rather than a new one: scripts/emit-per-query-scores.js is
 * part of §10's evidence chain, and refactoring it to serve another caller
 * would mean the validated artifact and the audited artifact stop being the
 * same bytes. The duplication is checked rather than trusted — the aggregate
 * re-derived here is asserted against each run's committed sidecar at exact
 * float equality, so a divergent parse fails loudly.
 *
 * NOTE the loaders read the RANK column, not the score column. retrieval/
 * index.js fixed the order before the file was written (descending score, then
 * lexicographic on the id), and v1's scores take only 18 distinct values across
 * dev, so 88% of adjacent pairs are score ties whose order is not recoverable
 * from the score column at all. §10.2.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE STRATIFICATION AXIS MOVED TO THE CORPUS AT 3.4. 3.2 deferred the decision
 * to 3.4; 3.3 recorded that it had survived only by luck.
 *
 * The axis used to be the RETRIEVER's `termCount()`. That worked while every
 * rung represented a document as terms, and 3.3 noted it held for v4 only
 * because v4's distinct-term count happens to equal v3's. V5 HAS NO TERMS AT
 * ALL — it is 384 floats — so there was nothing left to defer.
 *
 *   default   --axis corpus-terms     distinct tokens under the ladder's shared
 *                                     tokenise(), over title + ' ' + body,
 *                                     computed HERE from the corpus
 *   opt-in    --axis retriever-terms  the pre-3.4 behaviour
 *
 * Three reasons the corpus is the right owner, in increasing order of weight:
 *   1. it exists for every rung, including ones with no term space;
 *   2. it is identical across the two rungs BY CONSTRUCTION, so the strata are
 *      like-for-like rather than accidentally so — which is all §16.10 had;
 *   3. the script no longer calls index() merely to obtain a histogram. That
 *      call was about to become circular: indexing v5 requires vectors, so an
 *      analysis tool would have needed the corpus-preparation pipeline to
 *      produce a table about document lengths.
 *
 * WHAT IT COSTS, AND IT IS NOT NOTHING. v1's and v2's termCount is a top-10
 * SELECTION length capped at 10, so their `d <= 6` stratum is a real regime of
 * their own admission rule (§7.7, §13.8) that a corpus axis cannot express.
 * `--axis retriever-terms` reproduces §14.6 exactly and §14.6 carries a ↳ to
 * say so. For v3, v4 and v5 the two axes are the SAME QUANTITY — v3's and v4's
 * termCount already returned distinct tokens — so §16.10's table is unchanged,
 * which is verified by re-running it rather than assumed.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const metrics = require('../eval/metrics');
const retrieval = require('../retrieval');

const DEFAULT_KS = [1, 5, 8, 10];
const PRIMARY_K = 8; // the pre-registered primary metric's k. §11.5.

function fail(message) {
  console.error(`\nanalyse-rungs: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { site: 'cooking', split: 'dev', axis: 'corpus-terms' };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--a' && value) { args.a = value; i += 1; }
    else if (flag === '--b' && value) { args.b = value; i += 1; }
    else if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--axis' && value) { args.axis = value; i += 1; }
    else if (flag.startsWith('--')) fail(`unknown flag ${flag}`);
  }
  if (!args.a || !args.b) fail('need --a <label> and --b <label>');
  if (!['corpus-terms', 'retriever-terms'].includes(args.axis)) {
    fail(`--axis must be corpus-terms (default, 3.4 onward) or retriever-terms (pre-3.4), got ${args.axis}`);
  }
  return args;
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');

function readOrFail(file) {
  if (!fs.existsSync(file)) {
    fail(
      `${path.relative(REPO_ROOT, file)} does not exist.\n` +
      `  Run files are gitignored and regenerate in ~2.5 s (EVALUATION.md §8.5):\n` +
      `    npm run eval -- --retriever <version> --split <split>`
    );
  }
  return file;
}

/** run file -> Map<qid, docid[]>, ordered by the RANK column. */
function loadRun(file) {
  const byQuery = new Map();
  for (const line of lines(readOrFail(file))) {
    const [qid, , docid, rank] = line.split(/\s+/);
    if (!byQuery.has(qid)) byQuery.set(qid, []);
    byQuery.get(qid).push({ docid, rank: Number.parseInt(rank, 10) });
  }
  for (const [qid, rows] of byQuery) {
    rows.sort((x, y) => x.rank - y.rank);
    byQuery.set(qid, rows.map((r) => r.docid));
  }
  return byQuery;
}

function loadSide(label, split) {
  const runFile = path.join(REPO_ROOT, 'results', 'runs', `${label}.${split}.run`);
  const sidecarFile = `${runFile}.json`;
  if (!fs.existsSync(sidecarFile)) fail(`${path.relative(REPO_ROOT, sidecarFile)} does not exist.`);
  return { label, run: loadRun(runFile), sidecar: JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { site, split } = args;

  // --- inputs, the same three the runner asserts over
  const corpus = lines(readOrFail(path.join(REPO_ROOT, 'data', 'corpus', `${site}.jsonl`)))
    .map((l) => JSON.parse(l));
  const docs = corpus.map((d) => ({ id: String(d.id), title: d.title, body: d.body }));
  const corpusIds = new Set(docs.map((d) => d.id));

  const qrels = new Map();
  for (const line of lines(readOrFail(path.join(REPO_ROOT, 'data', 'qrels', `${site}.qrels`)))) {
    const [qid, , docid, grade] = line.split(/\s+/);
    if (!corpusIds.has(docid)) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(docid, Number.parseInt(grade, 10));
  }
  const queryIds = lines(readOrFail(path.join(REPO_ROOT, 'data', 'splits', `${site}.${split}.txt`)));

  const A = loadSide(args.a, split);
  const B = loadSide(args.b, split);

  // --- per-query scores, re-derived through the validated scorer
  const scoreOf = (side, qid) =>
    metrics.scoreQuery(side.run.get(qid) || [], qrels.get(qid) || new Map(), DEFAULT_KS);

  const perQuery = { [A.label]: [], [B.label]: [] };
  const rows = queryIds.map((qid) => {
    const sa = scoreOf(A, qid);
    const sb = scoreOf(B, qid);
    perQuery[A.label].push(sa);
    perQuery[B.label].push(sb);
    return { qid, a: sa.ndcg[PRIMARY_K], b: sb.ndcg[PRIMARY_K] };
  });

  // --- the guard §11.1 requires: a divergent parse must fail loudly
  for (const side of [A, B]) {
    const got = metrics.aggregate(perQuery[side.label], DEFAULT_KS).ndcg[PRIMARY_K];
    const want = side.sidecar.metrics.ndcg[String(PRIMARY_K)];
    if (got !== want) {
      fail(
        `${side.label}: re-derived nDCG@${PRIMARY_K} ${got} does not equal its committed\n` +
        `  sidecar's ${want} at exact float equality. The run file and the sidecar came\n` +
        `  from different runs, or this file's parse has drifted from the runner's.`
      );
    }
  }

  // --- term counts, from the retriever rather than re-tokenised here.
  //
  // This read `handle._state.keywordsById` directly until 3.2, and it CRASHED
  // on v3 — the first rung that does not represent a document as a keyword
  // list. Reaching into another module's private state was the defect; the fix
  // is the optional `termCount` accessor on the Retriever contract, with the
  // old path kept as a named fallback for the rungs written before it existed.
  //
  // The old comment claimed "both rungs must share the keyword stage for this
  // to be one number; asserted". It was not asserted, and for v3-vs-v2 it is
  // FALSE: v1/v2 report a top-10 selection length (capped at 10, and 96.1% of
  // the corpus sits exactly there) while v3 reports distinct terms (mean 36.5,
  // max 1,021). So the two are computed separately, compared, and the source is
  // printed — a `d <= 6` stratum does not mean the same thing either side.
  // THE CORPUS AXIS (default from 3.4). Distinct tokens under the ladder's
  // shared tokenise() — the same quantity v3's and v4's termCount() return, so
  // §16.10 is unchanged, and one that exists for a rung with no term space at
  // all. Computed once and shared by both sides, which is what makes the strata
  // like-for-like by construction rather than by luck.
  const corpusTerms = () => {
    const { tokenise } = require('../retrieval/v1-overlap');
    return {
      by: new Map(docs.map((d) => [d.id, new Set(tokenise(`${d.title || ''} ${d.body || ''}`)).size])),
      how: 'distinct corpus tokens (tokenise over title + body)'
    };
  };

  const retrieverTerms = (version) => {
    const retriever = retrieval.versions().includes(version) ? require(`../retrieval/${version}`) : null;
    if (retriever && typeof retriever.termCount === 'function') {
      const handle = retrieval.index(version, docs);
      return { by: new Map(docs.map((d) => [d.id, retriever.termCount(handle._state, d.id)])), how: 'termCount()' };
    }
    const handle = retrieval.index(version, docs);
    if (handle._state.keywordsById) {
      return {
        by: new Map(docs.map((d) => [d.id, handle._state.keywordsById.get(d.id).length])),
        how: 'keyword-list length (pre-3.2 fallback)'
      };
    }
    fail(
      `--axis retriever-terms: ${version} exposes neither termCount() nor keywordsById.\n` +
      '  v5 has no term space, which is why the default axis moved to the corpus at 3.4.\n' +
      '  Drop the flag to use --axis corpus-terms.'
    );
  };

  const shared = args.axis === 'corpus-terms' ? corpusTerms() : null;
  const countsA = shared || retrieverTerms(A.sidecar.retriever.version);
  const countsB = shared || retrieverTerms(B.sidecar.retriever.version);
  const kwLen = countsA.by;
  const countsAgree = docs.every((d) => countsA.by.get(d.id) === countsB.by.get(d.id));
  // The counts can disagree while the 6/7 BUCKETING still agrees, and on this
  // corpus they do: a top-10 selection length is min(10, distinct terms), so
  // below 10 the truncation does not bind and the two notions coincide exactly.
  // They diverge only above 10, which is on one side of the boundary. So the
  // stratified table stays like-for-like even when the histogram does not.
  const bucketsAgree = docs.every((d) => (countsA.by.get(d.id) <= 6) === (countsB.by.get(d.id) <= 6));

  const out = [];
  const w = (s = '') => out.push(s);
  const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
  const sum = (xs) => xs.reduce((t, x) => t + x, 0);

  w(`ANALYSE RUNGS — ${A.label} vs ${B.label} on ${site}.${split}`);
  w('='.repeat(78));
  w();
  w(`  A ${A.label}   digest ${A.sidecar.retriever.digest.slice(0, 16)}`);
  w(`  B ${B.label}   digest ${B.sidecar.retriever.digest.slice(0, 16)}`);
  w(`  ${queryIds.length} queries · primary metric nDCG@${PRIMARY_K}`);
  w(`  re-derived aggregates match both committed sidecars at exact float equality`);
  w();

  // --- 1. stratified by query term count
  w('1. STRATIFIED BY QUERY TERM COUNT');
  w('-'.repeat(78));
  w('  The d <= 6 stratum is where a length-dependent threshold behaves');
  w('  differently from a length-independent minShared. EVALUATION.md §7.7, §13.8.');
  w();
  w(`  axis  --axis ${args.axis}${args.axis === 'corpus-terms' ? '  (default from 3.4; one axis, computed from the corpus, shared by both sides)' : '  (pre-3.4 behaviour, reproduces §14.6)'}`);
  w(`  counts for A (${A.label}) via ${countsA.how}`);
  w(`  counts for B (${B.label}) via ${countsB.how}`);
  if (countsAgree) {
    w('  The two rungs assign every document the same count, so the strata below');
    w('  mean one thing and the comparison within them is like-for-like.');
  } else if (bucketsAgree) {
    w('  The two rungs disagree on the COUNT but agree on the 6/7 BUCKETING, on every');
    w('  document. That is forced rather than lucky: a top-10 selection length is');
    w('  min(10, distinct terms), so below 10 the truncation does not bind and the two');
    w('  notions coincide; they diverge only above 10, which is on one side of the');
    w('  boundary. The strata below are therefore still like-for-like.');
  } else {
    w('  !! THE TWO RUNGS DISAGREE ON THE BUCKETING, not only the count, so B\'s scores');
    w('     are being read inside A\'s buckets. Read the total; the split is descriptive.');
  }
  w();
  w('  stratum     n        B nDCG@8        A nDCG@8      moved   contribution');
  for (const [label, pred] of [['d <= 6', (r) => kwLen.get(r.qid) <= 6], ['d >= 7', (r) => kwLen.get(r.qid) >= 7]]) {
    const s = rows.filter(pred);
    if (s.length === 0) continue;
    const contribution = sum(s.map((r) => r.a - r.b)) / rows.length;
    w(
      `  ${label.padEnd(10)} ${String(s.length).padStart(4)}    ` +
      `${mean(s.map((r) => r.b)).toFixed(8)}      ${mean(s.map((r) => r.a)).toFixed(8)}   ` +
      `${String(s.filter((r) => r.a !== r.b).length).padStart(5)}    ${contribution >= 0 ? '+' : ''}${contribution.toFixed(8)}`
    );
  }
  w(`  ${''.padEnd(10)}                                                        ${'-'.repeat(12)}`);
  w(`  ${'total'.padEnd(10)}                                                        ` +
    `+${(sum(rows.map((r) => r.a - r.b)) / rows.length).toFixed(8)}`);
  w();

  // --- 2. direction of the queries that moved
  const moved = rows.filter((r) => r.a !== r.b);
  const up = moved.filter((r) => r.a > r.b);
  const down = moved.filter((r) => r.a < r.b);
  w('2. THE SHAPE OF THE DIFFERENCE');
  w('-'.repeat(78));
  w('  A minority of large wins is a more fragile result than a consistent');
  w('  direction, and the two are indistinguishable in the mean. §11.6, §14.4.');
  w();
  w(`  moved            ${moved.length} of ${rows.length} (${((moved.length / rows.length) * 100).toFixed(1)}%)`);
  w(`  A ahead on       ${up.length}   mean gain ${up.length ? `+${mean(up.map((r) => r.a - r.b)).toFixed(6)}` : '—'}`);
  w(`  B ahead on       ${down.length}   mean loss ${down.length ? mean(down.map((r) => r.a - r.b)).toFixed(6) : '—'}`);
  w();

  // --- 3. mechanism: keyword length of what each run RETRIEVED
  function retrievedLengths(side) {
    const counts = new Map();
    for (const qid of queryIds) {
      for (const docid of (side.run.get(qid) || []).slice(0, PRIMARY_K)) {
        counts.set(kwLen.get(docid), (counts.get(kwLen.get(docid)) || 0) + 1);
      }
    }
    return counts;
  }
  const la = retrievedLengths(A);
  const lb = retrievedLengths(B);
  w('3. MECHANISM — TERM LENGTH OF RETRIEVED DOCUMENTS');
  w('-'.repeat(78));
  w(`  Top ${PRIMARY_K}, whole run. A similarity function whose denominator reads the`);
  w('  TARGET\'s length will show up here and nowhere else in the metrics. §14.6.');
  w();
  // ONE yardstick for both sides — A's, named — so the two columns are
  // comparable. The BUCKETING adapts to it: a top-10 selection never exceeds
  // 10 and the per-value rows are the whole story, but a full-vocabulary count
  // runs to 1,021 and rows 1..10 would show a corner of the distribution while
  // looking complete. The v1/v2 output is unchanged, because there the
  // condition below is false.
  w(`  both columns measured with A's yardstick: ${countsA.how}`);
  const widest = Math.max(...[...la.keys()], ...[...lb.keys()]);
  const buckets = widest <= 10
    ? Array.from({ length: 10 }, (_, i) => [i + 1, i + 1, String(i + 1)])
    : [...Array.from({ length: 9 }, (_, i) => [i + 1, i + 1, String(i + 1)]),
       [10, 19, '10-19'], [20, 49, '20-49'], [50, Infinity, '50+']];
  w('   d        B count      A count        delta');
  for (const [lo, hi, label] of buckets) {
    const inRange = (m) => [...m].filter(([d]) => d >= lo && d <= hi).reduce((t, [, c]) => t + c, 0);
    const b = inRange(lb);
    const a = inRange(la);
    if (a === 0 && b === 0) continue;
    w(`  ${label.padStart(5)}   ${String(b).padStart(10)}   ${String(a).padStart(10)}   ${String(a - b).padStart(10)}`);
  }
  const shortOf = (m) => [...m].filter(([d]) => d <= 9).reduce((t, [, c]) => t + c, 0);
  w(`  d<=9 ${String(shortOf(lb)).padStart(11)}   ${String(shortOf(la)).padStart(10)}   ` +
    `${shortOf(lb) ? `${(shortOf(la) / shortOf(lb)).toFixed(2)}x` : '—'}`);
  w();

  // --- 4. zero-result queries, and their keyword lengths
  const zeroOf = (side) => queryIds.filter((q) => (side.run.get(q) || []).length === 0);
  const za = zeroOf(A);
  const zb = zeroOf(B);
  w('4. ZERO-RESULT QUERIES');
  w('-'.repeat(78));
  w('  Roadmap 7.1 wants a measured frequency AND a mechanism for each entry.');
  w();
  w(`  A ${String(za.length).padStart(4)}    B ${String(zb.length).padStart(4)}    both ${zb.filter((q) => za.includes(q)).length}`);
  for (const [side, list, other] of [['only A', za, zb], ['only B', zb, za]]) {
    const only = list.filter((q) => !other.includes(q));
    if (only.length === 0) { w(`  ${side}: none`); continue; }
    w(`  ${side}: ${only.length}`);
    for (const q of only.slice(0, 20)) {
      const opposite = side === 'only A' ? B : A;
      w(`    ${q}  d=${kwLen.get(q)}  the other run returned ${(opposite.run.get(q) || []).length}`);
    }
  }
  w();
  w('='.repeat(78));
  w('  Read-only. Nothing was written. Absolutes remain LOWER BOUNDS (§5.1).');

  console.log(out.join('\n'));
}

main();
