#!/usr/bin/env node
'use strict';

/**
 * price-study-pack.js — `npm run cost:pack`. Phase 6.2.
 *
 * PURE. No key, no network, no database, no gitignored corpus. It reads one
 * committed artifact — results/gen-v5.calls.jsonl — and multiplies by the
 * published rate table in observability/cost.js. It writes
 * results/studypack-cost.txt.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND WHY IT IS THE ONLY SURVIVOR OF A CUT PHASE.
 *
 * ROADMAP 6.5 — "cost and latency budget" — is CUT, and EVALUATION §35.5a makes
 * that permanent: an honest budget needs a CONTROLLED measurement, and
 * results/app-adapter.analysis.txt already refuses to stand in for one. Exactly
 * ONE row of that table was free, because it needs no controlled environment at
 * all: COST PER STUDY PACK is measured actual tokens times a published rate,
 * and both sides are committed. This computes that row and nothing else. It is
 * deliberately not a budget table with one row filled and the rest blank.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT SHARES THE RATE TABLE WITH THE SPAN ON PURPOSE.
 *
 * observability/cost.js prices the `llm-call` span at runtime, and it prices
 * this artifact. One rate, one date stamp, one place to edit. A second copy of
 * $0.15 in this file would be §28.9's defect built by hand — a constant with no
 * checksum, free to drift from the one the app actually uses.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ THREE THINGS THE OUTPUT MUST KEEP SAYING, AND WHY.
 *
 * 1. IT IS A LIST PRICE, NOT AN INVOICE. This project is on Groq's free tier;
 *    the real charge is $0.00 (PRIMER §8.3). Groq also applies automatic prompt
 *    caching at half rate on cached input, and nothing here observes whether a
 *    call hit it, so a real bill would be the same or lower.
 *
 * 2. IT IS CENSORED, AND SO IT IS A LOWER BOUND FOR THE SHIPPED CONFIGURATION.
 *    The ledger was produced at max_tokens 2048 and 5.9 raised the study pack's
 *    ceiling to 4096. Calls that finished `length` were CUT OFF at exactly the
 *    quantity being priced — they would have emitted more output tokens, and
 *    output is the expensive side. The script reports the truncated share so
 *    the direction of the bias is visible rather than implied.
 *
 * 3. IT IS NOT A LATENCY FIGURE AND WILL NEVER ACQUIRE ONE. The ledger carries
 *    latencyMs per call. It is not read here and must not be: §35.5a makes
 *    "uncontrolled" a final state for this project, and the whole reason 6.5
 *    was cut is that these numbers cannot become a budget.
 */

const fs = require('fs');
const path = require('path');

const { RATE_SOURCE, RATES_PER_MILLION, computeCostUsd } = require('../observability/cost');

const RESULTS = path.join(__dirname, '..', '..', 'results');
const LEDGER = path.join(RESULTS, 'gen-v5.calls.jsonl');
const OUT = path.join(RESULTS, 'studypack-cost.txt');

function readLedger() {
  if (!fs.existsSync(LEDGER)) {
    console.error(`Ledger not found: ${LEDGER}`);
    console.error('This script reads a COMMITTED artifact and cannot regenerate it.');
    process.exit(1);
  }
  return fs.readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
};
const usd = (n) => `$${n.toFixed(6)}`;

