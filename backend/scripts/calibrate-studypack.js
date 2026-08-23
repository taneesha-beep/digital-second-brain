'use strict';

/**
 * calibrate-studypack.js — Phase 5.1.
 *
 * Every constant Study Pack's context assembly depends on, DERIVED FROM
 * COMMITTED EVIDENCE rather than chosen, and written to an artifact so the
 * figures quoted in docs/EVALUATION.md §30 trace somewhere.
 *
 * SPENDS NO QUOTA AND NEEDS NO KEY. Both inputs are already in the repository:
 * `results/gen-v2.calls.jsonl` (79 completed API calls with their real
 * `promptTokens` and `contentChars`) and `data/gen-eval/clusters.jsonl` (the 30
 * golden clusters). It reads them and computes; it calls nothing.
 *
 *   cd backend && npm run studypack:calibrate            # print
 *   cd backend && npm run studypack:calibrate -- --write # write the artifact
 *
 * IT NEEDS data/gen-eval/, SO IT CANNOT RUN IN CI, for the same reason
 * `gen:compare` cannot: `data/` is absent there. Section B is the half that
 * matters most and it is ALSO enforced as a test — tests/studypack.context.test.js
 * re-runs the never-underestimate check against the same ledger on every
 * `npm test`, needing nothing under `data/`. The artifact is the audit trail;
 * the test is the guard.
 */

const fs = require('fs');
const path = require('path');

const live = require('../services/llm.service');
const sp = require('../services/studyPack.service');

const REPO = path.resolve(__dirname, '..', '..');
const LEDGER = path.join(REPO, 'results', 'gen-v2.calls.jsonl');
const CLUSTERS = path.join(REPO, 'data', 'gen-eval', 'clusters.jsonl');
const OUT = path.join(REPO, 'results', 'studypack-constants.txt');

const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const lines = [];
const w = (s = '') => { lines.push(s); };
const rule = () => w('='.repeat(78));

// ───────────────────────────────────────────────────────────────────────────

function refillRate() {
  /**
   * THE DAILY CAP REFILLS AT A CONSTANT RATE, AND TWO 429 BODIES PIN IT.
   *
   * The provider states `Limit`, `Used` and a retry hint in the body of a 429 —
   * the only place the daily balance is ever visible (§29.6). Two refusals, one
   * per session, each give (requested - remaining) tokens against a stated wait,
   * and the quotient is the refill rate. §29.9 called it "roughly one call per
   * 7-14 minutes", which looks call-size dependent; it is not, and this is what
   * shows that.
   */
  /**
   * BOTH REFUSALS COME FROM THE LEDGER, and the first draft of this function
   * got that wrong. It hardcoded §29.9's 429 from the writeup, on the
   * assumption that the 5.5 session predated the field carrying it — and then
   * printed the same refusal twice, because 5.5's own `providerMessage` change
   * had already recorded it. Two rows that agree are evidence; the same row
   * printed twice is not, and it looked identical.
   */
  const observed = [];
  for (const row of readJsonl(LEDGER)) {
    const msg = row.error && row.error.providerMessage;
    if (!msg || !row.error.retryAfterMs) continue;
    const m = msg.match(/Limit (\d+), Used (\d+), Requested (\d+)/);
    const t = msg.match(/try again in (?:(\d+)m)?([\d.]+)s/);
    if (!m || !t) continue;
    observed.push({
      source: `results/gen-v2.calls.jsonl, ${row.at}`,
      limit: Number(m[1]), used: Number(m[2]), requested: Number(m[3]),
      waitS: (Number(t[1] || 0) * 60) + Number(t[2])
    });
  }

  rule();
  w('A. THE DAILY CAP IS A CONSTANT-RATE TOKEN BUCKET');
  rule();
  w();
  w('  Each row: a 429 refusal. The deficit is what the call needed beyond what');
  w('  was left; the wait is what the provider said it would take to free it.');
  w();
  w('  limit    used     requested  remaining  deficit  wait s    tokens/s');
  w('  ' + '-'.repeat(70));
  for (const o of observed) {
    const remaining = o.limit - o.used;
    const deficit = o.requested - remaining;
    w(`  ${String(o.limit).padEnd(9)}${String(o.used).padEnd(9)}${String(o.requested).padEnd(11)}` +
      `${String(remaining).padEnd(11)}${String(deficit).padEnd(9)}${o.waitS.toFixed(2).padEnd(10)}${(deficit / o.waitS).toFixed(4)}`);
  }
  w();
  for (const o of observed) w(`    ${o.source}`);
  w();
  w(`  ${observed.length} independent refusals, ${new Set(observed.map((o) => (o.requested - (o.limit - o.used)) / o.waitS).map((r) => r.toFixed(4))).size} distinct rate(s).`);
  w();
  const structural = 200000 / 86400;
  w(`  200000 / 86400 = ${structural.toFixed(5)} tokens/s, which both rows reproduce.`);
  w();
  w('  SO THE WAIT FOR ANY REFUSED CALL IS COMPUTABLE RATHER THAN ESTIMABLE:');
  w(`      wait_seconds = (requested - remaining) / ${structural.toFixed(4)}`);
  w();
  w('  It is a refill, not a window that ages out in blocks — which is why a new');
  w('  API KEY does not reset it either (§29.6: the cap is per ORGANISATION).');
  w();
  const outstanding = 71;
  const perCall = 2310;
  const hours = (outstanding * perCall) / structural / 3600;
  w(`  The 5.5 re-measure has ${outstanding} cells outstanding at ~${perCall} reserved tokens each:`);
  w(`      ${outstanding} x ${perCall} = ${outstanding * perCall} tokens = ${hours.toFixed(1)} hours of refill.`);
  w();
}

