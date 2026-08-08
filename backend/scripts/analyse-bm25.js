'use strict';

/**
 * analyse-bm25.js — Phase 3.3, read-only.
 *
 *   cd backend && npm run analyse:bm25
 *   cd backend && node --expose-gc scripts/analyse-bm25.js    (retained-heap figure)
 *
 * The corpus-scale numbers 3.3's Done criterion names — "index build time and
 * memory at corpus scale" — plus the four quantities the writeup cannot state
 * without a file behind them (CLAUDE.md: never claim a number without the file
 * it came from):
 *
 *   avgdl and the |D| distribution     the denominator every b acts through, and
 *                                      a quantity nothing on this ladder has ever
 *                                      computed
 *   the tf distribution                what k1 has to bite on
 *   the idf ranges and the negative     the variant decision, measured on this
 *   -idf count under BOTH variants      corpus rather than argued from df alone
 *   max |idf(df) - idf(df-1)|           the price of dropping leave-one-out, which
 *                                      is the one param held constant v1->v2->v3
 *
 * READ-ONLY, for §5's reason at 1.5 and §14.6's at 3.1: a script that only reads
 * cannot invalidate the artifact it describes. It builds its index through the
 * same retrieval/ entry point run-eval.js uses, so it cannot describe a
 * different structure from the one that produced the runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { index } = require('../retrieval');
const v1 = require('../retrieval/v1-overlap');
const v4 = require('../retrieval/v4-bm25');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SITE = 'cooking';
const SPLIT = 'dev';

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

function quantiles(values) {
  const sorted = Float64Array.from(values).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    max: sorted[sorted.length - 1],
    min: sorted[0]
  };
}

function main() {
  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${SITE}.jsonl`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${SITE}.${SPLIT}.txt`);
  const docs = readLines(corpusFile).map((line) => JSON.parse(line));
  const queryIds = readLines(splitFile);

  console.log(`analyse v4-bm25 index over ${SITE} (N = ${docs.length})\n`);

  // --- build time, repeated, because one measurement of a laptop is not a figure
  const buildMs = [];
  let handle = null;
  for (let i = 0; i < 5; i += 1) {
    const t = process.hrtime.bigint();
    handle = index('v4-bm25', docs, {});
    buildMs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  buildMs.sort((a, b) => a - b);
  const state = handle._state;

  console.log('INDEX BUILD — 5 consecutive builds, ms');
  console.log(`  ${buildMs.map((m) => m.toFixed(0)).join('  ')}`);
  console.log(`  median ${buildMs[2].toFixed(0)} ms, range [${buildMs[0].toFixed(0)}, ${buildMs[4].toFixed(0)}]`);
  console.log('  UNCONTROLLED LAPTOP MEASUREMENT (§12.4). A cost, not a claim about the system.\n');

  // --- memory. Two numbers that are not the same number.
  const postings = state.postingsDocs.reduce((s, p) => s + p.length, 0);
  const analytic = {
    postingsDocsBytes: postings * 4,
    postingsTfsBytes: postings * 4,
    docTermsBytes: state.docTerms.reduce((s, t) => s + t.length * 4, 0),
    docTfsBytes: state.docTfs.reduce((s, t) => s + t.length * 4, 0),
    lengthsBytes: state.lengths.length * 8,
    lengthRatioBytes: state.lengthRatioMinus1.length * 8,
    idfBytes: state.idf.length * 8,
    scratchBytes: state.n * (8 + 4 + 4)
  };
  const analyticTotal = Object.values(analytic).reduce((a, b) => a + b, 0);

  console.log('MEMORY AT CORPUS SCALE');
  console.log(`  postings Σ_t df_t            ${postings.toLocaleString()}`);
  console.log('  typed-array bytes, computed from the structures rather than estimated:');
  for (const [k, v] of Object.entries(analytic)) {
    console.log(`    ${k.padEnd(24)} ${(v / 1048576).toFixed(2)} MiB`);
  }
  console.log(`    ${'TOTAL typed arrays'.padEnd(24)} ${(analyticTotal / 1048576).toFixed(2)} MiB`);
  console.log('  the vocabulary Map (34k strings -> term ids) and the df Map are NOT in that');
  console.log('  total; they are JS objects whose footprint is not computable from a length.\n');

  if (typeof global.gc === 'function') {
    // Retained heap: build, drop, collect, rebuild, collect, and difference the
    // two settled measurements. Without --expose-gc this is not measurable and
    // the script says so rather than printing a number that includes garbage.
    handle = null;
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    handle = index('v4-bm25', docs, {});
    global.gc(); global.gc();
    const after = process.memoryUsage().heapUsed;
    console.log(`  retained heap for one handle  ${((after - before) / 1048576).toFixed(1)} MiB   (--expose-gc)`);
  } else {
    console.log('  retained heap                 not measured — rerun with --expose-gc');
  }
  console.log(`  peak RSS for this process     ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB\n`);

  // --- |D|: the quantity BM25 reads and nothing on this ladder had computed
  const lengths = [...state.lengths];
  const lq = quantiles(lengths);
  const distinct = docs.map((d) => v4.termCount(state, d.id));
  const dq = quantiles(distinct);

  console.log('|D| — TOTAL TOKENS WITH REPETITION, title counted titleWeight times');
  console.log(`  avgdl                        ${state.avgdl.toFixed(4)}`);
  console.log(`  |D|        mean ${lq.mean.toFixed(1)} · p50 ${lq.p50} · p95 ${lq.p95} · max ${lq.max} · min ${lq.min}`);
  console.log(`  distinct   mean ${dq.mean.toFixed(1)} · p50 ${dq.p50} · p95 ${dq.p95} · max ${dq.max} · min ${dq.min}`);
  console.log(`  ratio |D| / distinct         ${(lq.mean / dq.mean).toFixed(4)}`);
  console.log('  v3 normalises by the L2 norm of a vector over DISTINCT terms; BM25 normalises');
  console.log('  by |D|. The two are different quantities and the second is larger.\n');

  // Title doubling's contribution to |D| — the inherited decision, priced.
  let titleTokens = 0;
  let bodyTokens = 0;
  for (const doc of docs) {
    titleTokens += v1.tokenise(doc.title || '').length;
    bodyTokens += v1.tokenise(doc.body || '').length;
  }
  console.log(`  title tokens (once)          ${titleTokens.toLocaleString()}`);
  console.log(`  body tokens                  ${bodyTokens.toLocaleString()}`);
  console.log(`  avgdl at titleWeight 2       ${((2 * titleTokens + bodyTokens) / docs.length).toFixed(4)}`);
  console.log(`  avgdl at titleWeight 1       ${((titleTokens + bodyTokens) / docs.length).toFixed(4)}`);
  console.log(`  the doubling is ${((titleTokens / (2 * titleTokens + bodyTokens)) * 100).toFixed(1)}% of every length BM25 divides by.\n`);

  // --- tf: what k1 has to bite on
  let tfTotal = 0;
  let tfOne = 0;
  const tfHist = new Map();
  let maxTf = 0;
  for (const arr of state.docTfs) {
    for (const tf of arr) {
      tfTotal += 1;
      if (tf === 1) tfOne += 1;
      if (tf > maxTf) maxTf = tf;
      const bucket = tf >= 10 ? '10+' : String(tf);
      tfHist.set(bucket, (tfHist.get(bucket) || 0) + 1);
    }
  }
  console.log('tf — WHAT k1 HAS TO ACT ON');
  console.log(`  (document, term) pairs       ${tfTotal.toLocaleString()}`);
  console.log(`  tf = 1                       ${tfOne.toLocaleString()} (${((tfOne / tfTotal) * 100).toFixed(1)}%)`);
  console.log(`  tf > 1                       ${(tfTotal - tfOne).toLocaleString()} (${(((tfTotal - tfOne) / tfTotal) * 100).toFixed(1)}%)`);
  console.log(`  max tf                       ${maxTf}`);
  const order = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'];
  console.log(`  histogram  ${order.map((k) => `${k}:${((tfHist.get(k) || 0) / tfTotal * 100).toFixed(1)}%`).join('  ')}`);
  console.log('  At tf = 1 and |D| = avgdl the saturation factor is exactly 1 for EVERY k1,');
  console.log('  so k1 can only act on the tf > 1 tail and on the length term.\n');

  // --- idf, both variants, and the negative-idf question
  console.log('IDF — BOTH VARIANTS, AND THE NEGATIVE-IDF QUESTION');
  let maxDf = 0;
  let maxDfTerm = null;
  for (const [term, df] of state.df) if (df > maxDf) { maxDf = df; maxDfTerm = term; }
  console.log(`  |V|                          ${state.vocabularySize.toLocaleString()}`);
  console.log(`  max df                       ${maxDf.toLocaleString()}  "${maxDfTerm}"  (${((maxDf / docs.length) * 100).toFixed(1)}% of the corpus)`);
  console.log(`  df > N/2 needed for a negative robertson idf: ${Math.floor(docs.length / 2).toLocaleString()}`);

  for (const variant of ['lucene', 'robertson']) {
    let lo = Infinity; let hi = -Infinity; let nonPositive = 0;
    for (const [, df] of state.df) {
      const value = v4.idfFor(variant, docs.length, df);
      if (value < lo) lo = value;
      if (value > hi) hi = value;
      if (value <= 0) nonPositive += 1;
    }
    console.log(`  ${variant.padEnd(10)} idf range [${lo.toFixed(4)}, ${hi.toFixed(4)}]  ratio ${(hi / lo).toFixed(2)}x  non-positive terms ${nonPositive}`);
  }
  // v3's own idf, for the comparison the chain's first step bundles.
  const v3Lo = Math.log(docs.length / maxDf) + 1;
  const v3Hi = Math.log(docs.length / 1) + 1;
  console.log(`  v3-tfidf   idf range [${v3Lo.toFixed(4)}, ${v3Hi.toFixed(4)}]  ratio ${(v3Hi / v3Lo).toFixed(2)}x`);
  console.log(`             and it enters the cosine SQUARED (query weight x document weight),`);
  console.log(`             so its effective rare-term ratio is ${((v3Hi / v3Lo) ** 2).toFixed(2)}x against BM25's linear one.\n`);

  // --- the price of dropping leave-one-out
  const delta = v4.idfDelta(state);
  console.log('LEAVE-ONE-OUT, DROPPED — THE PRICE, MEASURED');
  console.log(`  max |idf(df) - idf(df-1)| over df >= 2:  ${delta.max.toFixed(6)}  at df ${delta.atDf} ("${delta.atTerm}")`);
  const n = docs.length;
  console.log(`  at df = 5150 ("${maxDfTerm}")              ${Math.abs(v4.idfFor('lucene', n, maxDf) - v4.idfFor('lucene', n, maxDf - 1)).toFixed(8)}`);
  console.log(`  at df = 100                              ${Math.abs(v4.idfFor('lucene', n, 100) - v4.idfFor('lucene', n, 99)).toFixed(8)}`);
  console.log(`  at df = 10                               ${Math.abs(v4.idfFor('lucene', n, 10) - v4.idfFor('lucene', n, 9)).toFixed(8)}`);
  console.log(`  at df = 2                                ${Math.abs(v4.idfFor('lucene', n, 2) - v4.idfFor('lucene', n, 1)).toFixed(8)}`);
  console.log('  NOT uniformly negligible. The drop is a decision about a term with no referent');
  console.log('  under BM25 (query, document, or both?), not a convenience — and the rare-term');
  console.log('  end is where it would cost, which is where duplicate detection lives.\n');

  // --- candidate pool, comparable to §15.6's table
  console.log(`CANDIDATE POOL over ${queryIds.length} dev queries`);
  const pool = [];
  const visits = [];
  const seen = new Uint8Array(state.n);
  for (const qid of queryIds) {
    const qi = state.indexById.get(qid);
    const terms = state.docTerms[qi];
    let count = 0;
    let visited = 0;
    const touched = [];
    for (const t of terms) {
      const bucket = state.postingsDocs[t];
      visited += bucket.length;
      for (const di of bucket) {
        if (!seen[di]) { seen[di] = 1; touched.push(di); count += 1; }
      }
    }
    for (const di of touched) seen[di] = 0;
    pool.push(count);
    visits.push(visited);
  }
  const pq = quantiles(pool);
  const vq = quantiles(visits);
  console.log(`  candidates/query             mean ${pq.mean.toFixed(0)} (${((pq.mean / state.n) * 100).toFixed(1)}% of corpus) · p95 ${pq.p95}`);
  console.log(`  postings visited/query       mean ${vq.mean.toFixed(0)} · p95 ${vq.p95}`);
  console.log(`  total over dev               ${visits.reduce((a, b) => a + b, 0).toLocaleString()}`);
  console.log('  §15.6 measured the same quantities for v3 at full vocabulary. They agree because');
  console.log('  the postings structure is the same one; what changed is the arithmetic per visit.\n');

  console.log('ENVIRONMENT');
  console.log(`  ${os.platform()} ${os.release()} ${os.arch()} · node ${process.version}`);
  console.log(`  ${os.cpus()[0] ? os.cpus()[0].model : 'unknown cpu'} · ${Math.round(os.totalmem() / 1073741824)} GiB`);
}

main();
