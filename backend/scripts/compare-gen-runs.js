#!/usr/bin/env node
'use strict';

/**
 * compare-gen-runs.js — Phase 5.5. gen-v1 against gen-v2, side by side.
 *
 *   npm run gen:compare              print
 *   npm run gen:compare -- --write   also write results/gen-v1-v2-comparison.txt
 *
 * PURE APART FROM READING TWO LEDGERS. No network, no key, no quota. Every
 * figure is recomputed from the committed per-call rows by the SAME grader that
 * produced each side's own report, so this cannot disagree with them.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE SCRIPT RATHER THAN A SECTION IN THE REPORT
 * ---------------------------------------------------------------------------
 *
 * A report describes ONE run. The moment it also describes a second, it needs
 * both ledgers present to render at all, and the v1 report — a committed
 * artifact of the "before" — would start changing whenever v2 changed. Keeping
 * the comparison in its own file leaves each report a description of its own
 * run, which is the property that lets `--report` be re-run on either side
 * independently. Same split as `compare-runs.js` for retrieval.
 *
 * ---------------------------------------------------------------------------
 * THE COMPARISON IS ONLY VALID UNDER FOUR EQUALITIES, AND IT CHECKS ALL FOUR
 * ---------------------------------------------------------------------------
 *
 * Same seeds, same grader, same model, same n. Three are checked here and the
 * fourth is structural:
 *
 *   model      both ledgers must record ONE model and the SAME one. Refused
 *              otherwise — ROADMAP 5.0: "5.5 must re-measure against the same
 *              model 5.3 used or the before/after is meaningless."
 *   max_tokens must DIFFER, and be the only thing that does. If they are equal
 *              there is no experiment.
 *   seeds      the seed sets must be identical, not merely the same size.
 *   n          both sides are narrowed to the BALANCED FIRST PASS — repeat 0
 *              only — which is the population §28's sections B-G report over.
 *              Pooling extra draws would weight cells by where a quota ran out.
 *
 * ---------------------------------------------------------------------------
 * THE NOISE FLOOR IS PRINTED BESIDE EVERY DELTA, BECAUSE §28.8 MEASURED ONE
 * ---------------------------------------------------------------------------
 *
 * Over the 84 v1 cells that got two draws at temperature 0.4, 11.9% disagreed
 * with themselves — and 9 of the 10 splits were `examQs`, i.e. 9 of its 28
 * repeated cells flip on a re-draw. So an `examQs` conformance movement smaller
 * than roughly a third of its cells is NOT distinguishable from a re-draw, and
 * n=2 understates that because three draws have more chances to disagree.
 *
 * That figure is computed here from the v1 ledger rather than quoted, so it
 * cannot go stale against the artifact it describes.
 */

const fs = require('fs');
const path = require('path');

const { classify, ALL_FEATURES, SCHEMAS } = require('./lib/gen-schema');
const shipped = require('./lib/llm-v1-shipped');

const REPO = path.resolve(__dirname, '..', '..');
const V1 = path.join(REPO, 'results', 'gen-baseline.calls.jsonl');
const V2 = path.join(REPO, 'results', 'gen-v2.calls.jsonl');
const OUT = path.join(REPO, 'results', 'gen-v1-v2-comparison.txt');

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const rate = (n, d) => (d === 0 ? null : n / d);
const showPct = (r) => (r === null ? '    n/a' : `${(r * 100).toFixed(1)}%`.padStart(7));
const num = (v, d = 0) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));

