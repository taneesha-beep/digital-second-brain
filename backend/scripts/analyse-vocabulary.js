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
 * IT NOW WRITES ITS REPORT — changed at 3.7, and the reason is a mechanism
 * rather than a preference. This script was read-only on 1.5's reasoning: a
 * script that only reads cannot invalidate the artifact it describes. That
 * argument is still true and it stopped being sufficient at 3.6, when
 * `check:claims` began requiring every 4+ decimal quoted in a writeup to be the
 * correct rounding of one in a COMMITTED artifact. `3.73e7` — the Σ_t df_t²
 * figure this script computes, quoted twice in ROADMAP.md — has no committed
 * artifact, so it is a permanent reported gap: a correct number the mechanism
 * can never confirm. A standing exception is exactly how a check stops being
 * believed. The read-only property is preserved where it matters: this writes
 * only its own report, under its own name, and touches no input.
 *
 * It builds the same index the runner builds, through the same retrieval/ entry
 * point, so it cannot describe a configuration the harness would not produce.
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

// The report, accumulated rather than printed straight out, so the same bytes
// go to stdout and to the file. Two formatters would drift.
const OUT = [];
const w = (line = '') => OUT.push(line);

function parseArgs(argv) {
  const args = { site: 'cooking', split: 'dev', write: true };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--no-write') args.write = false;
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

  w(`ANALYSE VOCABULARY — ${args.site}, N=${docs.length}, ${args.split} ${queryIds.length} queries`);
  w('='.repeat(78));
  w();
  w('  Both arms are v3-tfidf; only topN moves, so the two rows are one');
  w('  variable apart and the ratio between them is what truncation buys.');
  w();

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

  w('  INDEX AND THE EDGE-EMISSION BOUND');
  w('  ' + '-'.repeat(76));
  w('                                 full vocabulary        top-10        ratio');
  const line = (label, a, b, exp) => {
    const s = (v) => (exp ? v.toExponential(4) : fmt(v));
    w(`  ${label.padEnd(28)} ${s(a).padStart(16)} ${s(b).padStart(13)}   ${(a / b).toFixed(2)}x`);
  };
  line('|V| (terms with postings)', full.vocabulary, top10.vocabulary);
  line('postings  Sigma_t df_t', full.postings, top10.postings);
  line('Sigma_t df_t^2', full.sumSq, top10.sumSq, true);
  line('max df', full.maxDf, top10.maxDf);
  w();
  w('  Sigma_t df_t^2 is the ALL-PAIRS edge-emission cost — what Phase 4 pays when');
  w('  the app rebuilds a graph over N documents. The eval never pays it: it runs');
  w(`  ${queryIds.length} queries, not ${fmt(docs.length)}^2. Reporting one as though it bounded the other`);
  w('  is the error CLAUDE.md names.');
  w();

  w('  PER-DOCUMENT AND PER-QUERY COST');
  w('  ' + '-'.repeat(76));
  for (const r of rows) {
    const label = r.topN === null ? 'full vocabulary' : `topN ${r.topN}`;
    w(`  ${label}`);
    w(
      `    terms/doc          mean ${r.mean(r.termsPerDoc).toFixed(1).padStart(8)}  p50 ${String(quantile(r.termsPerDoc, 0.5)).padStart(6)}` +
      `  p95 ${String(quantile(r.termsPerDoc, 0.95)).padStart(6)}  max ${String(r.termsPerDoc[r.termsPerDoc.length - 1]).padStart(6)}`
    );
    w(
      `    candidate pool     mean ${r.mean(r.pool).toFixed(0).padStart(8)}  p50 ${String(quantile(r.pool, 0.5)).padStart(6)}` +
      `  p95 ${String(quantile(r.pool, 0.95)).padStart(6)}  max ${String(r.pool[r.pool.length - 1]).padStart(6)}`
    );
    w(
      `    postings visited   mean ${r.mean(r.work).toFixed(0).padStart(8)}  p50 ${String(quantile(r.work, 0.5)).padStart(6)}` +
      `  p95 ${String(quantile(r.work, 0.95)).padStart(6)}  max ${String(r.work[r.work.length - 1]).padStart(6)}`
    );
    const share = (100 * r.mean(r.pool)) / docs.length;
    w(`    mean pool is ${share.toFixed(1)}% of the corpus`);
    w();
  }

  w(`  Total postings visited over the whole ${args.split} run:`);
  for (const r of rows) {
    const label = r.topN === null ? 'full vocabulary' : `topN ${r.topN}`;
    w(`    ${label.padEnd(18)} ${fmt(Math.round(r.mean(r.work) * queryIds.length))}`);
  }
  w();
  w('  There is NO document-frequency cutoff. If one ever becomes necessary it');
  w('  will be a retriever PARAM that lands in describe(handle).digest, never a');
  w('  silent constant — a silent cutoff is the "run that lies about itself" of');
  w('  EVALUATION.md §13.10.');
  w();

  const text = `${OUT.join('\n')}\n`;
  process.stdout.write(text);
  if (args.write) {
    const out = path.join(REPO_ROOT, 'results', `vocabulary.${args.split}.txt`);
    fs.writeFileSync(out, text);
    process.stdout.write(`  written to ${path.relative(REPO_ROOT, out)}\n`);
  }
}

main();
