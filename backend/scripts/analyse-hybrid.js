'use strict';

/**
 * analyse-hybrid.js — the cost and shape of retriever v6. Phase 3.5.
 *
 *   npm run analyse:v6
 *   node --expose-gc scripts/analyse-hybrid.js     # adds the retained-heap figure
 *
 * READ-ONLY, on the same reasoning as analyse-bm25.js at 3.3, analyse-
 * embeddings.js at 3.4 and analyze-ground-truth.js at 1.5: it describes
 * artifacts whose SHA-256s are published, and a script that only reads cannot
 * invalidate the thing it describes. It exists because CLAUDE.md forbids
 * claiming a measured number without the file it came from, and 3.5's Done
 * criterion needs index build time, memory and p95 for a rung that carries two
 * indexes at once.
 *
 * WHAT IT ADDS THAT THE OTHER TWO DO NOT: the FUSION SHAPE. v6's whole claim is
 * that two systems failing on different queries can be combined, so the
 * question "where does the fused top-8 actually come from" is the rung's
 * mechanism rather than a curiosity. §17.9 measured the complementarity in
 * advance (mean top-8 Jaccard 0.1906, 9.6% disjoint); this measures what the
 * fusion did with it.
 *
 * IT ADDS NO FIFTH COPY OF THE LOADERS — scripts/lib/run-io.js, per 3.3's rule.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const retrieval = require('../retrieval');
const v6 = require('../retrieval/v6-hybrid');
const metrics = require('../eval/metrics');
const { readLines, loadQrels, loadRun } = require('./lib/run-io');

const SITE = process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : 'cooking';
const SPLIT = 'dev';

function fail(message) {
  console.error(`\nanalyse-hybrid: ${message}\n`);
  process.exit(1);
}

function loadDocsWithVectors(slug) {
  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${SITE}.jsonl`);
  const vectorsFile = path.join(REPO_ROOT, 'data', 'vectors', `${SITE}.${slug}.f32`);
  const manifestFile = path.join(REPO_ROOT, 'data', 'vectors', `${SITE}.${slug}.manifest.json`);
  for (const f of [corpusFile, vectorsFile, manifestFile]) {
    if (!fs.existsSync(f)) fail(`${path.relative(REPO_ROOT, f)} does not exist`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const docs = readLines(corpusFile).map((l) => JSON.parse(l));
  const dim = manifest.vectors.dim;
  const buffer = fs.readFileSync(vectorsFile);
  const all = new Float32Array(buffer.buffer, buffer.byteOffset, docs.length * dim);
  for (let i = 0; i < docs.length; i += 1) docs[i].vector = all.subarray(i * dim, (i + 1) * dim);
  return { docs, dim };
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function main() {
  const params = retrieval.resolvedParamsFor('v6-hybrid');
  const { docs, dim } = loadDocsWithVectors(params.vectors);
  const n = docs.length;
  const out = [];
  const w = (s = '') => { out.push(s); console.log(s); };

  w(`ANALYSE v6-hybrid — ${SITE}, N=${n}`);
  w('='.repeat(78));
  w();

  // --- 1. what it is ---------------------------------------------------------
  w('1. WHAT v6 IS');
  w('-'.repeat(78));
  w('  score(q,d) = SUM over r in {bm25, dense} of  1 / (rrfK + rank_r(q,d))');
  w();
  w(`  rrfK          ${params.rrfK}    the published default (Cormack et al. 2009). SHIPPED UNTUNED.`);
  w(`  fusion        ${params.fusion}`);
  w(`  depth         ${params.depth === null ? 'null (every candidate each component produces)' : params.depth}`);
  w(`  bm25 half     ${v6.BM25_PARAM_KEYS.map((k) => `${k}=${JSON.stringify(params[k])}`).join(' ')}`);
  w(`  dense half    ${v6.DENSE_PARAM_KEYS.map((k) => `${k}=${JSON.stringify(params[k])}`).join(' ')}`);
  w(`  symmetric     false`);
  w();
  w('  ASYMMETRIC, AND NOT ONLY BECAUSE BM25 IS. Rank is a property of a LIST,');
  w('  not of a pair: score(A->B) reads B\'s position in the lists ranked against');
  w('  A, score(B->A) reads A\'s position in different lists. A rank fusion of two');
  w('  perfectly score-symmetric retrievers would still be asymmetric — measured');
  w('  on v5 alone in tests/retrieval.symmetry.test.js.');
  w();

  // --- 2. index build --------------------------------------------------------
  const builds = [];
  let handle = null;
  for (let r = 0; r < 5; r += 1) {
    const t = process.hrtime.bigint();
    handle = retrieval.index('v6-hybrid', docs);
    builds.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const buildsSorted = [...builds].sort((a, b) => a - b);
  w('2. INDEX BUILD — both components, one handle');
  w('-'.repeat(78));
  w(`  five builds   ${builds.map((b) => b.toFixed(0)).join(' ')} ms`);
  w(`  median        ${buildsSorted[2].toFixed(0)} ms`);
  w('  reference     v4-bm25 982 ms (§16.12) · v5-embeddings 36 ms (§17.11) · v3 ~1,470 ms');
  w();
  w('  v6 builds BOTH, so its index time is close to the sum and is dominated by');
  w('  BM25\'s postings. Nothing here is new work — it is v4\'s build and v5\'s');
  w('  build, run back to back inside one buildIndex().');
  w();

  // --- 3. memory -------------------------------------------------------------
  const bm25Typed = (() => {
    const s = handle._state.bm25State;
    let postings = 0;
    for (let t = 0; t < s.postingsDocs.length; t += 1) postings += s.postingsDocs[t].byteLength + s.postingsTfs[t].byteLength;
    let perDoc = 0;
    for (let i = 0; i < s.n; i += 1) perDoc += s.docTerms[i].byteLength + s.docTfs[i].byteLength;
    return postings + perDoc + s.lengths.byteLength + s.lengthRatioMinus1.byteLength +
      s.idf.byteLength + s._acc.byteLength + s._shared.byteLength + s._touched.byteLength;
  })();
  const denseTyped = (n * dim * 4) + (n * 8);

  w('3. MEMORY — three numbers that must not be conflated, and v6 carries two indexes');
  w('-'.repeat(78));
  w(`  typed arrays, computed from the structures    ${((bm25Typed + denseTyped) / 1024 ** 2).toFixed(2)} MiB`);
  w(`    bm25 half   ${(bm25Typed / 1024 ** 2).toFixed(2)} MiB   postings, per-doc terms/tfs, lengths, idf, scratch`);
  w(`    dense half  ${(denseTyped / 1024 ** 2).toFixed(2)} MiB   matrix ${n} x ${dim} x 4B, norms ${n} x 8B`);
  if (typeof global.gc === 'function') {
    // DROP THE TIMING HANDLES FIRST, AND COLLECT TWICE. The five builds above
    // leave four dead v6 indexes holding ~56 MiB of ArrayBuffer each, and V8
    // releases external backing stores a collection LATER than it releases the
    // objects pointing at them. Measured with `handle` still live and one gc,
    // this reported 1.4 MiB of arrayBuffers for a structure containing a 40 MiB
    // matrix — the `before` snapshot was inflated by garbage that the `after`
    // snapshot had finally released, so the delta came out near zero. That is
    // the §17.11 trap in a second costume: the first number this section
    // produced was wrong, and it is recorded rather than quietly corrected.
    handle = null;
    global.gc();
    global.gc();
    const before = process.memoryUsage();
    const held = retrieval.index('v6-hybrid', docs);
    global.gc();
    global.gc();
    const after = process.memoryUsage();
    const heapDelta = after.heapUsed - before.heapUsed;
    const bufferDelta = after.arrayBuffers - before.arrayBuffers;
    // Reused below rather than discarded, so section 4 does not build a seventh.
    handle = held;
    w(`  retained for one handle (--expose-gc)         ${((heapDelta + bufferDelta) / 1024 ** 2).toFixed(1)} MiB`);
    w(`    of which V8 heap      ${(heapDelta / 1024 ** 2).toFixed(1)} MiB   BM25's vocabulary Map and df Map, the id Maps`);
    w(`    of which arrayBuffers ${(bufferDelta / 1024 ** 2).toFixed(1)} MiB   the dense matrix, the postings`);
    w(`    (handle held live across the measurement: ${held.docCount} docs)`);
    w();
    w('    BOTH TERMS, because §17.11 got this wrong first and recorded it. A');
    w('    large typed array\'s backing store lives OUTSIDE the V8 heap, so');
    w('    heapUsed alone understated v5 by 20x. v6 is the rung where the trap is');
    w('    worst, because it mixes the two: BM25\'s 34,928-string vocabulary Map is');
    w('    genuinely on the heap while the 40 MiB dense matrix is not. Quoting');
    w('    either term alone would be wrong in a different direction.');
  } else {
    w('  retained for one handle                       re-run with `node --expose-gc` to measure');
  }
  // From the RUN's sidecar, not from this process. §16.12's 650 MiB and §17.11's
  // 325 MiB are both "peak RSS for the eval process"; this script builds six
  // indexes to time them, so its own RSS is a different and larger quantity that
  // would not be comparable to either.
  const evalSidecar = path.join(REPO_ROOT, 'results', 'runs', `v6-hybrid.${SPLIT}.run.json`);
  const evalRss = fs.existsSync(evalSidecar)
    ? JSON.parse(fs.readFileSync(evalSidecar, 'utf8')).environment.peakRssMiB
    : null;
  w(`  peak RSS for the EVAL process                 ${evalRss === null ? '(run v6-hybrid first)' : `${evalRss} MiB`}`);
  w(`    (this analysis process peaks at ${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)} MiB — it builds six indexes to time`);
  w('     them, so its own RSS is not the comparable quantity)');
  w();
  w('  The third is dominated by the parsed corpus, which EVERY rung pays and');
  w('  which is not part of the index. §16.12 made the same separation for v4,');
  w('  where quoting RSS as "BM25\'s memory" would have been wrong by 19x.');
  w();

  // --- 4. search -------------------------------------------------------------
  const queryIds = readLines(path.join(REPO_ROOT, 'data', 'splits', `${SITE}.${SPLIT}.txt`));
  const latencies = new Float64Array(queryIds.length);
  for (let i = 0; i < queryIds.length; i += 1) {
    const t = process.hrtime.bigint();
    retrieval.search(handle, queryIds[i], 10);
    latencies[i] = Number(process.hrtime.bigint() - t) / 1e6;
  }
  const sortedLat = Float64Array.from(latencies).sort();
  w('4. SEARCH — the slowest rung on the ladder, and why');
  w('-'.repeat(78));
  w(`  per query     mean ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)} ms · p50 ${quantile(sortedLat, 0.5).toFixed(2)} · p95 ${quantile(sortedLat, 0.95).toFixed(2)} ms`);
  w('  reference     v5 20.4 ms · v4 7.9 ms · v3 8.1 ms · v2 0.87 ms · v1 1.0 ms');
  w();
  w('  v6 pays BOTH component searches plus THREE large sorts where v5 pays one:');
  w('  each component list is ordered internally (so the ranks it fuses are the');
  w('  ranks a standalone run produces), and the interface then sorts the fused');
  w('  list. Uncontrolled laptop figures on every rung; 6.5 owns the controlled');
  w('  one. No performance claim is made from this number.');
  w();

  // --- 5. the fusion shape — the rung's mechanism ----------------------------
  const runFile = (label) => path.join(REPO_ROOT, 'results', 'runs', `${label}.${SPLIT}.run`);
  const haveRuns = ['v4-bm25', 'v5-embeddings', 'v6-hybrid'].every((l) => fs.existsSync(runFile(l)));
  if (haveRuns) {
    const bm25Run = loadRun(runFile('v4-bm25'));
    const denseRun = loadRun(runFile('v5-embeddings'));
    const fusedRun = loadRun(runFile('v6-hybrid'));

    // Where does the fused top-8 come from? A document is attributed to the
    // component(s) whose top-8 already held it; "neither" means the fusion
    // PROMOTED it from below both cut-offs, which is the case RRF is for.
    let fromBoth = 0;
    let fromBm25Only = 0;
    let fromDenseOnly = 0;
    let fromNeither = 0;
    let total = 0;
    let jacV5 = 0;
    let jacV4 = 0;
    let counted = 0;
    for (const qid of queryIds) {
      const f = (fusedRun.get(qid) || []).slice(0, 8);
      const a = new Set((bm25Run.get(qid) || []).slice(0, 8));
      const b = new Set((denseRun.get(qid) || []).slice(0, 8));
      for (const d of f) {
        total += 1;
        const inA = a.has(d);
        const inB = b.has(d);
        if (inA && inB) fromBoth += 1;
        else if (inA) fromBm25Only += 1;
        else if (inB) fromDenseOnly += 1;
        else fromNeither += 1;
      }
      const sf = new Set(f);
      const inter = (s) => { let c = 0; for (const d of sf) if (s.has(d)) c += 1; return c; };
      if (sf.size > 0) {
        const iB = inter(b);
        const iA = inter(a);
        jacV5 += iB / (sf.size + b.size - iB);
        jacV4 += iA / (sf.size + a.size - iA);
        counted += 1;
      }
    }
    const pct = (x) => `${(100 * x / total).toFixed(1)}%`;
    w('5. THE FUSION SHAPE — where the fused top-8 comes from');
    w('-'.repeat(78));
    w(`  documents in v6's top-8, over ${queryIds.length} queries: ${total}`);
    w(`    in BOTH components' top-8      ${String(fromBoth).padStart(6)}  ${pct(fromBoth)}`);
    w(`    in the DENSE top-8 only        ${String(fromDenseOnly).padStart(6)}  ${pct(fromDenseOnly)}`);
    w(`    in the BM25 top-8 only         ${String(fromBm25Only).padStart(6)}  ${pct(fromBm25Only)}`);
    w(`    in NEITHER — promoted by the   ${String(fromNeither).padStart(6)}  ${pct(fromNeither)}`);
    w('      fusion from below both cut-offs');
    w();
    w(`  mean top-8 Jaccard  v6 vs v5  ${(jacV5 / counted).toFixed(4)}`);
    w(`                      v6 vs v4  ${(jacV4 / counted).toFixed(4)}`);
    w('  reference: §17.9 measured v4 vs v5 at 0.1906, with 9.6% of queries');
    w('  disjoint. Those are the two systems being fused.');
    w();

    // Does the gain land where the complementarity is? The 221 disjoint queries
    // are where RRF is supposed to pay; if the margin is flat across the strata
    // then "they fail on different queries" is not the mechanism, whatever the
    // headline says.
    const qrels = loadQrels(path.join(REPO_ROOT, 'data', 'qrels', `${SITE}.qrels`));
    const strata = { disjoint: [], overlapping: [] };
    for (const qid of queryIds) {
      const key = qrels.get(qid) || new Map();
      const a = new Set((bm25Run.get(qid) || []).slice(0, 8));
      const b = new Set((denseRun.get(qid) || []).slice(0, 8));
      let inter = 0;
      for (const d of a) if (b.has(d)) inter += 1;
      const sV5 = metrics.scoreQuery(denseRun.get(qid) || [], key, [8]).ndcg[8];
      const sV6 = metrics.scoreQuery(fusedRun.get(qid) || [], key, [8]).ndcg[8];
      if (sV5 === null || sV6 === null) continue;
      strata[inter === 0 ? 'disjoint' : 'overlapping'].push({ v5: sV5, v6: sV6 });
    }
    const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
    const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(6)}`;
    w('  Does the gain land where the complementarity is?');
    w('  stratum         n      v5 nDCG@8    v6 nDCG@8    v6 - v5');
    for (const [name, rows] of Object.entries(strata)) {
      if (rows.length === 0) continue;
      w(
        `  ${name.padEnd(12)} ${String(rows.length).padStart(5)}    ` +
        `${mean(rows.map((r) => r.v5)).toFixed(6)}     ${mean(rows.map((r) => r.v6)).toFixed(6)}    ` +
        `${sign(mean(rows.map((r) => r.v6)) - mean(rows.map((r) => r.v5)))}`
      );
    }
    w();
    w('  EXPLORATORY. The strata are defined by the two components\' agreement,');
    w('  which is not in registry.json and is not a second significance claim.');
    w();
  } else {
    w('5. THE FUSION SHAPE');
    w('-'.repeat(78));
    w('  needs results/runs/{v4-bm25,v5-embeddings,v6-hybrid}.dev.run — run them first');
    w();
  }

  // --- 6. the arithmetic, cross-checked against two committed artifacts ------
  //
  // WHY THIS EXISTS. The rung's headline is that fusion LOSES, and it clears
  // Holm doing it. §17.6's rule was written for the opposite case — "a
  // surprisingly good number is the one nobody feels like auditing" — and the
  // mirror risk is exactly as real: a surprisingly bad number can be a defect in
  // the thing being measured rather than a finding about it.
  //
  // The fixture tests already check the arithmetic at 34 documents against
  // standalone search() calls. This checks it at 27,325 against artifacts
  // produced by a COMPLETELY DIFFERENT CODE PATH: v4's and v5's committed run
  // files, written by run-eval.js in earlier sessions. Fusing their top-10 lists
  // by hand must reproduce v6 at depth 10, because at that depth the component
  // lists ARE those files.
  //
  // This is the check that makes reading two run files unnecessary rather than
  // merely rejected: it shows in-index fusion computes what run-file fusion
  // would, so nothing was given up by refusing the cheap implementation.
  if (haveRuns) {
    const bm25Run = loadRun(runFile('v4-bm25'));
    const denseRun = loadRun(runFile('v5-embeddings'));
    const d10 = retrieval.index('v6-hybrid', docs, { depth: 10 });

    let agreed = 0;
    let disagreed = 0;
    const examples = [];
    for (const qid of queryIds) {
      // Fuse the two FILES, independently of retrieval/.
      const scores = new Map();
      for (const list of [bm25Run.get(qid) || [], denseRun.get(qid) || []]) {
        for (let i = 0; i < Math.min(10, list.length); i += 1) {
          scores.set(list[i], (scores.get(list[i]) || 0) + 1 / (params.rrfK + i + 1));
        }
      }
      const expected = [...scores.entries()]
        .map(([docId, score]) => ({ docId, score }))
        .sort((x, y) => (y.score - x.score) || (x.docId < y.docId ? -1 : x.docId > y.docId ? 1 : 0))
        .slice(0, 10)
        .map((h) => h.docId);

      const actual = retrieval.search(d10, qid, 10).map((h) => h.docId);
      if (expected.join(' ') === actual.join(' ')) agreed += 1;
      else {
        disagreed += 1;
        if (examples.length < 3) examples.push(`${qid}: file-fusion ${expected.slice(0, 3)} vs v6 ${actual.slice(0, 3)}`);
      }
    }

    w('6. THE ARITHMETIC, CROSS-CHECKED AGAINST TWO COMMITTED RUN FILES');
    w('-'.repeat(78));
    w(`  v6 at depth 10 vs a hand fusion of v4's and v5's top-10 run files, rrfK ${params.rrfK}`);
    w(`    agree     ${agreed} of ${queryIds.length} queries`);
    w(`    disagree  ${disagreed}${examples.length ? `   ${examples.join(' | ')}` : ''}`);
    w();
    w('  At depth 10 the component lists ARE those two files, so this reproduces');
    w('  the fusion from artifacts written by a different code path in earlier');
    w('  sessions. It is the check that makes "read two run files" unnecessary');
    w('  rather than merely rejected: in-index fusion computes what run-file');
    w('  fusion would, so refusing the cheap implementation gave nothing up.');
    w();
    w('  Run because the rung LOSES and clears Holm doing it. §17.6 audited a');
    w('  surprisingly good number; a surprisingly bad one carries the mirror risk.');
    w();
    if (disagreed > 0) {
      w('  !! DISAGREEMENT. The fusion does not compute what it claims to. Stop.');
    }
  }

  const outFile = path.join(REPO_ROOT, 'results', 'v6-hybrid.analysis.txt');
  fs.writeFileSync(outFile, `${out.join('\n')}\n`);
  console.log(`written to ${path.relative(REPO_ROOT, outFile)}`);
}

main();