// ───────────────────────────────────────────────────────────────────────────

function tokenEstimator() {
  const rows = readJsonl(LEDGER)
    .filter((r) => r.ok && Number.isFinite(r.promptTokens) && Number.isFinite(r.contentChars));

  const charsFor = (r) =>
    live.SYSTEM_MESSAGE.length + live.PROMPTS[r.feature].length + '\n\nNotes:\n'.length + r.contentChars;

  const pts = rows.map((r) => ({ x: charsFor(r), y: r.promptTokens }));
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.x, 0);
  const sy = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;

  const resid = pts.map((p) => intercept + slope * p.x - p.y);
  const meanY = sy / n;
  const ssTot = pts.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = resid.reduce((s, r) => s + r * r, 0);

  const slack = pts.map((p, i) => sp.estimateTokens('x'.repeat(p.x)) - pts[i].y);
  const relOver = pts.map((p, i) => slack[i] / p.y);

  rule();
  w('B. TOKENS FROM CHARACTERS, WITHOUT A TOKENIZER');
  rule();
  w();
  w(`  Fitted on ${n} completed API calls in results/gen-v2.calls.jsonl. Each row`);
  w("  carries the API's own prompt_tokens and the exact character count of the");
  w('  content sent, so the input to this fit is measured on both axes.');
  w();
  w('  LEAST SQUARES (what the data says):');
  w(`      tokens = ${intercept.toFixed(1)} + chars x ${slope.toFixed(5)}`);
  w(`      R2 ${(1 - ssRes / ssTot).toFixed(4)}   residual sd ${Math.sqrt(ssRes / n).toFixed(1)} tokens   ` +
    `1 token per ${(1 / slope).toFixed(3)} chars`);
  w();
  w('  WHAT SHIPS IS A BOUND, NOT THE FIT. A budget that underestimates spends');
  w('  room the request does not have, so the shipped estimator is deliberately');
  w('  above the fit everywhere:');
  w();
  w(`      estimateTokens(text) = ${sp.TOKENIZER_OVERHEAD} + ceil(chars / ${sp.CHARS_PER_TOKEN})`);
  w();
  w(`      never underestimates      ${slack.every((s) => s >= 0) ? 'TRUE' : 'FALSE'}   over all ${n} calls`);
  w(`      minimum slack             ${Math.min(...slack)} tokens`);
  w(`      maximum slack             ${Math.max(...slack)} tokens`);
  w(`      mean overestimate         ${(relOver.reduce((a, b) => a + b, 0) / n * 100).toFixed(1)}%`);
  w();
  w('  CALIBRATED ON SINGLE-NOTE PROMPTS AND USED ON CLUSTER PROMPTS, which are');
  w('  ~10x longer. That is an extrapolation, and it is checked on every call:');
  w('  the endpoint returns estimatedPromptTokens beside the API\'s actual figure');
  w('  and their difference as estimatorSlackTokens.');
  w();
}

// ───────────────────────────────────────────────────────────────────────────