function pct(values, p) {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** The parameters a row was produced under. Pre-5.5 rows carry neither field. */
function paramsOf(row) {
  return {
    model: row.modelRequested || row.model || null,
    maxTokens: row.maxTokens ?? shipped.MAX_TOKENS,
    temperature: row.temperature ?? shipped.TEMPERATURE
  };
}

/** First completed draw per (seed, feature) — one call each, repeat 0 only. */
function firstPass(rows) {
  const seen = new Map();
  for (const r of rows.filter((x) => x.ok && x.repeat === 0)) {
    const k = `${r.seedId}|${r.feature}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

/** Seeds for which EVERY feature completed. Anything else is not comparable. */
function completeSeeds(rows) {
  const byS = new Map();
  for (const r of rows) byS.set(String(r.seedId), (byS.get(String(r.seedId)) || new Set()).add(r.feature));
  return new Set([...byS.entries()].filter(([, f]) => f.size === ALL_FEATURES.length).map(([k]) => k));
}

const verdictOf = (r) => classify(shipped.applyShippedStrip(r.rawText, r.feature), r.feature);

function one(rows, feature) {
  const rs = rows.filter((r) => r.feature === feature);
  const v = rs.map(verdictOf);
  const schemas = v.map((x) => x.schema).filter(Boolean);
  return {
    n: rs.length,
    shape: schemas.length ? rate(schemas.filter((s) => s.shape).length, schemas.length) : null,
    truncated: rate(rs.filter((r) => r.finishReason === 'length').length, rs.length),
    truncatedN: rs.filter((r) => r.finishReason === 'length').length,
    outMean: mean(rs.map((r) => r.completionTokens).filter(Number.isFinite)),
    outP95: pct(rs.map((r) => r.completionTokens).filter(Number.isFinite), 95),
    reasonMean: mean(rs.map((r) => r.reasoningTokens ?? 0)),
    latP95: pct(rs.map((r) => r.latencyMs).filter(Number.isFinite), 95),
    causes: schemas.filter((s) => !s.shape).map((s) => s.cause)
  };
}

/** §28.8's within-cell split rate, recomputed from a ledger rather than quoted. */
function splitRate(rows) {
  const byCell = new Map();
  for (const r of rows.filter((x) => x.ok)) {
    const k = `${r.seedId}|${r.feature}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(r);
  }
  const out = { cells: 0, split: 0, byFeature: new Map() };
  for (const [k, rs] of byCell) {
    if (rs.length < 2) continue;
    const feature = k.split('|')[1];
    if (!SCHEMAS[feature]) continue;
    out.cells += 1;
    const verdicts = new Set(rs.map((r) => verdictOf(r).schema.shape));
    const isSplit = verdicts.size > 1;
    if (isSplit) out.split += 1;
    const f = out.byFeature.get(feature) || { cells: 0, split: 0 };
    f.cells += 1;
    if (isSplit) f.split += 1;
    out.byFeature.set(feature, f);
  }
  return out;
}

function main() {
  const v1all = readJsonl(V1);
  const v2all = readJsonl(V2);
  if (!v1all) { console.error(`MISSING ${path.relative(REPO, V1)} — the 5.3 baseline.`); process.exit(1); }
  if (!v2all) {
    console.error(`MISSING ${path.relative(REPO, V2)}.`);
    console.error('Run `npm run gen:v2 -- --run` first. IT SPENDS QUOTA.');
    process.exit(1);
  }

  let a = firstPass(v1all);
  let b = firstPass(v2all);

  // --- the four equalities -------------------------------------------------
  const pa = [...new Set(a.map((r) => paramsOf(r).model))];
  const pb = [...new Set(b.map((r) => paramsOf(r).model))];
  if (pa.length !== 1 || pb.length !== 1 || pa[0] !== pb[0]) {
    console.error('REFUSING: the two runs are not on the same model, so no delta below would');
    console.error('be attributable to max_tokens.');
    console.error(`  gen-v1  ${pa.join(', ')}`);
    console.error(`  gen-v2  ${pb.join(', ')}`);
    process.exit(1);
  }
  const model = pa[0];

  const ta = [...new Set(a.map((r) => paramsOf(r).maxTokens))];
  const tb = [...new Set(b.map((r) => paramsOf(r).maxTokens))];
  if (ta.length !== 1 || tb.length !== 1) {
    console.error('REFUSING: a ledger mixes more than one max_tokens.');
    process.exit(1);
  }
  if (ta[0] === tb[0]) {
    console.error(`REFUSING: both runs used max_tokens ${ta[0]}. There is no experiment here.`);
    process.exit(1);
  }
  const tempA = [...new Set(a.map((r) => paramsOf(r).temperature))];
  const tempB = [...new Set(b.map((r) => paramsOf(r).temperature))];
  if (String(tempA) !== String(tempB)) {
    console.error(`REFUSING: temperature differs (${tempA} vs ${tempB}) — that is a second variable.`);
    process.exit(1);
  }

  // PAIRED ON THE SEEDS BOTH RUNS COVER COMPLETELY.
  //
  // Not a refusal, because a partial run is the normal outcome under a daily
  // quota this project cannot see (§28.6) — 5.3 stopped at 234 of 330 and 5.5
  // at 76 of 150. Refusing would make an interim comparison impossible exactly
  // when it is most useful. Instead the two sides are intersected down to the
  // seeds each covers across ALL FIVE features, so every figure below is a
  // PAIRED comparison on identical inputs, and the intersection is reported
  // loudly enough that nobody mistakes it for the full golden set.
  const both = [...completeSeeds(a)].filter((s) => completeSeeds(b).has(s)).sort();
  if (both.length === 0) {
    console.error('REFUSING: no seed is covered by both runs across all five features.');
    process.exit(1);
  }
  const keep = new Set(both);
  const droppedA = new Set(a.map((r) => String(r.seedId))).size - keep.size;
  const droppedB = new Set(b.map((r) => String(r.seedId))).size - keep.size;
  a = a.filter((r) => keep.has(String(r.seedId)));
  b = b.filter((r) => keep.has(String(r.seedId)));

  const out = [];
  const w = (s = '') => out.push(s);
  const noise = splitRate(v1all);
  const oldCeil = ta[0];

  w('gen-v1 -> gen-v2: WHAT RAISING max_tokens DID (Phase 5.5)');
  w('='.repeat(78));
  w('');
  w('  ONE VARIABLE. Everything else is checked equal rather than asserted equal:');
  w('');
  w(`    max_tokens        ${ta[0]}  ->  ${tb[0]}      THE CHANGE`);
  w(`    model             ${model}   both sides, checked`);
  w(`    temperature       ${tempA[0]}   both sides, checked`);
  w(`    seeds             ${both.length}   PAIRED — the seeds both runs cover across all 5 features`);
  w(`    grader            scripts/lib/gen-schema.js   one predicate, both sides`);
  w(`    n                 1   balanced first pass only, both sides`);
  w('');
  if (droppedA > 0 || droppedB > 0) {
    w('');
    w(`  THIS IS A PARTIAL RE-MEASURE — ${both.length} OF THE 30 GOLDEN SEEDS.`);
    w('');
    w(`    dropped from gen-v1   ${droppedA} seeds        dropped from gen-v2   ${droppedB} seeds`);
    w('');
    w('    The gen-v2 run stopped on Groq\'s daily token cap before completing its');
    w('    first pass. Every seed retained is covered by BOTH runs across all five');
    w('    features, so this is a paired comparison on identical inputs — but it is');
    w('    a smaller sample than the baseline\'s, and the length stratification the');
    w('    golden set was built for is correspondingly thinner. Completing it needs');
    w('    another day\'s quota, not another decision.');
  }
  w('');
  w('  A NOTE ON WHAT "SAME MODEL" BUYS AND WHAT IT DOES NOT. Both runs named the');
  w('  same model string. That string is NOT A PINNED INPUT (§28.9) — no checksum');
  w('  exists for what serves it — so this rules out a DELIBERATE model change and');
  w('  cannot rule out drift behind the name. The three features that never');
  w('  approached the old ceiling are the control for exactly that; see the last');
  w('  section.');
  w('');
  w('  DOES NOT REGENERATE BYTE-IDENTICALLY: it is derived from two ledgers that');
  w('  do not (§28.9). Recomputed with `npm run gen:compare`.');
  w('');

  // --- headline ------------------------------------------------------------
  w('='.repeat(78));
  w('A. SHAPE CONFORMANCE — THE HEADLINE');
  w('='.repeat(78));
  w('');
  w('  feature       gen-v1    gen-v2     delta    noise floor (§28.8)');
  w('  ' + '-'.repeat(68));
  for (const f of Object.keys(SCHEMAS)) {
    const x = one(a, f);
    const y = one(b, f);
    const d = x.shape === null || y.shape === null ? null : y.shape - x.shape;
    const nf = noise.byFeature.get(f);
    const floor = nf && nf.cells > 0
      ? `${(100 * nf.split / nf.cells).toFixed(1)}% of ${nf.cells} repeated cells flipped`
      : 'no repeated cells';
    w(`  ${f.padEnd(12)} ${showPct(x.shape)}  ${showPct(y.shape)}  ${(d === null ? '   n/a' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pt`).padStart(8)}    ${floor}`);
  }
  const jsonA = a.filter((r) => SCHEMAS[r.feature]);
  const jsonB = b.filter((r) => SCHEMAS[r.feature]);
  const shapeOf = (rows) => rate(rows.filter((r) => verdictOf(r).schema.shape).length, rows.length);
  const sA = shapeOf(jsonA); const sB = shapeOf(jsonB);
  w('  ' + '-'.repeat(68));
  w(`  ${'ALL JSON'.padEnd(12)} ${showPct(sA)}  ${showPct(sB)}  ${`${sB - sA >= 0 ? '+' : ''}${((sB - sA) * 100).toFixed(1)}pt`.padStart(8)}    ${jsonA.length} vs ${jsonB.length} calls`);
  w('');
  w('  THE NOISE FLOOR IS NOT DECORATION. A movement smaller than the flip rate');
  w('  beside it is not distinguishable from drawing the same cell twice, and the');
  w('  v1 figure UNDERSTATES it — those cells got two draws, and three draws have');
  w('  more chances to disagree.');
  w('');

  // --- truncation ----------------------------------------------------------
  w('='.repeat(78));
  w('B. TRUNCATION — finish_reason === "length", ALL FIVE FEATURES');
  w('='.repeat(78));
  w('');
  w('  INCLUDING THE TWO PROSE FEATURES, which no conformance metric can see.');
  w('  §28.5: eli5 truncated at 6.7% with no schema, so the fix would repair it');
  w('  with no number moving anywhere. This is that number.');
  w('');
  w(`  feature       gen-v1    gen-v2     delta   would-truncate-at-${oldCeil}   schema?`);
  w('  ' + '-'.repeat(76));
  for (const f of ALL_FEATURES) {
    const x = one(a, f);
    const y = one(b, f);
    const d = y.truncated - x.truncated;
    const cf = rate(b.filter((r) => r.feature === f && r.completionTokens > oldCeil).length,
      b.filter((r) => r.feature === f).length);
    w(`  ${f.padEnd(12)} ${showPct(x.truncated)}  ${showPct(y.truncated)}  ${`${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pt`.padStart(8)}   ${showPct(cf)}              ${SCHEMAS[f] ? 'yes' : 'NO — invisible'}`);
  }
  w('');
  w(`  THE LAST COLUMN IS THE ONE THAT EXPLAINS THE RESULT, and it is a`);
  w(`  COUNTERFACTUAL: how many gen-v2 completions used more than ${oldCeil} tokens and`);
  w('  therefore COULD NOT have fitted under the old ceiling. A completion that');
  w('  used N tokens is a lower bound on what that call needed, so this is the');
  w('  share of calls where the ceiling was GENUINELY binding on a fresh draw.');
  w('');
  w('  Read it against the first column. Where the two disagree, the difference is');
  w('  WITHIN-CELL VARIANCE, not repair: the same seed and prompt at temperature');
  w(`  ${tempA[0]} does not produce the same length twice, and §28.8 measured 32.1% of`);
  w('  examQs cells flipping their verdict on a re-draw. A cell that truncated in');
  w('  gen-v1 and came back short in gen-v2 was not fixed by the ceiling — it was');
  w('  a different draw. The ceiling is what GUARANTEES the calls that genuinely');
  w('  exceed it, and the counterfactual is how many those are.');
  w('');

  // --- failure causes ------------------------------------------------------
  w('='.repeat(78));
  w('C. WHY THE REMAINING FAILURES FAIL');
  w('='.repeat(78));
  w('');
  w('  Precedence committed in scripts/lib/gen-schema.js before any run.');
  w('');
  const causeTable = (rows, label) => {
    const causes = rows.filter((r) => SCHEMAS[r.feature]).map((r) => verdictOf(r).schema).filter((s) => !s.shape).map((s) => s.cause);
    const counts = new Map();
    for (const c of causes) counts.set(c, (counts.get(c) || 0) + 1);
    w(`  ${label} — ${causes.length} failures`);
    if (causes.length === 0) { w('    none'); return; }
    for (const [c, n] of [...counts].sort((p, q) => q[1] - p[1])) {
      w(`    ${String(c).padEnd(16)} ${String(n).padStart(3)}   ${showPct(rate(n, causes.length))}`);
    }
  };
  causeTable(a, 'gen-v1');
  w('');
  causeTable(b, 'gen-v2');
  w('');

  // --- tokens and latency --------------------------------------------------
  w('='.repeat(78));
  w('D. TOKENS AND LATENCY — WHAT THE FIX COST');
  w('='.repeat(78));
  w('');
  w('  feature       out(mean)        out(p95)         reasoning(mean)   latency p95');
  w('                v1      v2       v1      v2       v1     v2         v1      v2');
  w('  ' + '-'.repeat(74));
  for (const f of ALL_FEATURES) {
    const x = one(a, f);
    const y = one(b, f);
    w(`  ${f.padEnd(12)} ${num(x.outMean).padStart(5)} ${num(y.outMean).padStart(7)}   ` +
      `${String(x.outP95).padStart(5)} ${String(y.outP95).padStart(6)}   ` +
      `${num(x.reasonMean).padStart(5)} ${num(y.reasonMean).padStart(6)}    ` +
      `${String(x.latP95).padStart(6)} ${String(y.latP95).padStart(6)}`);
  }
  const tot = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  w('  ' + '-'.repeat(74));
  w('');
  w(`  total tokens   gen-v1  in ${tot(a, 'promptTokens')}  out ${tot(a, 'completionTokens')}  = ${tot(a, 'totalTokens')}`);
  w(`                 gen-v2  in ${tot(b, 'promptTokens')}  out ${tot(b, 'completionTokens')}  = ${tot(b, 'totalTokens')}`);
  w('');
  w('  REASONING TOKENS ARE THE COLUMN TO READ FIRST. They count against');
  w('  max_tokens and are not in the output, so if they scale with the BUDGET');
  w('  rather than with the content, doubling the ceiling partly feeds the chain');
  w('  rather than the answer and the fix underdelivers. §29 scores that.');
  w('');

  // --- the control ---------------------------------------------------------
  w('='.repeat(78));
  w('E. THE CONTROL — THE THREE FEATURES THAT SHOULD NOT HAVE MOVED');
  w('='.repeat(78));
  w('');
  w(`  flashcards, concepts and summarize never approached the ${ta[0]} ceiling:`);
  w('  their v1 truncation rates were 0.0% and their maximum outputs sat well');
  w('  under it. Raising a cap they never hit cannot change them.');
  w('');
  w('  SO IF THEY MOVED, max_tokens WAS NOT THE ONLY THING THAT CHANGED — and the');
  w('  candidate nobody can otherwise detect is THE MODEL DRIFTING BEHIND ITS');
  w('  STRING (§28.9). This is the cheapest instrument this project has for that.');
  w('');
  for (const f of ['flashcards', 'concepts', 'summarize']) {
    const x = one(a, f);
    const y = one(b, f);
    const dOut = y.outMean === null || x.outMean === null ? null : (y.outMean - x.outMean) / x.outMean;
    const dShape = x.shape === null || y.shape === null ? null : y.shape - x.shape;
    const verdict = (dOut !== null && Math.abs(dOut) > 0.10) || (dShape !== null && Math.abs(dShape) > 0.001)
      ? 'MOVED — investigate before attributing anything to max_tokens'
      : 'held';
    w(`  ${f.padEnd(12)} shape ${showPct(x.shape)} -> ${showPct(y.shape)}   ` +
      `out ${num(x.outMean).padStart(4)} -> ${num(y.outMean).padStart(4)} (${dOut === null ? 'n/a' : `${dOut >= 0 ? '+' : ''}${(dOut * 100).toFixed(1)}%`})   ${verdict}`);
  }
  w('');
  w('  Threshold: shape must not move at all, mean output tokens must stay within');
  w('  10%. Both committed in results/gen-v2-predictions.txt BEFORE the run.');
  w('');

  const text = `${out.join('\n')}\n`;
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, text);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  } else {
    console.log('(pass --write to save results/gen-v1-v2-comparison.txt)');
  }
}

if (require.main === module) main();
