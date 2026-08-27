#!/usr/bin/env node
'use strict';

/**
 * measure-estimator-bound.js — the pre-Phase-8 sweep, 27 Aug 2026
 *
 *   cd backend && npm run estimator:bound
 *   cd backend && npm run estimator:bound -- --write
 *
 * PURE. No key, no network, no `data/`. It reads three committed ledgers under
 * results/ and nothing else, so it runs anywhere `npm test` runs — a fresh
 * clone, CI, a laptop with no Docker.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: A THREE-PLACE DECIMAL WENT STALE IN THREE DOCUMENTS AND A
 * CODE COMMENT, AND NO CHECKER COULD SEE IT.
 * ---------------------------------------------------------------------------
 *
 * `services/studyPack.service.js` estimates prompt tokens as
 * `90 + ceil(chars / CHARS_PER_TOKEN)`, per span. The shipped divisor is 4.5,
 * fitted on 79 SINGLE-NOTE prompts, and §32.3 established that it does not bound
 * CLUSTER prompts.
 *
 * The corrected value was recorded as **4.333** — in CLAUDE.md, in ROADMAP's
 * open question, and hardcoded in `scripts/run-judge-eval.js`. It was derived on
 * the gen-v5 arm and it is CORRECT FOR THAT ARM. One phase later 5.7 added a
 * second arm, on which it does NOT bound; 5.7 tried to re-derive a pooled value,
 * recovered 3.437 from a single concatenated `chars` column, correctly called
 * that wrong by construction — the estimator ceils PER SPAN — wrote "no divisor
 * is quoted here", and stopped. Nobody computed the right one afterwards.
 *
 * `check:claims` scopes to FOUR OR MORE decimal places by explicit design
 * (§3.6), so a three-place ratio is outside it by construction. That scoping is
 * right and widening it is refused. What was missing is what §32.3 named: a
 * habit for the one class that matters — **a number a writer derived by hand
 * and no script ever wrote.** This is the script.
 *
 * ---------------------------------------------------------------------------
 * THE VERIFICATION THAT MAKES THE NUMBER TRUSTWORTHY, AND IT RUNS FIRST
 * ---------------------------------------------------------------------------
 *
 * Before any divisor is reported, the reconstruction below must reproduce the
 * SHIPPED `estimatedPromptTokens` on every ledger row, exactly. If it cannot,
 * the reconstruction is wrong and every divisor it computes is meaningless —
 * which is precisely how 5.7 got 3.437. The script EXITS NON-ZERO rather than
 * printing a number it cannot stand behind.
 *
 * That check is the whole reason to believe this file over the last three
 * attempts, so it is the first thing in the output rather than a footnote.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const sp = require('../services/studyPack.service');
const live = require('../services/llm.service');

const OUT = path.join(REPO, 'results', 'estimator-bound.txt');

const CLUSTER_LEDGERS = [
  { name: 'gen-v5', retriever: 'v4-bm25', file: 'results/gen-v5.calls.jsonl', phase: '5.4' },
  { name: 'gen-v7', retriever: 'v5-embeddings', file: 'results/gen-v7.calls.jsonl', phase: '5.7' }
];
const SINGLE_LEDGER = 'results/gen-v2.calls.jsonl';

// The per-request scaffolding constant. Imported rather than copied so this
// cannot drift from the service the way the divisor did.
const OVERHEAD = sp.TOKENIZER_OVERHEAD;

const readJsonl = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** One note as the model sees it — services/studyPack.service.js's renderNote. */
const renderNote = (label, title, body) => `[${label}] ${title || 'Untitled'}\n${body || ''}`;