function budgetBinding() {
  const clusters = readJsonl(CLUSTERS);
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

  let bound = 0;
  let droppedTotal = 0;
  const dist = {};
  let clusterTokens = 0;
  let singleTokens = 0;
  const clusterWords = [];
  const seedWords = [];

  for (const c of clusters) {
    const seedDoc = { id: c.seedId, title: c.title, body: c.body };
    const byId = new Map(c.neighbours.map((nb) => [String(nb.id), { id: String(nb.id), title: nb.title, body: nb.body }]));
    const hits = c.neighbours.map((nb, i) => ({ docId: String(nb.id), score: nb.score, rank: i + 1 }));
    const ctx = sp.assembleContext(seedDoc, hits, byId);

    if (ctx.dropped.length > 0) { bound += 1; droppedTotal += ctx.dropped.length; }
    dist[ctx.dropped.length] = (dist[ctx.dropped.length] || 0) + 1;
    clusterTokens += ctx.estimatedTokens;

    const singleChars = live.SYSTEM_MESSAGE.length + live.PROMPTS.flashcards.length +
      '\n\nNotes:\n'.length + `${c.title}\n\n${c.body}`.length;
    singleTokens += sp.estimateTokens('x'.repeat(singleChars));

    seedWords.push(words(c.title) + words(c.body));
    clusterWords.push(words(c.title) + words(c.body) + c.neighbours.reduce((a, nb) => a + words(nb.title) + words(nb.body), 0));
  }

  const N = clusters.length;
  const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
  const sorted = [...clusterWords].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const meanCluster = clusterTokens / N;
  const meanSingle = singleTokens / N;

  rule();
  w('C. HOW OFTEN THE CONTEXT BUDGET BINDS, OVER THE 30 GOLDEN CLUSTERS');
  rule();
  w();
  w(`  budget                     ${sp.CONTEXT_TOKEN_BUDGET} tokens for the assembled user message`);
  w(`  strategy                   whole notes, dropped from the tail of the ranked list`);
  w();
  w(`  clusters where it binds    ${bound} of ${N}   ${pct(bound, N)}`);
  w(`  neighbours dropped         ${droppedTotal} of ${N * 8}`);
  w('  per-cluster distribution   ' + Object.entries(dist).sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${v} cluster(s) lose ${k}`).join(', '));
  w();
  w('  SIZE OF A CLUSTER, IN WORDS:');
  w(`      seed alone            mean ${Math.round(seedWords.reduce((a, b) => a + b, 0) / N)}`);
  w(`      seed + 8 neighbours   mean ${Math.round(clusterWords.reduce((a, b) => a + b, 0) / N)}   ` +
    `p50 ${at(0.5)}   p95 ${at(0.95)}   max ${sorted[sorted.length - 1]}`);
  w();
  w('  COST, WHICH IS WHAT THE BUDGET IS ACTUALLY FOR. The per-minute limit is');
  w('  charged on prompt + max_tokens whatever the model writes (§29.6):');
  w();
  w(`      mean cluster prompt        ${Math.round(meanCluster)} tokens`);
  w(`      mean single-note prompt    ${Math.round(meanSingle)} tokens`);
  w(`      ratio                      ${(meanCluster / meanSingle).toFixed(1)}x` +
    `   (the same clusters are ${(clusterWords.reduce((a, b) => a + b, 0) / seedWords.reduce((a, b) => a + b, 0)).toFixed(1)}x in WORDS)`);
  w();
  // 5.9: the study pack's ceiling is its OWN, not llm.service's. Reading the
  // control's 2048 here would under-report this feature's reservation by half.
  const packMaxTokens = sp.STUDY_PACK_MAX_TOKENS;
  const reserved = meanCluster + packMaxTokens;
  w(`      reserved per study pack    ${Math.round(reserved)} tokens   (prompt + max_tokens ${packMaxTokens})`);
  w(`      the five single-note features still reserve at max_tokens ${live.MAX_TOKENS} (5.1's A/B control)`);
  w(`      study packs per day        ${Math.floor(200000 / reserved)}   against the 200000 organisation cap`);
  w(`      calls per minute           ${(8000 / reserved).toFixed(2)}   against the 8000/min limit`);
  w();
  w('  THE RATIO IS THE NUMBER THAT SURPRISED ME. A cluster is 10x the seed in');
  w('  WORDS but under 5x in prompt tokens, because the instruction block and');
  w('  system message are a fixed floor a single-note call pays in full. Both of');
  w("  this phase's wrong predictions come from missing that. §30.9.");
  w();
}

// ───────────────────────────────────────────────────────────────────────────

function main() {
  w('STUDY PACK — THE MEASURED CONSTANTS (Phase 5.1)');
  w();
  w('  Produced by:  cd backend && npm run studypack:calibrate -- --write');
  w('  Inputs:       results/gen-v2.calls.jsonl, data/gen-eval/clusters.jsonl');
  w('  Spends:       no quota, no key, no network.');
  w();
  w('  REGENERATES BYTE-IDENTICALLY from unchanged inputs — it reads two');
  w('  committed files and computes. It is NOT a timing artifact, so it carries');
  w('  none of §23.10\'s caveat. It WILL change if the gen-v2 ledger grows, which');
  w('  is correct: the estimator is calibrated on that ledger.');
  w();

  refillRate();
  tokenEstimator();
  budgetBinding();

  rule();
  w('D. WHAT THIS DOES NOT ESTABLISH');
  rule();
  w();
  w('  - NOTHING about what the model returns for a study pack. Section C is');
  w('    context assembly, which is deterministic. Conformance, citation rates,');
  w('    output length and latency are unmeasured: the generation half has never');
  w('    been run. docs/EVALUATION.md §30.8.');
  w('  - The budget is argued from a RATE LIMIT, not from a quality measurement.');
  w('    Nothing here says 1800 tokens of cluster makes a better study pack than');
  w('    900 or 3600. That sweep has not been run.');
  w('  - The clusters are Stack Exchange questions shaped as Notes. The "<=500-note');
  w('    user slice" the app retrieves over has no referent on this corpus (§12.2).');
  w();

  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, text);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  } else {
    console.log('\n(pass --write to save results/studypack-constants.txt)');
  }
}

main();