function main() {
  const rows = readLedger();
  const ok = rows.filter((r) => r.ok);

  // §29.4's guard, reproduced rather than assumed: a ledger mixing models,
  // ceilings or temperatures cannot be priced as one population.
  const models = [...new Set(ok.map((r) => r.model))];
  const ceilings = [...new Set(ok.map((r) => r.maxTokens))];
  const temps = [...new Set(ok.map((r) => r.temperature))];
  if (models.length !== 1 || ceilings.length !== 1 || temps.length !== 1) {
    console.error('REFUSING: the ledger is not one population.');
    console.error(`  models ${models.join(', ')} | maxTokens ${ceilings.join(', ')} | temperature ${temps.join(', ')}`);
    process.exit(1);
  }

  const [model] = models;
  const [ceiling] = ceilings;
  const rate = RATES_PER_MILLION[model];
  if (!rate) {
    console.error(`REFUSING: no published rate for ${model} in observability/cost.js.`);
    process.exit(1);
  }

  const inTok = ok.map((r) => r.promptTokens);
  const outTok = ok.map((r) => r.completionTokens);
  const reasoning = ok.map((r) => r.reasoningTokens || 0);
  const costs = ok.map((r) => computeCostUsd(model, r.promptTokens, r.completionTokens).usd);

  const truncated = ok.filter((r) => r.finishReason === 'length');
  const completed = ok.filter((r) => r.finishReason === 'stop');
  const costOf = (rs) => rs.map((r) => computeCostUsd(model, r.promptTokens, r.completionTokens).usd);

  const inputCost = sum(inTok) * rate.input / 1e6;
  const outputCost = sum(outTok) * rate.output / 1e6;
  const reasoningCost = sum(reasoning) * rate.output / 1e6;
  const total = inputCost + outputCost;

  const L = [];
  const w = (s = '') => L.push(s);
  const rule = () => w('='.repeat(78));

  w('COST PER STUDY PACK — Phase 6.2');
  rule();
  w();
  w('Generated by `npm run cost:pack` (backend/scripts/price-study-pack.js).');
  w('PURE: no key, no network, no database, no gitignored corpus. It reads one');
  w('committed ledger and multiplies by a published rate table.');
  w();
  w('  ledger      results/gen-v5.calls.jsonl');
  w('  rates       backend/observability/cost.js   (the SAME table that prices');
  w('              the llm-call span at runtime — one rate, one place to edit)');
  w(`  rate stamp  ${RATE_SOURCE}`);
  w();
  w('⚠️  THIS IS A PUBLISHED LIST PRICE. IT IS NOT MONEY ANYBODY WAS CHARGED.');
  w('    This project runs on Groq\'s free tier and the real invoice is $0.00.');
  w('    PRIMER §8.3 said so before any of this was built: token counts are real');
  w('    regardless of price, and price is a multiplier applied afterwards. The');
  w('    claim these numbers support is "per-request token cost was attributed');
  w('    through the pipeline" — never the size of a bill.');
  w();
  w('⚠️  NOT A LATENCY FIGURE, AND THIS FILE WILL NEVER CARRY ONE. ROADMAP 6.5 is');
  w('    CUT and EVALUATION §35.5a makes "uncontrolled" a final state here. The');
  w('    ledger has a latencyMs column; it is deliberately not read.');
  w();
  rule();
  w('A. THE POPULATION');
  rule();
  w();
  w(`  calls priced           ${ok.length} of ${rows.length} ledger rows (${rows.length - ok.length} error rows excluded)`);
  w(`  model                  ${model}`);
  w(`  max_tokens             ${ceiling}    <- the SHIPPED ceiling is 4096 since 5.9`);
  w(`  temperature            ${temps[0]}`);
  w(`  published rate         input $${rate.input.toFixed(2)}/1M   output $${rate.output.toFixed(2)}/1M`);
  w(`                         cached input $${rate.cachedInput.toFixed(3)}/1M — NOT applied, see D`);
  w();
  rule();
  w('B. THE ROW THAT SURVIVED 6.5');
  rule();
  w();
  w(`  input tokens           ${sum(inTok).toLocaleString().padStart(9)}  ->  ${usd(inputCost)}`);
  w(`  output tokens          ${sum(outTok).toLocaleString().padStart(9)}  ->  ${usd(outputCost)}`);
  w(`  ${'-'.repeat(56)}`);
  w(`  total actual tokens    ${sum(inTok.map((v, i) => v + outTok[i])).toLocaleString().padStart(9)}  ->  ${usd(total)}   over ${ok.length} calls`);
  w();
  w(`  COST PER STUDY PACK    ${usd(mean(costs))}      sd ${usd(sd(costs))}`);
  w(`    median               ${usd([...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)])}`);
  w(`    min / max            ${usd(Math.min(...costs))} / ${usd(Math.max(...costs))}`);
  w();
  w('  For scale, and stated as arithmetic rather than as a forecast:');
  w(`    1,000 study packs    ${usd(mean(costs) * 1000)}`);
  w();
  rule();
  w('C. WHERE THE MONEY GOES, AND IT IS NOT WHERE THE TOKENS ARE');
  rule();
  w();
  const outShare = 100 * outputCost / total;
  const inShareTok = 100 * sum(inTok) / (sum(inTok) + sum(outTok));
  w(`  input is  ${inShareTok.toFixed(1)}% of the TOKENS but ${(100 - outShare).toFixed(1)}% of the COST`);
  w(`  output is ${(100 - inShareTok).toFixed(1)}% of the TOKENS but ${outShare.toFixed(1)}% of the COST`);
  w(`  because output is priced ${(rate.output / rate.input).toFixed(1)}x input.`);
  w();
  w('  AND MOST OF THE OUTPUT IS REASONING NOBODY EVER READS:');
  w();
  w(`    reasoning tokens     ${sum(reasoning).toLocaleString().padStart(9)}  of ${sum(outTok).toLocaleString()} output  (${(100 * sum(reasoning) / sum(outTok)).toFixed(1)}%)`);
  w(`    priced at            ${usd(reasoningCost)}  of ${usd(total)}  (${(100 * reasoningCost / total).toFixed(1)}% of the bill)`);
  w();
  w('  gpt-oss-120b is a reasoning model and Groq bills reasoning tokens inside');
  w('  completion_tokens at the output rate. They are not returned to the user');
  w('  and no metric in this repository scores them. Reported because a cost');
  w('  attribution that hides the majority of its own bill is not an attribution.');
  w();
  rule();
  w('D. WHY THIS IS A LOWER BOUND, NOT AN ESTIMATE');
  rule();
  w();
  w(`  finished "length"      ${truncated.length} of ${ok.length}  (${(100 * truncated.length / ok.length).toFixed(1)}%)`);
  w(`  finished "stop"        ${completed.length} of ${ok.length}`);
  w();
  w(`    mean cost, truncated ${usd(mean(costOf(truncated)))}`);
  w(`    mean cost, completed ${usd(mean(costOf(completed)))}`);
  w();
  w(`  THE LEDGER IS CENSORED AT EXACTLY THE QUANTITY BEING PRICED. ${truncated.length} of ${ok.length} calls`);
  w(`  hit the ${ceiling}-token ceiling and stopped mid-output. Those calls would have`);
  w('  emitted MORE output tokens if allowed to finish, and output is the');
  w('  expensive side — so the true mean is HIGHER than the figure in section B,');
  w('  by an amount this run structurally cannot report. EVALUATION §35.3 makes');
  w('  the general form of this argument: every run is censored at exactly the');
  w('  quantity being estimated, which is why 5.9\'s new ceiling was PICKED and');
  w('  not DERIVED.');
  w();
  w(`  AND THE SHIPPED CEILING IS NO LONGER ${ceiling}. It is 4096 (5.9, for the study`);
  w('  pack only; llm.service.js still holds 2048). So section B prices a');
  w('  CONFIGURATION THAT IS NO LONGER SHIPPED. Re-pricing needs a fresh 30-call');
  w('  run at 4096 — the same run EVALUATION §35.3 says the post-change');
  w('  truncation rate needs, and it has not been made.');
  w();
  w('  Two smaller reasons the real charge is at or below this figure:');
  w('    - Groq applies automatic prompt caching to this model at half rate on');
  w('      cached input. Nothing here observes cache hits, so every input token');
  w('      is priced at the full rate.');
  w('    - The free tier charges quota, not money. Quota is enforced on ACTUAL');
  w('      tokens (EVALUATION §30.1), which is what this prices.');
  w();
  rule();
  w('E. WHAT 6.5 WOULD HAVE ASKED');
  rule();
  w();
  w('  The cut item drafted one target for this row: cost per Study Pack');
  w(`  < $0.005. The measured figure is ${usd(mean(costs))}, which clears it by`);
  w(`  ${(0.005 / mean(costs)).toFixed(1)}x even before noting that the free tier charges nothing.`);
  w();
  w('  REPORTED AS ARITHMETIC, NOT AS A PASSED BUDGET. A budget is a target set');
  w('  BEFORE measuring and then reported pass/fail across every row; this is one');
  w('  row of a table whose other rows were cut because they need a controlled');
  w('  environment this project has decided never to build. Calling it "within');
  w('  budget" would be reconstructing the deliverable that was cut, out of the');
  w('  one piece of it that happened to be free.');
  w();
  rule();
  w('ENVIRONMENT');
  rule();
  w();
  w('  Arithmetic over a committed artifact. No environment affects the result:');
  w('  the same ledger and the same rate table produce the same numbers on any');
  w('  machine, which is why this file quotes no hardware.');
  w();
  w('  Ledger produced 20 Aug 2026 (Phase 5.4), 30 of 30 golden seeds.');
  w(`  Rates read 23 Aug 2026 from https://console.groq.com/docs/model/${model}`);
  w();

  const text = L.join('\n');
  fs.writeFileSync(OUT, text);
  console.log(text);
  console.log(`\nWrote ${path.relative(path.join(__dirname, '..', '..'), OUT)}`);
}

main();