/** services/studyPack.service.js's buildPrompt, for a given cluster size. */
function buildPrompt(noteCount) {
  return (
    `You are building a study pack from ${noteCount} related notes, shown below and numbered.\n\n` +
    `Generate ${sp.FLASHCARD_COUNT} flashcard Q&A pairs and ${sp.CONCEPT_COUNT} key concepts that draw on ` +
    'the notes AS A CLUSTER — prefer items that connect or contrast two notes over items that ' +
    'restate one.\n\n' +
    'EVERY item must carry a "source" field: the number of the note it came from. Use only the ' +
    'numbers shown above. Never invent a number.\n\n' +
    'Return ONLY a valid JSON object — no markdown, no code fences, no explanation, nothing else. ' +
    'Format exactly: {"flashcards":[{"q":"question","a":"answer","source":1}],' +
    '"concepts":[{"term":"term","definition":"one sentence definition","source":1}]}'
  );
}

/**
 * THE ESTIMATE, AT AN ARBITRARY DIVISOR, CEILED PER SPAN.
 *
 * Per span is the detail that makes this easy to get wrong and it is why a
 * divisor cannot be recovered from a single total character count: the shipped
 * estimator is `OVERHEAD + ceil(scaffold/d) + Σ ceil(note_i/d)`, and the sum of
 * ceilings is not the ceiling of the sum.
 */
function clusterEstimate(row, divisor) {
  const t = (s) => Math.ceil(String(s || '').length / divisor);
  const notes = row.context.notes;
  // The scaffolding names the number of notes OFFERED, including any the budget
  // then dropped — assembleContext() builds it before the admission loop runs.
  const offered = notes.length + (row.context.droppedCount || 0);
  let used = OVERHEAD + t(sp.STUDY_PACK_SYSTEM_MESSAGE + buildPrompt(offered) + '\n\nNotes:\n');
  for (const n of notes) used += t(renderNote(n.label, n.title, n.text));
  return used;
}

/** The single-note estimate: one span, so one ceil. */
function singleEstimate(row, divisor) {
  const chars = live.SYSTEM_MESSAGE.length + live.PROMPTS[row.feature].length +
    '\n\nNotes:\n'.length + row.contentChars;
  return OVERHEAD + Math.ceil(chars / divisor);
}

/**
 * The largest divisor for which EVERY row's estimate is >= its actual prompt
 * tokens. Bisection rather than a closed form: the per-span ceil makes the
 * estimate a step function of the divisor, so there is nothing to solve.
 *
 * Monotone in the right direction — a smaller divisor never lowers an estimate
 * — which is what makes bisection valid here and is worth stating, because it
 * is the assumption the method rests on.
 */
