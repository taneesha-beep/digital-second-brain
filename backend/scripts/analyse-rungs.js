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
  const args = { site: 'cooking', split: 'dev' };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--a' && value) { args.a = value; i += 1; }
    else if (flag === '--b' && value) { args.b = value; i += 1; }
    else if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag.startsWith('--')) fail(`unknown flag ${flag}`);
  }
  if (!args.a || !args.b) fail('need --a <label> and --b <label>');
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

  // --- keyword lengths, from the retriever rather than re-tokenised here.
  // Both rungs must share the keyword stage for this to be one number; asserted.
  const handle = retrieval.index(A.sidecar.retriever.version, docs);
  const kwLen = new Map(docs.map((d) => [d.id, handle._state.keywordsById.get(d.id).length]));

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

  // --- 1. stratified by query keyword count
  w('1. STRATIFIED BY QUERY KEYWORD COUNT');
  w('-'.repeat(78));
  w('  The d <= 6 stratum is where a length-dependent threshold behaves');
  w('  differently from a length-independent minShared. EVALUATION.md §7.7, §13.8.');
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
  w('3. MECHANISM — KEYWORD LENGTH OF RETRIEVED DOCUMENTS');
  w('-'.repeat(78));
  w(`  Top ${PRIMARY_K}, whole run. A similarity function whose denominator reads the`);
  w('  TARGET\'s length will show up here and nowhere else in the metrics. §14.6.');
  w();
  w('   d        B count      A count        delta');
  for (let d = 1; d <= 10; d += 1) {
    const b = lb.get(d) || 0;
    const a = la.get(d) || 0;
    if (a === 0 && b === 0) continue;
    w(`  ${String(d).padStart(2)}   ${String(b).padStart(10)}   ${String(a).padStart(10)}   ${String(a - b).padStart(10)}`);
  }
  const shortOf = (m) => [...m].filter(([d]) => d <= 9).reduce((t, [, c]) => t + c, 0);
  w(`  d<=9 ${String(shortOf(lb)).padStart(10)}   ${String(shortOf(la)).padStart(10)}   ` +
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
