#!/usr/bin/env node
'use strict';

/**
 * analyse-vocabulary.js — Phase 3.2.
 *
 *   npm run analyse:vocab
 *   npm run analyse:vocab -- --site cooking --split dev
 *
 * WHY THIS IS A COMMITTED SCRIPT. CLAUDE.md's claim discipline: a number is not
 * claimable without the file it came from, and the *asymptotic* class is free
 * only if the analysis survives worst-case questioning. It also names the exact
 * statement this produces:
 *
 *   "O(N²) → O(N·K)" is NOT defensible. Index construction is O(N·K), but edge
 *   emission from a postings bucket of size m costs m², so the total is
 *   O(Σ_t df_t²) — output-sensitive, and still quadratic if one keyword appears
 *   in every note. The document-frequency cutoff is what bounds it.
 *
 * v3-tfidf drops the top-10 truncation, which is the single biggest change to
 * that sum this project makes. Quoting how much without a way to regenerate it
 * would be exactly the claim the rule forbids. So this prints Σ_t df_t², the
 * postings count and the candidate-pool distribution for both vocabularies.
 *
 * READ-ONLY, on the same reasoning as analyze-ground-truth.js at 1.5 and
 * analyse-rungs.js at 3.1: it writes nothing and is in no number's provenance
 * chain. It builds the same index the runner builds, through the same
 * retrieval/ entry point, so it cannot describe a configuration the harness
 * would not produce.
 *
 * TWO COSTS THAT ARE ROUTINELY CONFLATED, and the point of the output is to
 * keep them apart:
 *
 *   per-query retrieval      Σ_{t∈q} df_t postings visits. What the EVAL pays,
 *                            2,304 times.
 *   all-pairs edge emission  Σ_t df_t². What PHASE 4 pays when the app rebuilds
 *                            a graph. The eval never pays it, and reporting the
 *                            first as though it bounded the second is the error
 *                            CLAUDE.md is warning about.
 */

const fs = require('fs');
const path = require('path');

const retrieval = require('../retrieval');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = { site: 'cooking', split: 'dev' };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag.startsWith('--')) {
      console.error(`analyse-vocabulary: unknown flag ${flag}`);
      process.exit(1);
    }
  }
  return args;
}

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