function tightestBound(rows, estimate) {
  let lo = 1, hi = 8;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (rows.every((r) => estimate(r, mid) - r.promptTokens >= 0)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function main() {
  const write = process.argv.includes('--write');
  const out = [];
  const w = (s = '') => { out.push(s); console.log(s); };

  w('ESTIMATOR BOUND — the study-pack token estimator against every committed call');
  w('='.repeat(78));
  w('');
  w('  PURE: reads three committed ledgers under results/ and nothing else.');
  w(`  shipped divisor   CHARS_PER_TOKEN = ${sp.CHARS_PER_TOKEN}   (services/studyPack.service.js)`);
  w(`  per-request       TOKENIZER_OVERHEAD = ${OVERHEAD}`);
  w('');

  const cluster = [];
  for (const led of CLUSTER_LEDGERS) {
    const rows = readJsonl(led.file)
      .filter((r) => r.ok && r.context && Number.isFinite(r.promptTokens));
    cluster.push({ ...led, rows });
  }
  const single = readJsonl(SINGLE_LEDGER)
    .filter((r) => r.ok && Number.isFinite(r.promptTokens) && Number.isFinite(r.contentChars));

  // ── A. THE RECONSTRUCTION CHECK. Everything below is void without it. ──
  w('A. RECONSTRUCTION — does this file reproduce what the SHIPPED code computed?');
  w('');
  w('   5.7 recovered a divisor from a single concatenated `chars` column and it was');
  w('   wrong BY CONSTRUCTION, because the estimator ceils per span. So the first');
  w('   thing checked is that this reconstruction reproduces the shipped estimate');
  w('   exactly. It does not report a divisor it cannot stand behind: a mismatch');
  w('   exits non-zero and prints nothing else.');
  w('');
  let mismatches = 0;
  let reconciled = 0;
  for (const arm of cluster) {
    let exact = 0;
    for (const r of arm.rows) {
      if (clusterEstimate(r, sp.CHARS_PER_TOKEN) === r.context.estimatedPromptTokens) exact += 1;
      else mismatches += 1;
    }
    reconciled += arm.rows.length;
    w(`   ${arm.file.padEnd(30)} ${String(exact).padStart(3)} of ${String(arm.rows.length).padStart(3)} reproduce exactly`);
  }
  w('');
  if (mismatches > 0) {
    w(`   RECONSTRUCTION FAILED on ${mismatches} row(s). No divisor is reported.`);
    process.exitCode = 1;
    return;
  }
  w(`   ${reconciled} of ${reconciled}, zero disagreement. The reconstruction is the shipped computation.`);
  w('');

  // ── B. WHERE THE SHIPPED DIVISOR BREAKS ──
  w('B. THE SHIPPED BOUND ON THE POPULATION IT SERVES');
  w('');
  w('   arm       retriever         n     under    rate      worst slack');
  w('   ' + '-'.repeat(62));
  let pooledUnder = 0;
  let pooledN = 0;
  let pooledWorst = Infinity;
  for (const arm of cluster) {
    const slacks = arm.rows.map((r) => clusterEstimate(r, sp.CHARS_PER_TOKEN) - r.promptTokens);
    const under = slacks.filter((s) => s < 0).length;
    const worst = Math.min(...slacks);
    pooledUnder += under; pooledN += slacks.length; pooledWorst = Math.min(pooledWorst, worst);
    w(`   ${arm.name.padEnd(9)} ${arm.retriever.padEnd(16)} ${String(slacks.length).padStart(3)}   ${String(under).padStart(3)}    ` +
      `${(under / slacks.length * 100).toFixed(1).padStart(5)}%   ${String(worst).padStart(6)}`);
  }
  w('   ' + '-'.repeat(62));
  w(`   pooled                      ${String(pooledN).padStart(3)}   ${String(pooledUnder).padStart(3)}    ` +
    `${(pooledUnder / pooledN * 100).toFixed(1).padStart(5)}%   ${String(pooledWorst).padStart(6)}`);
  w('');
  const singleSlacks = single.map((r) => singleEstimate(r, sp.CHARS_PER_TOKEN) - r.promptTokens);
  w(`   single-note   ${SINGLE_LEDGER}   ${single.length} rows, ` +
    `${singleSlacks.filter((s) => s < 0).length} under, worst slack ${Math.min(...singleSlacks)}`);
  w('');
  w('   THE SHIPPED BOUND HOLDS EXACTLY WHERE IT WAS FITTED AND NOWHERE ELSE. That is');
  w('   not a surprise and it is not the finding — §30.3 shipped it as a bound on');
  w('   SINGLE-NOTE prompts and said so. The finding is section C.');
  w('');

  // ── C. THE TIGHTEST BOUNDING DIVISOR, PER ARM AND POOLED ──
  w('C. THE TIGHTEST BOUNDING DIVISOR — and why the recorded value is stale');
  w('');
  const perArm = cluster.map((arm) => ({
    ...arm, d: tightestBound(arm.rows, clusterEstimate)
  }));
  const allCluster = cluster.flatMap((a) => a.rows);
  const pooledD = tightestBound(allCluster, clusterEstimate);
  const singleD = tightestBound(single, singleEstimate);

  w('   arm       retriever          n     tightest divisor that bounds EVERY call');
  w('   ' + '-'.repeat(66));
  for (const a of perArm) {
    w(`   ${a.name.padEnd(9)} ${a.retriever.padEnd(17)} ${String(a.rows.length).padStart(3)}      ${a.d.toFixed(6)}`);
  }
  w('   ' + '-'.repeat(66));
  w(`   pooled cluster                ${String(allCluster.length).padStart(3)}      ${pooledD.toFixed(6)}`);
  w(`   single-note                   ${String(single.length).padStart(3)}      ${singleD.toFixed(6)}`);
  w('');
  w('   THE RECORDED VALUE IS THE gen-v5 ROW. It was derived on that arm and is right');
  w('   for it. 5.7 added gen-v7, on which it does NOT bound, and the pooled figure was');
  w('   never recomputed — so a gen-v5-only number sat in three documents and one code');
  w('   comment as though it were the pooled one.');
  w('');
  w('   AT THE RECORDED VALUE, ACROSS BOTH ARMS:');
  const atRecorded = perArm.map((a) => a.d).sort((x, y) => x - y)[0];
  const recorded = Math.max(...perArm.map((a) => a.d));
  const stillUnder = allCluster
    .map((r) => clusterEstimate(r, recorded) - r.promptTokens)
    .filter((s) => s < 0);
  w(`     ${stillUnder.length} of ${allCluster.length} calls still underestimate, worst ${stillUnder.length ? Math.min(...stillUnder) : 0}`);
  w(`     the value that DOES bound all ${allCluster.length} is the pooled figure above`);
  w(`     (per-arm minimum ${atRecorded.toFixed(6)} is what pooling reduces to)`);
  w('');

  // ── D. WHAT A CHANGE WOULD COST ──
  w('D. THE COST OF MOVING THE CONSTANT');
  w('');
  w('   A SMALLER DIVISOR ESTIMATES MORE TOKENS PER NOTE, SO FEWER NOTES FIT THE');
  w('   1,800-TOKEN BUDGET. That is a user-visible product change and this table is');
  w('   what it costs, measured on the committed clusters rather than argued.');
  w('');
  w('   divisor     cluster under/60   worst    mean over-estimate   single under/151');
  w('   ' + '-'.repeat(74));
  for (const d of [sp.CHARS_PER_TOKEN, 4.4, 4.35, recorded, pooledD, 4.2]) {
    const cs = allCluster.map((r) => clusterEstimate(r, d) - r.promptTokens);
    const ss = single.map((r) => singleEstimate(r, d) - r.promptTokens);
    const over = allCluster.map((r) => (clusterEstimate(r, d) - r.promptTokens) / r.promptTokens);
    const mean = over.reduce((a, b) => a + b, 0) / over.length;
    w(`   ${d.toFixed(6)}   ${String(cs.filter((s) => s < 0).length).padStart(6)} / 60   ` +
      `${String(Math.min(...cs)).padStart(6)}   ${(mean * 100).toFixed(1).padStart(15)}%   ` +
      `${String(ss.filter((s) => s < 0).length).padStart(9)} / ${single.length}`);
  }
  w('   ' + '-'.repeat(74));
  w('');
  w('   THE FAILURE MODE OF AN UNDERESTIMATE IS NARROWER THAN THE TEST COMMENT SAYS,');
  w('   AND STATING IT NARROWLY IS THE HONEST THING. CONTEXT_TOKEN_BUDGET is 1,800 —');
  w('   a self-imposed budget set by the RATE LIMIT, far below this model\'s context');
  w('   window. So an underestimate does not overflow anything: it means one more note');
  w('   was admitted than the budget intended, and the reservation was that much low.');
  w('   The guarantee that breaks is "the assembled prompt is at most 1,800 estimated');
  w('   tokens", not "the request fits".');
  w('');
  w('   WHAT THIS FILE DOES NOT ESTABLISH: the right value for a FUTURE population.');
  w('   Every row here was drawn at max_tokens 2048 and the feature ships at 4096.');
  w('   A divisor fitted on 60 calls bounds those 60 calls. §32.2\'s rule stands.');
  w('');

  if (write) {
    fs.writeFileSync(OUT, out.join('\n') + '\n');
    console.log(`\n  wrote ${path.relative(REPO, OUT)}`);
  } else {
    console.log('\n  (plan only — pass --write to update results/estimator-bound.txt)');
  }
}

if (require.main === module) main();
module.exports = { clusterEstimate, singleEstimate, tightestBound, buildPrompt, renderNote };
