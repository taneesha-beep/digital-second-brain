'use strict';

/**
 * analyse-embeddings.js — the cost and shape of retriever v5. Phase 3.4.
 *
 *   npm run analyse:v5
 *   node --expose-gc scripts/analyse-embeddings.js     # adds the retained-heap figure
 *
 * READ-ONLY, on the same reasoning as analyse-bm25.js at 3.3 and
 * analyze-ground-truth.js at 1.5: it describes artifacts whose SHA-256s are
 * published, and a script that only reads cannot invalidate the thing it
 * describes. It exists because CLAUDE.md forbids claiming a measured number
 * without the file it came from, and 3.4's Done criterion names five of them —
 * model, dimension, runtime, hardware and wall time.
 *
 * IT DOES NOT EMBED ANYTHING. Wall time for the corpus is read out of the
 * vectors manifest, where scripts/embed-corpus.js recorded it at the moment it
 * was measured. Re-timing it here would report a different quantity (a warm
 * page cache, a different thermal state) under the same name.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const retrieval = require('../retrieval');
const v5 = require('../retrieval/v5-embeddings');

const SITE = process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : 'cooking';
const SPLIT = 'dev';

function fail(message) {
  console.error(`\nanalyse-embeddings: ${message}\n`);
  process.exit(1);
}

const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => l !== '');

function loadDocsWithVectors(slug) {
  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${SITE}.jsonl`);
  const vectorsFile = path.join(REPO_ROOT, 'data', 'vectors', `${SITE}.${slug}.f32`);
  const manifestFile = path.join(REPO_ROOT, 'data', 'vectors', `${SITE}.${slug}.manifest.json`);
  for (const f of [corpusFile, vectorsFile, manifestFile]) {
    if (!fs.existsSync(f)) fail(`${path.relative(REPO_ROOT, f)} does not exist`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const docs = lines(corpusFile).map((l) => JSON.parse(l));
  const dim = manifest.vectors.dim;
  const buffer = fs.readFileSync(vectorsFile);
  const all = new Float32Array(buffer.buffer, buffer.byteOffset, docs.length * dim);
  for (let i = 0; i < docs.length; i += 1) docs[i].vector = all.subarray(i * dim, (i + 1) * dim);
  return { docs, manifest, dim };
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function main() {
  const slug = v5.defaultParams.vectors;
  const { docs, manifest, dim } = loadDocsWithVectors(slug);
  const n = docs.length;
  const out = [];
  const w = (s = '') => { out.push(s); console.log(s); };

  w(`ANALYSE v5-embeddings — ${SITE}, N=${n}`);
  w('='.repeat(78));
  w();

  // --- 1. the five things 3.4's Done criterion names -------------------------
  w('1. MODEL, DIMENSION, RUNTIME, HARDWARE, WALL TIME');
  w('-'.repeat(78));
  w(`  model        ${manifest.model.repo}`);
  w(`  revision     ${manifest.model.revision}   (a commit, not a branch)`);
  w(`  dtype        ${manifest.model.dtype}      pooling: ${manifest.model.pooling}`);
  w(`  dimension    ${dim}`);
  w(`  runtime      transformers.js ${manifest.environment.transformersJs} on onnxruntime-node ${manifest.environment.onnxruntimeNode}`);
  w(`  hardware     ${manifest.environment.cpus}, ${os.arch()}, ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB, ${manifest.environment.platform}, Node ${manifest.environment.node}`);
  w(`  WALL TIME    ${(manifest.environment.wallMs / 1000).toFixed(1)} s for all ${n} documents  (${manifest.environment.docsPerSecond.toFixed(1)} docs/s)`);
  w(`  weights      ${Object.entries(manifest.model.files).map(([f, m]) => `${f} ${m.bytes}B`).join(', ')}`);
  w();
  w('  Wall time is READ FROM THE MANIFEST, where embed-corpus.js recorded it at');
  w('  the moment it was measured. Re-timing it here would report a warm page');
  w('  cache and a different thermal state under the same name.');
  w();

  // --- 2. truncation, the confound in the headline ---------------------------
  w('2. TRUNCATION — the confound inside any v4-vs-v5 comparison');
  w('-'.repeat(78));
  w(`  window            ${manifest.text.maxTokens} wordpieces (the checkpoint's own limit, not a choice)`);
  w(`  truncated         ${manifest.text.truncatedDocuments} of ${n} documents (${(100 * manifest.text.truncatedShare).toFixed(1)}%)`);
  w(`  longest document  ${manifest.text.longestDocumentTokens} wordpieces`);
  w(`  mean after trunc  ${manifest.text.meanTokensAfterTruncation.toFixed(1)}`);
  w(`  text template     ${manifest.text.template}`);
  w();
  w('  BM25 reads every token of a 2,185-token document; this model reads the');
  w('  first 256. That asymmetry sits inside the rung comparison and cannot be');
  w('  removed, only measured — which is what the 128-wordpiece run is for.');
  w();

  // --- 3. the vectors --------------------------------------------------------
  const norms = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    const v = docs[i].vector;
    for (let d = 0; d < dim; d += 1) sum += v[d] * v[d];
    norms[i] = Math.sqrt(sum);
  }
  const sortedNorms = Float64Array.from(norms).sort();
  w('3. THE VECTORS');
  w('-'.repeat(78));
  w(`  norms         min ${sortedNorms[0].toFixed(4)} · p50 ${quantile(sortedNorms, 0.5).toFixed(4)} · p95 ${quantile(sortedNorms, 0.95).toFixed(4)} · max ${sortedNorms[n - 1].toFixed(4)}`);
  w(`  stored        unnormalised, so \`normalise\` is a param flip rather than a re-embed`);
  w(`  mean pairwise cosine (sampled at embed time)  ${manifest.vectors.meanPairwiseCosineSample.toFixed(4)} over ${manifest.vectors.sampledPairs} pairs`);
  w(`  max  pairwise cosine (sampled at embed time)  ${manifest.vectors.maxPairwiseCosineSample.toFixed(4)}`);
  w();
  w('  A mean pairwise cosine near 1 would mean the embedding had collapsed and');
  w('  any nDCG from it was an artifact. embed-corpus.js hard-fails above 0.9.');
  w(`  The spread of norms is ${(sortedNorms[n - 1] / sortedNorms[0]).toFixed(1)}x, which is why cosine-vs-dot is a real`);
  w('  ablation here and not a formality.');
  w();

  // --- 4. index build --------------------------------------------------------
  const builds = [];
  let handle = null;
  for (let r = 0; r < 5; r += 1) {
    const t = process.hrtime.bigint();
    handle = retrieval.index('v5-embeddings', docs);
    builds.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const buildsSorted = [...builds].sort((a, b) => a - b);
  w('4. INDEX BUILD');
  w('-'.repeat(78));
  w(`  five builds   ${builds.map((b) => b.toFixed(0)).join(' ')} ms`);
  w(`  median        ${buildsSorted[2].toFixed(0)} ms      (v4-bm25: 982 ms · v3-tfidf: ~1,470 ms)`);
  w();
  w('  v5 builds no postings, no vocabulary and no df table. It copies 42 MB into');
  w('  a contiguous matrix and normalises each row, which is one linear pass. The');
  w('  work the other rungs do at index time was done once by the embed step.');
  w();

  // --- 5. memory, three numbers that must not be conflated -------------------
  const typedArrays = (n * dim * 4) + (n * 8);
  w('5. MEMORY — three numbers that must not be conflated');
  w('-'.repeat(78));
  w(`  typed arrays, computed from the structures    ${(typedArrays / 1024 ** 2).toFixed(2)} MiB`);
  w(`    matrix  ${n} x ${dim} x 4B = ${(n * dim * 4 / 1024 ** 2).toFixed(2)} MiB · norms ${n} x 8B = ${(n * 8 / 1024 ** 2).toFixed(2)} MiB`);
  if (typeof global.gc === 'function') {
    global.gc();
    const before = process.memoryUsage();
    const held = retrieval.index('v5-embeddings', docs);
    global.gc();
    const after = process.memoryUsage();
    const heapDelta = after.heapUsed - before.heapUsed;
    const bufferDelta = after.arrayBuffers - before.arrayBuffers;
    w(`  retained for one handle (--expose-gc)         ${((heapDelta + bufferDelta) / 1024 ** 2).toFixed(1)} MiB`);
    w(`    of which V8 heap      ${(heapDelta / 1024 ** 2).toFixed(1)} MiB   the id Map and the idByIndex array`);
    w(`    of which arrayBuffers ${(bufferDelta / 1024 ** 2).toFixed(1)} MiB   the matrix and the norms`);
    w(`    (handle held live across the measurement: ${held.docCount} docs)`);
    w();
    w('    BOTH TERMS ARE REPORTED BECAUSE heapUsed ALONE IS MISLEADING HERE, and');
    w('    it was the first thing this script got wrong. A large typed array\'s');
    w('    backing store is allocated OUTSIDE the V8 heap, so heapUsed reports');
    w(`    ~${(heapDelta / 1024 ** 2).toFixed(0)} MiB for a structure that is ${(typedArrays / 1024 ** 2).toFixed(0)} MiB of floats. v4's 34.8 MiB`);
    w('    retained-heap figure (§16.12) did not have this problem — its Maps and');
    w('    strings are genuinely on the heap — so the two are NOT comparable');
    w('    quantities and reading them side by side would be a mistake.');
  } else {
    w('  retained for one handle                       re-run with `node --expose-gc` to measure');
  }
  w(`  peak RSS for this process                     ${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)} MiB`);
  w();
  w('  The third is dominated by the parsed corpus, which EVERY rung pays and');
  w('  which is not part of the index — §16.12 made the same separation for v4,');
  w('  where quoting RSS as "BM25\'s memory" would have been wrong by 19x.');
  w();

  // --- 6. search, and the ANN question ---------------------------------------
  const queryIds = lines(path.join(REPO_ROOT, 'data', 'splits', `${SITE}.${SPLIT}.txt`));
  const latencies = new Float64Array(queryIds.length);
  for (let i = 0; i < queryIds.length; i += 1) {
    const t = process.hrtime.bigint();
    retrieval.search(handle, queryIds[i], 10);
    latencies[i] = Number(process.hrtime.bigint() - t) / 1e6;
  }
  const sortedLat = Float64Array.from(latencies).sort();
  const flops = 2 * n * dim;
  w('6. SEARCH, AND WHY EXACT RATHER THAN ANN');
  w('-'.repeat(78));
  w(`  per query     mean ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)} ms · p50 ${quantile(sortedLat, 0.5).toFixed(2)} · p95 ${quantile(sortedLat, 0.95).toFixed(2)} ms`);
  w(`  work          2 x ${n} x ${dim} = ${(flops / 1e6).toFixed(1)} MFLOP per query, plus a ${n - 1}-element sort`);
  w(`  effective     ${(flops / (quantile(sortedLat, 0.5) / 1000) / 1e9).toFixed(2)} GFLOP/s at p50 — plain JS over a Float32Array, no SIMD intrinsics`);
  w();
  w('  Exact search visits every document. An ANN index would buy sublinear');
  w('  search and cost three things:');
  w('    1. a dependency, inside the step this phase is about pinning;');
  w('    2. build-time hyperparameters (HNSW M, efConstruction) needing their own');
  w('       sweep and their own selection-bias accounting — §13.7 put 44% of v4\'s');
  w('       tuning margin down to optimism, so that is not a formality;');
  w('    3. APPROXIMATE RECALL, a new error source placed INSIDE the thing being');
  w('       measured. A v4-vs-v5 difference would then confound the retriever with');
  w('       the index, and CLAUDE.md\'s one-variable rule would be broken by the');
  w('       data structure rather than by the experiment.');
  w(`  ANN starts paying when N x dim stops fitting the latency budget, around`);
  w(`  N > 1e6. This corpus is ${n}, and a full scan costs ${quantile(sortedLat, 0.5).toFixed(0)} ms.`);
  w();

  // --- 7. complementarity with v4 — what 3.5 inherits ------------------------
  const runFile = (label) => path.join(REPO_ROOT, 'results', 'runs', `${label}.${SPLIT}.run`);
  if (fs.existsSync(runFile('v4-bm25')) && fs.existsSync(runFile('v5-embeddings'))) {
    const load = (label) => {
      const byQuery = new Map();
      for (const line of lines(runFile(label))) {
        const f = line.split(' ');
        if (!byQuery.has(f[0])) byQuery.set(f[0], []);
        byQuery.get(f[0]).push(f[2]);
      }
      return byQuery;
    };
    const a = load('v5-embeddings');
    const b = load('v4-bm25');
    let jaccardSum = 0;
    let disjoint = 0;
    let counted = 0;
    for (const qid of queryIds) {
      const sa = new Set((a.get(qid) || []).slice(0, 8));
      const sb = new Set((b.get(qid) || []).slice(0, 8));
      if (sa.size === 0 && sb.size === 0) continue;
      let inter = 0;
      for (const d of sa) if (sb.has(d)) inter += 1;
      jaccardSum += inter / (sa.size + sb.size - inter);
      if (inter === 0) disjoint += 1;
      counted += 1;
    }
    w('7. HOW DIFFERENT ARE v4 AND v5? — the number 3.5 actually needs');
    w('-'.repeat(78));
    w(`  mean Jaccard of the two top-8 sets    ${(jaccardSum / counted).toFixed(4)}`);
    w(`  queries where the top-8 sets are DISJOINT   ${disjoint} of ${counted} (${(100 * disjoint / counted).toFixed(1)}%)`);
    w();
    w('  RRF pays when two systems fail on different queries. This is the');
    w('  measurement of "different" — recorded at 3.4 so 3.5 designs against a');
    w('  number rather than discovering it in its own results.');
    w();
  }

  // --- 8. train/test contamination, measured rather than caveated -----------
  //
  // all-MiniLM-L6-v2's model card lists Stack Exchange DUPLICATE QUESTION PAIRS
  // as training data (304,525 titles / 250,519 bodies / 250,460 both), and the
  // dataset it names — flax-sentence-embeddings/stackexchange_xml, snapshotted
  // 2021-07-26 — contains cooking.stackexchange.com.7z. So this site's
  // duplicate pairs were in the training set of the model being evaluated, and
  // LinkTypeId=3 "Duplicate" is exactly the relation graded 2 in these qrels.
  //
  // That is a first-order confound and it cannot be removed. It CAN be priced:
  // a query document created after the snapshot was not in the training dump at
  // all — not its text, not its links. If memorisation were driving the result,
  // v5's margin over v4 would collapse on that stratum.
  //
  // The comparison is of the DIFFERENCE within each stratum, never of the
  // absolute levels across them: §5.3 measured that per-query scores are not
  // comparable across corpus age, because degree tracks how much corpus came
  // after a document.
  const SNAPSHOT = '2021-07-26';
  const v4Run = runFile('v4-bm25');
  const v5Run = runFile('v5-embeddings');
  if (fs.existsSync(v4Run) && fs.existsSync(v5Run)) {
    const metrics = require('../eval/metrics');
    const { pairedBootstrap } = require('../eval/bootstrap');
    const qrels = new Map();
    for (const line of lines(path.join(REPO_ROOT, 'data', 'qrels', `${SITE}.qrels`))) {
      const [qid, , docId, grade] = line.split(/\s+/);
      if (!qrels.has(qid)) qrels.set(qid, new Map());
      qrels.get(qid).set(docId, Number(grade));
    }
    const ranked = (file) => {
      const byQuery = new Map();
      for (const line of lines(file)) {
        const f = line.split(' ');
        if (!byQuery.has(f[0])) byQuery.set(f[0], []);
        byQuery.get(f[0]).push(f[2]);
      }
      return byQuery;
    };
    const a = ranked(v5Run);
    const b = ranked(v4Run);
    const created = new Map(docs.map((d) => [d.id, d.creationDate]));
    const strata = { seen: [], unseen: [] };
    for (const qid of queryIds) {
      const key = qrels.get(qid) || new Map();
      const sa = metrics.scoreQuery(a.get(qid) || [], key, [8]).ndcg[8];
      const sb = metrics.scoreQuery(b.get(qid) || [], key, [8]).ndcg[8];
      if (sa === null || sb === null) continue;
      const bucket = created.get(qid).slice(0, 10) > SNAPSHOT ? 'unseen' : 'seen';
      strata[bucket].push({ a: sa, b: sb });
    }
    const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
    w('8. TRAIN/TEST CONTAMINATION — named, then measured');
    w('-'.repeat(78));
    w('  all-MiniLM-L6-v2 was trained on Stack Exchange DUPLICATE QUESTION PAIRS');
    w('  (model card: 304,525 titles / 250,519 bodies / 250,460 titles+bodies),');
    w('  from flax-sentence-embeddings/stackexchange_xml, snapshotted 2021-07-26,');
    w('  which CONTAINS cooking.stackexchange.com.7z. LinkTypeId=3 "Duplicate" is');
    w('  the relation graded 2 in these qrels. The overlap is not hypothetical.');
    w();
    w(`  A query created after ${SNAPSHOT} was not in that dump at all. If`);
    w('  memorisation were the mechanism, the margin would collapse there.');
    w();
    w('  stratum      n        v4 nDCG@8    v5 nDCG@8    v5 - v4');
    for (const [name, rows] of Object.entries(strata)) {
      w(
        `  ${name.padEnd(9)} ${String(rows.length).padStart(5)}    ` +
        `${mean(rows.map((r) => r.b)).toFixed(6)}     ${mean(rows.map((r) => r.a)).toFixed(6)}    ` +
        `${mean(rows.map((r) => r.a)) - mean(rows.map((r) => r.b)) >= 0 ? '+' : ''}` +
        `${(mean(rows.map((r) => r.a)) - mean(rows.map((r) => r.b))).toFixed(6)}`
      );
    }
    const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(6)}`;
    for (const [name, rows] of Object.entries(strata)) {
      const boot = pairedBootstrap(rows.map((r) => r.a - r.b), { seed: 20260804, resamples: 10000, alpha: 0.05 });
      w();
      w(`  ${name} stratum, paired bootstrap (seed 20260804, B=10000 — the §11.3 pins):`);
      w(`    n ${boot.n} · mean difference ${sign(boot.observedMeanDifference)} · 95% CI [${sign(boot.ci[0])}, ${sign(boot.ci[1])}]`);
      w(`    ${boot.differing} queries moved; v5 ahead on ${boot.aBetter}, v4 on ${boot.bBetter}`);
    }
    w();
    w('  EXPLORATORY, and reported as such: this stratification is not in');
    w('  registry.json, the n is small, and no p-value is quoted for it. What the');
    w('  interval supports is a direction, not a second significance claim.');
    w();
  }

  const outFile = path.join(REPO_ROOT, 'results', 'v5-embeddings.analysis.txt');
  fs.writeFileSync(outFile, `${out.join('\n')}\n`);
  console.log(`written to ${path.relative(REPO_ROOT, outFile)}`);
}

main();