function quantile(sorted, q) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${args.site}.jsonl`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${args.site}.${args.split}.txt`);
  for (const file of [corpusFile, splitFile]) {
    if (!fs.existsSync(file)) {
      console.error(`analyse-vocabulary: ${path.relative(REPO_ROOT, file)} does not exist.`);
      process.exit(1);
    }
  }

  const docs = readLines(corpusFile).map((line) => JSON.parse(line));
  const queryIds = readLines(splitFile);

  console.log(`ANALYSE VOCABULARY — ${args.site}, N=${docs.length}, ${args.split} ${queryIds.length} queries`);
  console.log('='.repeat(78));
  console.log();
  console.log('  Both arms are v3-tfidf; only topN moves, so the two rows are one');
  console.log('  variable apart and the ratio between them is what truncation buys.');
  console.log();

  const rows = [];
  for (const topN of [null, 10]) {
    const handle = retrieval.index('v3-tfidf', docs, { topN });
    const { postingsDocs, terms, indexById } = handle._state;

    let vocabulary = 0;
    let postings = 0;
    let sumSq = 0;
    let maxDf = 0;
    for (const bucket of postingsDocs) {
      if (bucket.length === 0) continue;
      vocabulary += 1;
      postings += bucket.length;
      sumSq += bucket.length * bucket.length;
      if (bucket.length > maxDf) maxDf = bucket.length;
    }

    const termsPerDoc = [...terms].map((t) => t.length).sort((a, b) => a - b);

    // Candidate pool: the documents a query would score against — everything
    // sharing at least one term. This is the per-query cost, and it is NOT the
    // edge-emission cost above.
    const pool = [];
    const work = [];
    for (const qid of queryIds) {
      const qTerms = terms[indexById.get(qid)];
      const seen = new Set();
      let visits = 0;
      for (const termId of qTerms) {
        const bucket = postingsDocs[termId];
        visits += bucket.length;
        for (const di of bucket) seen.add(di);
      }
      pool.push(seen.size);
      work.push(visits);
    }
    pool.sort((a, b) => a - b);
    work.sort((a, b) => a - b);
    const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;

    rows.push({ topN, vocabulary, postings, sumSq, maxDf, termsPerDoc, pool, work, mean });
  }

  const [full, top10] = rows;
  const fmt = (n) => n.toLocaleString('en-US');

  console.log('  INDEX AND THE EDGE-EMISSION BOUND');
  console.log('  ' + '-'.repeat(76));
  console.log('                                 full vocabulary        top-10        ratio');
  const line = (label, a, b, exp) => {
    const s = (v) => (exp ? v.toExponential(4) : fmt(v));
    console.log(`  ${label.padEnd(28)} ${s(a).padStart(16)} ${s(b).padStart(13)}   ${(a / b).toFixed(2)}x`);
  };
  line('|V| (terms with postings)', full.vocabulary, top10.vocabulary);
  line('postings  Sigma_t df_t', full.postings, top10.postings);
  line('Sigma_t df_t^2', full.sumSq, top10.sumSq, true);
  line('max df', full.maxDf, top10.maxDf);
  console.log();
  console.log('  Sigma_t df_t^2 is the ALL-PAIRS edge-emission cost — what Phase 4 pays when');
  console.log('  the app rebuilds a graph over N documents. The eval never pays it: it runs');
  console.log(`  ${queryIds.length} queries, not ${fmt(docs.length)}^2. Reporting one as though it bounded the other`);
  console.log('  is the error CLAUDE.md names.');
  console.log();

  console.log('  PER-DOCUMENT AND PER-QUERY COST');
  console.log('  ' + '-'.repeat(76));
  for (const r of rows) {
    const label = r.topN === null ? 'full vocabulary' : `topN ${r.topN}`;
    console.log(`  ${label}`);
    console.log(
      `    terms/doc          mean ${r.mean(r.termsPerDoc).toFixed(1).padStart(8)}  p50 ${String(quantile(r.termsPerDoc, 0.5)).padStart(6)}` +
      `  p95 ${String(quantile(r.termsPerDoc, 0.95)).padStart(6)}  max ${String(r.termsPerDoc[r.termsPerDoc.length - 1]).padStart(6)}`
    );
    console.log(
      `    candidate pool     mean ${r.mean(r.pool).toFixed(0).padStart(8)}  p50 ${String(quantile(r.pool, 0.5)).padStart(6)}` +
      `  p95 ${String(quantile(r.pool, 0.95)).padStart(6)}  max ${String(r.pool[r.pool.length - 1]).padStart(6)}`
    );
    console.log(
      `    postings visited   mean ${r.mean(r.work).toFixed(0).padStart(8)}  p50 ${String(quantile(r.work, 0.5)).padStart(6)}` +
      `  p95 ${String(quantile(r.work, 0.95)).padStart(6)}  max ${String(r.work[r.work.length - 1]).padStart(6)}`
    );
    const share = (100 * r.mean(r.pool)) / docs.length;
    console.log(`    mean pool is ${share.toFixed(1)}% of the corpus`);
    console.log();
  }

  console.log(`  Total postings visited over the whole ${args.split} run:`);
  for (const r of rows) {
    const label = r.topN === null ? 'full vocabulary' : `topN ${r.topN}`;
    console.log(`    ${label.padEnd(18)} ${fmt(Math.round(r.mean(r.work) * queryIds.length))}`);
  }
  console.log();
  console.log('  There is NO document-frequency cutoff. If one ever becomes necessary it');
  console.log('  will be a retriever PARAM that lands in describe(handle).digest, never a');
  console.log('  silent constant — a silent cutoff is the "run that lies about itself" of');
  console.log('  EVALUATION.md §13.10.');
}

main();
