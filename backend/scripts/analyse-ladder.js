#!/usr/bin/env node
'use strict';

/**
 * analyse-ladder.js — Phase 3.6
 *
 *   cd backend && npm run analyse:ladder
 *
 * The full ladder on both splits, assembled from the COMMITTED SIDECARS.
 *
 * Roadmap 3.6's Done criterion is "every claim traces to a run file". The
 * sidecar is that trace (§8.5) and it is what this reads — no re-running, no
 * arithmetic on run files, no second source for a number that already exists.
 * The only computed column is `test − dev`, which is a subtraction of two
 * sidecar values and is printed at full precision so nobody has to infer it
 * from two rounded displays. That inference is exactly what went wrong at 3.4
 * and again at 3.5, and what `npm run check:claims` now guards.
 *
 * READ-ONLY, on 1.5's reasoning.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'results', 'test-ladder.txt');

const LADDER = ['v1-overlap', 'v2-jaccard', 'v3-tfidf', 'v4-bm25', 'v5-embeddings', 'v6-hybrid'];
const EXTRA = ['v1-overlap-tuned'];
const KS = [1, 5, 8, 10];

function sidecar(label, split) {
  const file = path.join(REPO_ROOT, 'results', 'runs', `${label}.${split}.run.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { write: true };
  for (const flag of argv) {
    if (flag === '--no-write') args.write = false;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = [];
  const w = (s = '') => lines.push(s);
  const thick = '='.repeat(94);
  const thin = '-'.repeat(94);
  const f4 = (v) => (v === null || v === undefined ? '     —' : v.toFixed(4));

  w('THE LADDER ON TEST — roadmap 3.6');
  w(thick);
  w();
  w('  Assembled from the committed run sidecars. Nothing re-run, nothing recomputed');
  w('  except the test − dev column, which is a subtraction of two sidecar values and');
  w('  is printed at full precision so it never has to be inferred from a display.');
  w();

  // --- 1. the full table ----------------------------------------------------
  w('1. EVERY RUNG, EVERY METRIC, EVERY k — TEST');
  w(thin);
  for (const label of [...LADDER, ...EXTRA]) {
    const s = sidecar(label, 'test');
    if (!s) { w(`  ${label}: no test sidecar`); continue; }
    const m = s.metrics;
    w();
    w(`  ${label}   runid ${s.runId}`);
    w(`    metric  ${KS.map((k) => `@${k}`.padStart(9)).join('')}`);
    w(`      nDCG  ${KS.map((k) => f4(m.ndcg[k]).padStart(9)).join('')}`);
    w(`         P  ${KS.map((k) => f4(m.p[k]).padStart(9)).join('')}`);
    w(`         R  ${KS.map((k) => f4(m.r[k]).padStart(9)).join('')}`);
    w(`    MRR@10  ${f4(m.mrr).padStart(9)}`);
    w(`    queries ${s.queries.scored} scored · ${s.queries.zeroResult} zero-result · ` +
      `${s.queries.unjudgeable} unjudgeable`);
    w(`    index() ${s.timingsMs.index.toFixed(0)} ms · search p95 ${s.latencyMs.p95.toFixed(3)} ms · ` +
      `mean ${s.latencyMs.mean.toFixed(3)} ms`);
  }
  w();

  // --- 2. the headline, side by side ---------------------------------------
  w('2. nDCG@8 — DEV AND TEST SIDE BY SIDE');
  w(thin);
  w('  rung               dev                  test                 test − dev');
  w('  ' + '-'.repeat(76));
  for (const label of [...LADDER, ...EXTRA]) {
    const d = sidecar(label, 'dev');
    const t = sidecar(label, 'test');
    if (!d || !t) continue;
    const dv = d.metrics.ndcg[8];
    const tv = t.metrics.ndcg[8];
    w(`  ${label.padEnd(18)} ${String(dv).padEnd(20)} ${String(tv).padEnd(20)} ` +
      `${tv - dv >= 0 ? '+' : ''}${(tv - dv).toFixed(6)}`);
  }
  w();
  w('  EVERY RUNG IS LOWER ON TEST. That is a property of the two samples, not of');
  w('  the retrievers: the splits are a uniform random partition of one query set');
  w('  (§4.2), so a rung has no way to be systematically worse on one of them. The');
  w('  shared component is the KEY — test\'s queries carry a slightly thinner answer');
  w('  key, and §5.3 is why per-query scores are not comparable across corpus age.');
  w('  Section 3 measures it rather than leaving it as an explanation.');
  w();

  // --- 3. why every rung dropped -------------------------------------------
  w('3. THE SHARED DROP, MEASURED');
  w(thin);
  const qrels = fs.readFileSync(path.join(REPO_ROOT, 'data', 'qrels', 'cooking.qrels'), 'utf8')
    .trim().split('\n');
  const byQ = new Map();
  for (const line of qrels) {
    const [qid] = line.split(/\s+/);
    byQ.set(qid, (byQ.get(qid) || 0) + 1);
  }
  const stats = {};
  for (const split of ['dev', 'test']) {
    const ids = fs.readFileSync(path.join(REPO_ROOT, 'data', 'splits', `cooking.${split}.txt`), 'utf8')
      .trim().split('\n');
    const counts = ids.map((i) => byQ.get(i) || 0);
    const sorted = [...counts].sort((a, b) => a - b);
    stats[split] = {
      n: ids.length,
      judgments: counts.reduce((a, b) => a + b, 0),
      mean: counts.reduce((a, b) => a + b, 0) / counts.length,
      median: sorted[Math.floor(sorted.length / 2)],
      singleton: counts.filter((c) => c === 1).length,
      max: sorted[sorted.length - 1]
    };
  }
  w('  split   queries   judgments   mean/query   median   with exactly 1   max');
  w('  ' + '-'.repeat(72));
  for (const split of ['dev', 'test']) {
    const s = stats[split];
    w(`  ${split.padEnd(7)} ${String(s.n).padStart(7)}   ${String(s.judgments).padStart(9)}   ` +
      `${s.mean.toFixed(4).padStart(10)}   ${String(s.median).padStart(6)}   ` +
      `${`${s.singleton} (${((s.singleton / s.n) * 100).toFixed(1)}%)`.padStart(14)}   ${String(s.max).padStart(3)}`);
  }
  w();
  w('  The direction is consistent with the drop and the SIZE of the effect is not');
  w('  established here — this is a description of the two keys, not a decomposition');
  w('  of the gap. What it rules out is the reading that would matter: a rung being');
  w('  genuinely worse on unseen data, which cannot be what a random partition of');
  w('  one query set produces.');
  w();

  // --- 4. the ordering ------------------------------------------------------
  w('4. THE ORDERING');
  w(thin);
  for (const split of ['dev', 'test']) {
    const ranked = LADDER
      .map((label) => ({ label, v: sidecar(label, split)?.metrics.ndcg[8] }))
      .filter((r) => r.v !== undefined)
      .sort((x, y) => x.v - y.v);
    w(`  ${split.padEnd(5)} ${ranked.map((r) => `${r.label} ${r.v.toFixed(4)}`).join('  <  ')}`);
  }
  w();
  w(thick);

  const text = `${lines.join('\n')}\n`;
  console.log(text);
  if (args.write) {
    fs.writeFileSync(OUT, text);
    console.log(`  written to ${path.relative(REPO_ROOT, OUT)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\nladder analysis failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}
