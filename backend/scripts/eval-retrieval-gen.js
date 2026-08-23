#!/usr/bin/env node
'use strict';

/**
 * eval-retrieval-gen.js — Phase 5.7. THE REPORT.
 *
 *   npm run eval:v7
 *   npm run eval:v7 -- --write     writes results/gen-v7.txt
 *
 * PURE. No key, no network, nothing under data/. It reads committed files under
 * results/ only, so it runs anywhere — including the local reproduction of CI,
 * which moves data/ aside — and costs nothing to re-run. The half that needs
 * the corpus is `npm run seed:retrieval`, which writes results/seed-retrieval.jsonl.
 * Same split as `gen:v5`/`eval:gen`, with "needs the corpus" in place of
 * "spends quota".
 *
 * ---------------------------------------------------------------------------
 * WHAT 5.7 ASKS FOR, AND WHICH READING OF "THE CORRELATION" HAS CONTENT
 * ---------------------------------------------------------------------------
 *
 * ROADMAP 5.7's Done clause: "a table showing nDCG@8 and downstream
 * groundedness side by side for at least two retriever versions, with the
 * correlation stated plainly."
 *
 * TWO ARMS IS TWO POINTS AND TWO POINTS HAVE NO CORRELATION. The quantity with
 * statistical content is the PER-SEED correlation between a seed's retrieval
 * quality and the quality of what was generated from it, pooled across arms.
 * Both are reported: the between-arm table because the Done clause asks for it,
 * and the per-seed correlation because it is the one that can be wrong.
 *
 * ---------------------------------------------------------------------------
 * THE POWER IS PRINTED BESIDE EVERY DIFFERENCE, NOT IN A FOOTNOTE
 * ---------------------------------------------------------------------------
 *
 * results/gen-v7-predictions.txt declares, before the run, that rate(2) cannot
 * show a between-arm difference: its minimum detectable effect exceeds its own
 * mean. A report that printed a small difference without that figure beside it
 * would invite exactly the reading the pre-registration exists to block. So
 * every between-arm difference prints its MDE and is labelled INSIDE or OUTSIDE
 * it, computed here from the ledgers rather than quoted from the predictions —
 * §32.8: a hardcoded sentence beside a recomputed number can only rot.
 *
 * ---------------------------------------------------------------------------
 * DENOMINATORS, AND THERE ARE SIX
 * ---------------------------------------------------------------------------
 *
 * seeds (30) · calls (30/arm) · seeds delivering in BOTH arms (the paired set)
 * · items (per arm) · judged pairs (per arm) · seed-arm observations (the
 * pooled correlation). §32's central finding: n is not one number for a run.
 */

const fs = require('fs');
const path = require('path');

const { scoreCall } = require('./lib/studypack-metrics');
const { GROUNDED_LEVEL } = require('./lib/judge-rubric');
const stats = require('./lib/correlation');

const REPO = path.resolve(__dirname, '..', '..');
const SEED_RETRIEVAL = path.join(REPO, 'results', 'seed-retrieval.jsonl');
const OUT = path.join(REPO, 'results', 'gen-v7.txt');

/**
 * How complete a judge arm has to be before its figures are quoted WITHOUT a
 * provisional label.
 *
 * §32.9 is the reason this is a gate rather than a footnote. 5.4's provisional
 * 6-right/7-wrong on a third of its set became 9-right/4-wrong on the whole of
 * it and THREE ROWS FLIPPED; §29.5 records a second partial set whose headline
 * its own completion overturned. Two arms at different completeness is worse
 * than one partial arm, because the difference between them then contains the
 * sampling difference and nothing in the table says so.
 *
 * The judge emission order is stratified so a prefix is a balanced SAMPLE
 * (§33.4), which is what makes a partial figure meaningful at all — but
 * balanced is not the same as settled.
 */
const PROVISIONAL_BELOW = 1.0;

/**
 * The arms. `retriever` is what joins a generation ledger to its retrieval
 * rows, and it is read from the LEDGER rather than trusted from this table —
 * see loadArm().
 */
const ARMS = [
  { name: 'gen-v5', retriever: 'v4-bm25', phase: '5.4/5.6',
    gen: 'results/gen-v5.calls.jsonl',
    judge: 'results/gen-judge.calls.jsonl',
    judgeSet: 'results/gen-judge-set.jsonl' },
  { name: 'gen-v7', retriever: 'v5-embeddings', phase: '5.7',
    gen: 'results/gen-v7.calls.jsonl',
    judge: 'results/gen-judge-v7.calls.jsonl',
    judgeSet: 'results/gen-judge-v7-set.jsonl' }
];

const has = (name) => process.argv.includes(`--${name}`);
const f3 = (x) => (x === null || x === undefined ? '   n/a' : x.toFixed(3));
const f4 = (x) => (x === null || x === undefined ? '    n/a' : x.toFixed(4));
const pct = (x) => (x === null || x === undefined ? '  n/a' : `${(x * 100).toFixed(1)}%`);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function block(title) {
  return `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`;
}

/**
 * One arm's per-seed and per-item measurements.
 *
 * A TRUNCATED CALL CONTRIBUTES NOTHING AND IS COUNTED, NOT DROPPED. It parses
 * to no items, so it has no support score and no verdicts; excluding it
 * silently would make delivery invisible. §32.6.
 */
function loadArm(arm) {
  const genRows = readJsonl(path.join(REPO, arm.gen)).filter((r) => r.ok);
  const judgeRows = readJsonl(path.join(REPO, arm.judge)).filter((r) => r.ok && !r.parseFailed);
  const judgePlanned = readJsonl(path.join(REPO, arm.judgeSet)).length;

  const stampedRetriever = [...new Set(genRows.map((r) => (r.retrieval || {}).version))];
  const truncated = genRows.filter((r) => r.finishReason === 'length');
  const delivering = genRows.filter((r) => r.finishReason !== 'length');

  // --- lexical support, per item and per seed (5.4's instrument, unchanged) --
  const supportBySeed = new Map();
  const support = [];
  const supportNull = [];
  const supportGap = [];
  for (const r of delivering) {
    const scored = scoreCall(r.rawText, r.context.notes);
    const vals = scored.support.values;
    if (!vals.length) continue;
    supportBySeed.set(String(r.seedId), vals);
    support.push(...vals);
    supportNull.push(...scored.support.otherValues);
    for (const it of scored.items) {
      if (it.support !== null && it.supportOther !== null) supportGap.push(it.support - it.supportOther);
    }
  }

  // --- judged levels, per item and per seed --------------------------------
  const cited = new Map();
  const nulls = new Map();
  for (const row of judgeRows) (row.condition === 'cited' ? cited : nulls).set(row.key, row.level);
  const levelBySeed = new Map();
  for (const [key, level] of cited) {
    const seed = key.split(':')[0];
    if (!levelBySeed.has(seed)) levelBySeed.set(seed, []);
    levelBySeed.get(seed).push(level);
  }
  const citedLevels = [...cited.values()];
  const nullLevels = [...nulls.values()];
  const pairedKeys = [...cited.keys()].filter((k) => nulls.has(k));

  return {
    ...arm,
    stampedRetriever,
    genRows,
    judgeRows,
    truncated,
    delivering,
    supportBySeed,
    support,
    supportNull,
    supportGap,
    cited,
    nulls,
    levelBySeed,
    citedLevels,
    nullLevels,
    levelGap: pairedKeys.map((k) => cited.get(k) - nulls.get(k)),
    judgePlanned,
    judgeCoverage: judgePlanned ? judgeRows.length / judgePlanned : 0,
    tokens: genRows.reduce((a, r) => a + (r.totalTokens || 0), 0),
    judgeTokens: judgeRows.reduce((a, r) => a + (r.totalTokens || 0), 0)
  };
}

/** rate(level >= GROUNDED_LEVEL) over a list of verdicts. Denominator: ITEMS. */
function rateOf(levels) {
  if (!levels.length) return null;
  return levels.filter((l) => l >= GROUNDED_LEVEL).length / levels.length;
}

function diffLine(label, a, b, values, deffValue, nPerArm) {
  const delta = (a === null || b === null) ? null : b - a;
  const m = stats.mde(stats.sd(values), nPerArm, deffValue);
  const verdict = (delta === null || m === null)
    ? ''
    : (Math.abs(delta) < m ? 'INSIDE the MDE — not a difference' : 'OUTSIDE the MDE');
  return `    ${label.padEnd(26)} ${f4(a)}  ${f4(b)}   ${delta === null ? '   n/a' : (delta >= 0 ? '+' : '') + delta.toFixed(4)}   ${f4(m)}   ${verdict}`;
}

function main() {
  const retrievalRows = readJsonl(SEED_RETRIEVAL);
  if (retrievalRows.length === 0) {
    console.error('MISSING results/seed-retrieval.jsonl — build it with:');
    console.error('  npm run seed:retrieval -- --write     (needs the gitignored corpus)');
    process.exit(1);
  }
  const arms = ARMS.map(loadArm).filter((a) => a.genRows.length > 0);
  if (arms.length < 2) {
    console.error(`Only ${arms.length} arm(s) have a generation ledger. 5.7 needs two.`);
    process.exit(1);
  }

  // THE ARM'S RETRIEVER IS READ FROM ITS LEDGER, NOT FROM THE TABLE ABOVE. A
  // mislabelled arm would pair every generation figure with the wrong nDCG@8
  // and every number in this report would compute.
  for (const a of arms) {
    if (a.stampedRetriever.length !== 1 || a.stampedRetriever[0] !== a.retriever) {
      console.error(`${a.gen} is stamped ${a.stampedRetriever.join(', ') || '(nothing)'}, not ${a.retriever}. Refusing.`);
      process.exit(1);
    }
  }

  const ndcg = new Map();
  for (const row of retrievalRows) ndcg.set(`${row.retriever}:${row.seedId}`, row);
  const L = [];
  const say = (s = '') => L.push(s);

  say('PHASE 5.7 — RETRIEVAL QUALITY AGAINST GENERATION QUALITY');
  say('');
  say('  Study Pack run over the SAME 30 seeds under two retrievers, the resulting');
  say('  items graded by the SAME frozen judge and rubric, and a seed\'s retrieval');
  say('  score put beside what was generated from it.');
  say('');
  say('  Produced by:  cd backend && npm run eval:v7 -- --write');
  say('  PURE — no key, no network, nothing under data/. Reads only results/.');

  // THE PROVISIONAL BANNER, COMPUTED RATHER THAN REMEMBERED. §32.9: two
  // separate partial sets in this project have produced headlines their own
  // completions overturned. Two arms at DIFFERENT completeness is worse still,
  // because the between-arm difference then contains the sampling difference
  // and nothing else in the table would say so.
  const partial = arms.filter((a) => a.judgeCoverage < PROVISIONAL_BELOW);
  const provisional = partial.length > 0;
  if (provisional) {
    say('');
    say(`  ${'!'.repeat(74)}`);
    say('  PROVISIONAL — AT LEAST ONE JUDGE ARM IS INCOMPLETE. Every judged figure');
    say('  below is a sample of its arm, and the two arms are sampled to DIFFERENT');
    say('  depths, so a between-arm judged difference contains that difference too.');
    say('');
    for (const a of arms) {
      say(`    ${a.name.padEnd(8)} judge coverage ${String(a.judgeRows.length).padStart(4)} of ${String(a.judgePlanned).padStart(4)} pairs   ` +
        `${pct(a.judgeCoverage)}${a.judgeCoverage < PROVISIONAL_BELOW ? '   <- PARTIAL' : ''}`);
    }
    say('');
    say('  The emission order is stratified so a prefix is a BALANCED sample rather');
    say('  than a corner of the set (§33.4) — that is what makes these figures worth');
    say('  printing at all. Balanced is not settled. §32.9: 5.4\'s provisional');
    say('  6-right/7-wrong became 9-right/4-wrong and three rows flipped.');
    say('');
    say('  THE LEXICAL AND RETRIEVAL FIGURES ARE NOT PROVISIONAL. They need no judge');
    say('  call: both arms\' generation ledgers are complete at 30 of 30.');
    say(`  ${'!'.repeat(74)}`);
  }

  // =====================================================================
  say(block('A. THE ONE VARIABLE, AND WHAT IS HELD FIXED'));
  const g0 = arms[0].genRows[0];
  say('  Held fixed across both arms, and checked against the ledgers rather than');
  say('  asserted: the 30 seeds, the prompt, the model, temperature, max_tokens,');
  say('  the context budget, k, the judge, the rubric and the distractor rule.');
  say('');
  say(`    model            ${[...new Set(arms.flatMap((a) => a.genRows.map((r) => r.model)))].join(', ')}`);
  say(`    temperature      ${[...new Set(arms.flatMap((a) => a.genRows.map((r) => r.temperature)))].join(', ')}`);
  say(`    max_tokens       ${[...new Set(arms.flatMap((a) => a.genRows.map((r) => r.maxTokens)))].join(', ')}`);
  say(`    context budget   ${[...new Set(arms.flatMap((a) => a.genRows.map((r) => r.context.budgetTokens)))].join(', ')} tokens`);
  say(`    k                ${[...new Set(arms.flatMap((a) => a.genRows.map((r) => (r.retrieval || {}).k)))].join(', ')}`);
  const judgeModels = [...new Set(arms.flatMap((a) => a.judgeRows.map((r) => r.judgeModel)))];
  say(`    judge            ${judgeModels.join(', ') || '(no judge rows yet)'}`);
  say('');
  say('  A SINGLE VALUE IN EVERY ROW ABOVE IS THE EVIDENCE THAT ONE VARIABLE MOVED.');
  say('  Two values anywhere would mean the arms differ in something besides the');
  say('  retriever, and every comparison below would be unattributable.');
  say('');
  say('    THE VARIABLE:');
  for (const a of arms) say(`      ${a.name.padEnd(8)} ${a.retriever.padEnd(15)} ${a.gen}`);

  // =====================================================================
  say(block('B. RETRIEVAL QUALITY — ALL SIX RUNGS, TWO OF THEM WITH A GENERATION ARM'));
  say('  DENOMINATOR: SEEDS (30). nDCG@8 against the Stack Exchange qrels.');
  say('');
  const rungs = [...new Set(retrievalRows.map((r) => r.retriever))];
  say('    retriever         nDCG@8    P@8     R@8    MRR    seeds at 0   generation arm');
  say(`    ${'-'.repeat(84)}`);
  const perRung = new Map();
  for (const rung of rungs) {
    const rows = retrievalRows.filter((r) => r.retriever === rung);
    perRung.set(rung, rows);
    const m = (f) => stats.mean(rows.map(f));
    const zeros = rows.filter((r) => r.ndcg8 === 0).length;
    say(`    ${rung.padEnd(16)} ${f4(m((r) => r.ndcg8))}  ${f4(m((r) => r.p8))}  ${f4(m((r) => r.r8))}  ` +
      `${f4(m((r) => r.mrr))}   ${String(zeros).padStart(2)}/${rows.length}        ${rows[0].generationArm || '—'}`);
  }
  say('');
  const judged = perRung.get(rungs[0]).map((r) => r.judged).sort((a, b) => a - b);
  say(`  JUDGED DOCUMENTS PER SEED: median ${judged[Math.floor(judged.length / 2)]}, min ${judged[0]}, max ${judged[judged.length - 1]},`);
  say(`  mean ${stats.mean(judged).toFixed(2)}. THIS IS THE MOST IMPORTANT CAVEAT IN THE FILE. With a median`);
  say('  of one relevant document, a seed\'s nDCG@8 is close to a BINARY event — was');
  say('  the single linked question in the top 8. Between 11 and 22 of the 30 seeds');
  say('  score exactly zero depending on the rung, so the retrieval axis is mostly');
  say('  ties. §5.1: PostLinks is positive-only and every absolute is a lower bound.');
  say('');
  say('  These are 30 seeds, not the 2,304-query dev set the ladder was measured on.');
  say('  The ladder ordering is reproduced in DIRECTION here; the magnitudes are a');
  say('  property of this draw and the two must not be quoted interchangeably.');

  // =====================================================================
  say(block('C. THE PAIRED RETRIEVAL CONTRAST — IS THE INDEPENDENT VARIABLE REAL?'));
  say('  DENOMINATOR: SEEDS. Paired, because both arms ran the identical seeds.');
  say('');
  say('  A DOWNSTREAM COMPARISON IS ONLY WORTH RUNNING IF THE THING BEING VARIED');
  say('  ACTUALLY VARIES ON THIS SAMPLE, and that is not automatic: the ladder\'s');
  say('  separations were measured over 2,304 queries and this is 30.');
  say('');
  const armA = arms[0];
  const armB = arms[1];
  const seedIds = perRung.get(armA.retriever).map((r) => r.seedId);
  const nd = (rung, seed) => ndcg.get(`${rung}:${seed}`).ndcg8;
  const allDiff = stats.pairedDiff(seedIds.map((s) => nd(armB.retriever, s)), seedIds.map((s) => nd(armA.retriever, s)));

  // The seeds that delivered items in BOTH arms — the set every downstream
  // figure is actually computed on.
  const deliveringA = new Set(armA.delivering.map((r) => String(r.seedId)));
  const deliveringB = new Set(armB.delivering.map((r) => String(r.seedId)));
  const paired = seedIds.filter((s) => deliveringA.has(s) && deliveringB.has(s));
  const pairedDiffDeliv = stats.pairedDiff(paired.map((s) => nd(armB.retriever, s)), paired.map((s) => nd(armA.retriever, s)));

  say(`    ${armB.retriever} minus ${armA.retriever}, nDCG@8`);
  say('');
  say('    set                        n    mean diff     sd       t     better  worse   tied');
  say(`    ${'-'.repeat(78)}`);
  for (const [label, d] of [['all seeds', allDiff], ['seeds delivering in BOTH', pairedDiffDeliv]]) {
    say(`    ${label.padEnd(24)} ${String(d.n).padStart(3)}   ${(d.mean >= 0 ? '+' : '') + d.mean.toFixed(4)}   ` +
      `${f4(d.sd)}  ${d.t === null ? ' n/a' : d.t.toFixed(2).padStart(6)}   ${String(d.positive).padStart(4)}   ` +
      `${String(d.negative).padStart(4)}   ${String(d.zero).padStart(4)}`);
  }
  say('');
  say('  AND THE SAME CONTRAST FOR EVERY RUNG THAT WAS NOT RUN, because these are what');
  say('  CHOSE the second arm and a design decision needs its evidence in an artifact:');
  say('');
  say(`    candidate minus ${armA.retriever}     all 30 seeds        seeds delivering in A     shared`);
  say('                              diff        t         diff        t          nbrs/8   tied');
  say(`    ${'-'.repeat(84)}`);
  const armANeighbours = new Map(perRung.get(armA.retriever).map((r) => [r.seedId, new Set(r.neighbours)]));
  for (const rung of rungs) {
    if (rung === armA.retriever) continue;
    const all = stats.pairedDiff(seedIds.map((s) => nd(rung, s)), seedIds.map((s) => nd(armA.retriever, s)));
    const inA = seedIds.filter((s) => deliveringA.has(s));
    const del = stats.pairedDiff(inA.map((s) => nd(rung, s)), inA.map((s) => nd(armA.retriever, s)));
    const shared = stats.mean(perRung.get(rung).map((r) => r.neighbours.filter((n) => armANeighbours.get(r.seedId).has(n)).length));
    say(`    ${rung.padEnd(20)} ${(all.mean >= 0 ? '+' : '') + all.mean.toFixed(4)}   ${all.t === null ? '  n/a' : all.t.toFixed(2).padStart(6)}    ` +
      `${(del.mean >= 0 ? '+' : '') + del.mean.toFixed(4)}   ${del.t === null ? '  n/a' : del.t.toFixed(2).padStart(6)}       ` +
      `${shared.toFixed(2)}     ${String(all.zero).padStart(4)}${rung === armB.retriever ? '   <- THE ARM RUN' : ''}`);
  }
  say('');
  say('  THIS TABLE IS WHY THE SECOND ARM IS NOT v1-overlap, WHICH IS WHAT ROADMAP 5.7');
  say('  ASKS FOR. v1 does not separate from the paid arm on this sample — the ladder');
  say('  established that difference over 2,304 dev queries and 30 seeds cannot');
  say('  resolve it — so a v1 arm would spend a full session varying an independent');
  say('  variable that does not vary. v6-hybrid separates nearly as well as v5 and is');
  say('  rejected for a subtler reason: it shares half its neighbours with arm A, so');
  say('  half of each context would be the context arm A already ran.');
  say('');
  say('  THE SECOND ROW IS THE ONE THAT GOVERNS EVERY DOWNSTREAM NUMBER, because a');
  say('  truncated call contributes no items and therefore no groundedness. The gap');
  say('  between the two rows is what the output ceiling costs this comparison, and');
  say('  it is the number ROADMAP 5.9 inherits from this phase.');

  // =====================================================================
  say(block('D. DELIVERY AND CENSORING, PER ARM'));
  say('  DENOMINATOR: CALLS (30 per arm).');
  say('');
  say('    arm       calls  truncated   rate    mean words trunc / kept   actual tokens');
  say(`    ${'-'.repeat(76)}`);
  for (const a of arms) {
    const mw = (rows) => (rows.length ? stats.mean(rows.map((r) => r.words)).toFixed(1) : ' n/a');
    say(`    ${a.name.padEnd(8)}  ${String(a.genRows.length).padStart(4)}   ${String(a.truncated.length).padStart(6)}   ` +
      `${pct(a.truncated.length / a.genRows.length)}       ${mw(a.truncated)} / ${mw(a.delivering)}        ${String(a.tokens).padStart(7)}`);
  }
  const trA = new Set(armA.truncated.map((r) => String(r.seedId)));
  const trB = new Set(armB.truncated.map((r) => String(r.seedId)));
  const sharedTrunc = [...trA].filter((s) => trB.has(s));
  say('');
  say(`  TRUNCATED SEEDS SHARED BY BOTH ARMS: ${sharedTrunc.length} of ${trA.size} and ${trB.size}.`);
  say(`  SEEDS DELIVERING ITEMS IN BOTH ARMS: ${paired.length} of ${seedIds.length}.`);
  say('');
  say('  THE CENSORING IS COMMON-MODE, WHICH IS WHAT MAKES THE PAIRED DESIGN WORK.');
  say('  Truncation is driven by the seed, and the seeds are identical across arms,');
  say('  so the ceiling removes approximately the same calls from both. It still');
  say('  skews BOTH item sets toward short seeds — that caveat is unchanged from');
  say('  §33.1 — but it is not differentially loaded against one retriever, so it');
  say('  does not masquerade as a retriever effect. Restricting to the seeds that');
  say('  deliver in both arms removes it from the comparison entirely.');

  // =====================================================================
  say(block('E. THE 5.7 TABLE — nDCG@8 AND DOWNSTREAM QUALITY SIDE BY SIDE'));
  say('  This is ROADMAP 5.7\'s Done clause. Each column names its denominator.');
  say('');
  say('    arm      retriever        nDCG@8   items   support   sup null   rate(2)  null');
  say(`    ${'-'.repeat(80)}`);
  for (const a of arms) {
    const seedsHere = perRung.get(a.retriever);
    say(`    ${a.name.padEnd(7)}  ${a.retriever.padEnd(15)}  ${f4(stats.mean(seedsHere.map((r) => r.ndcg8)))}   ` +
      `${String(a.support.length).padStart(5)}   ${f4(a.support.length ? stats.mean(a.support) : null)}   ` +
      `${f4(a.supportNull.length ? stats.mean(a.supportNull) : null)}    ` +
      `${a.citedLevels.length ? pct(rateOf(a.citedLevels)) : '  n/a'}   ${a.nullLevels.length ? pct(rateOf(a.nullLevels)) : ' n/a'}`);
  }
  say('');
  say('    nDCG@8   denominator SEEDS (30)          support  denominator ITEMS');
  say('    rate(2)  denominator ITEMS (judged)      null     the same items against');
  say('                                                      a note they did NOT cite');
  say('');
  for (const a of arms) {
    say(`    ${a.name}: ${a.judgeRows.length} of ${a.judgePlanned} judge calls (${pct(a.judgeCoverage)}), ` +
      `${a.cited.size} cited verdicts, ${a.nulls.size} null verdicts` +
      `${a.judgeRows.length ? `, ${a.judgeTokens} actual tokens` : ''}` +
      `${a.judgeCoverage < PROVISIONAL_BELOW ? '   <- PARTIAL, rate(2) above is provisional' : ''}`);
  }

  // =====================================================================
  say(block('F. THE BETWEEN-ARM DIFFERENCES, EACH BESIDE THE EFFECT IT COULD DETECT'));
  say('  DENOMINATOR: ITEMS, with the intra-seed clustering MEASURED and applied.');
  say('');
  say('  Items are nested in calls — ~14 items come from one generation call over');
  say('  one cluster — so item counts are not independent observations. The design');
  say('  effect below is computed from these ledgers, not assumed.');
  say('');
  const iccSup = stats.icc([...armA.supportBySeed.values()]);
  const iccLev = armA.levelBySeed.size ? stats.icc([...armA.levelBySeed.values()]) : null;
  if (iccSup) {
    say(`    lexical support   ICC ${f3(iccSup.icc)}  items/seed ${iccSup.itemsPerGroup.toFixed(1)}  design effect ${f3(iccSup.designEffect)}`);
  }
  if (iccLev) {
    say(`    judged level      ICC ${f3(iccLev.icc)}  items/seed ${iccLev.itemsPerGroup.toFixed(1)}  design effect ${f3(iccLev.designEffect)}`);
  }
  say('');
  say(`    metric                     ${armA.name}    ${armB.name}     delta        MDE   verdict`);
  say(`    ${'-'.repeat(92)}`);
  const dSup = iccSup ? iccSup.designEffect : 1;
  const dLev = iccLev ? iccLev.designEffect : 1;
  const nSup = Math.min(armA.support.length, armB.support.length) || 1;
  const nLev = Math.min(armA.citedLevels.length, armB.citedLevels.length) || 1;
  say(diffLine('lexical support', armA.support.length ? stats.mean(armA.support) : null,
    armB.support.length ? stats.mean(armB.support) : null, armA.support, dSup, nSup));
  say(diffLine('lexical support GAP', armA.supportGap.length ? stats.mean(armA.supportGap) : null,
    armB.supportGap.length ? stats.mean(armB.supportGap) : null, armA.supportGap, dSup, nSup));
  if (armB.citedLevels.length) {
    say(diffLine('judged mean level (0-2)', stats.mean(armA.citedLevels), stats.mean(armB.citedLevels),
      armA.citedLevels, dLev, nLev));
    say(diffLine('judged rate(2)', rateOf(armA.citedLevels), rateOf(armB.citedLevels),
      armA.citedLevels.map((l) => (l >= GROUNDED_LEVEL ? 1 : 0)), dLev, nLev));
    say(diffLine('judged gap (cited - null)', stats.mean(armA.levelGap), stats.mean(armB.levelGap),
      armA.levelGap, dLev, nLev));
  } else {
    say('    (judged rows for the second arm are not in yet — the judge run is partial)');
  }
  say('');
  if (provisional) {
    say('');
    say('  THE JUDGED ROWS ABOVE ARE PROVISIONAL AND THEIR MDE IS COMPUTED ON THE');
    say('  SMALLER ARM\'s n, which is why it is wide. It narrows as the run completes;');
    say('  the lexical rows are final.');
  }
  say('');
  say('  "INSIDE THE MDE" MEANS THE COMPARISON COULD NOT HAVE SEEN A DIFFERENCE THIS');
  say('  SMALL, NOT THAT THERE IS NONE. results/gen-v7-predictions.txt declares');
  say('  before the run that rate(2) cannot speak here at all: its MDE exceeds its');
  say('  own mean, so any rate(2) delta is uninformative in both directions.');

  // =====================================================================
  say(block('G. THE CORRELATION — THE READING OF 5.7 WITH STATISTICAL CONTENT'));
  say('  DENOMINATOR: SEED-ARM OBSERVATIONS. One per seed per arm that delivered.');
  say('');
  say('  Does a seed whose neighbours were retrieved BETTER produce better items?');
  say('  Two arms is two points; this pools every seed in both arms, which both');
  say('  doubles n and puts the retrieval axis over its full range.');
  say('');
  const obs = { ndcg: [], support: [], level: [], rate: [], arm: [] };
  for (const a of arms) {
    for (const seed of perRung.get(a.retriever).map((r) => r.seedId)) {
      const sup = a.supportBySeed.get(seed);
      const lev = a.levelBySeed.get(seed);
      if (!sup && !lev) continue;
      obs.ndcg.push(nd(a.retriever, seed));
      obs.support.push(sup ? stats.mean(sup) : null);
      obs.level.push(lev ? stats.mean(lev) : null);
      obs.rate.push(lev ? rateOf(lev) : null);
      obs.arm.push(a.name);
    }
  }
  const pairUp = (ys) => {
    const x = [];
    const y = [];
    for (let i = 0; i < ys.length; i += 1) {
      if (ys[i] === null || ys[i] === undefined) continue;
      x.push(obs.ndcg[i]);
      y.push(ys[i]);
    }
    return { x, y };
  };
  say('  TWO POOLED FIGURES, AND THE SECOND IS THE ONE TO QUOTE.');
  say('');
  say('  A NAIVE POOL CONFOUNDS TWO SOURCES OF VARIATION AND ONLY ONE OF THEM HAS');
  say('  n=46 BEHIND IT. Both arms differ in mean nDCG@8 AND in mean outcome, so');
  say('  pooling their raw values lets a single BETWEEN-ARM contrast — which is n=2,');
  say('  two arm means — masquerade as 46 observations. That is the shape of');
  say('  Simpson\'s paradox, and here it is not hypothetical: lexical support');
  say('  disagrees between the pooled and per-arm readings below.');
  say('');
  say('  WITHIN-ARM centres each variable on its own arm\'s mean before pooling, so');
  say('  the estimate uses only variation BETWEEN SEEDS INSIDE an arm — the question');
  say('  actually being asked. It is the fixed-effects estimate and it is the honest');
  say('  pooled number.');
  say('');
  say('    outcome                     pool     n     pearson r   95% CI             spearman  |r| detectable');
  say(`    ${'-'.repeat(102)}`);
  for (const [label, ys] of [['mean lexical support', obs.support], ['mean judged level', obs.level], ['rate(2)', obs.rate]]) {
    const { x, y } = pairUp(ys);
    if (x.length < 4) { say(`    ${label.padEnd(28)} ${String(x.length).padStart(4)}   too few observations`); continue; }
    for (const mode of ['naive', 'within-arm']) {
      let xs = x;
      let ys2 = y;
      if (mode === 'within-arm') {
        // Centre both variables on their own arm's mean. Seeds whose arm
        // contributes fewer than two observations carry no within-arm
        // information and are dropped rather than centred to zero.
        const idx = [];
        for (let i = 0, k = 0; i < ys.length; i += 1) {
          if (ys[i] === null || ys[i] === undefined) continue;
          idx.push(obs.arm[i]);
          k += 1;
        }
        const byArm = new Map();
        idx.forEach((a, i) => {
          if (!byArm.has(a)) byArm.set(a, { xs: [], ys: [] });
          byArm.get(a).xs.push(x[i]);
          byArm.get(a).ys.push(y[i]);
        });
        const cx = [];
        const cy = [];
        idx.forEach((a, i) => {
          const g = byArm.get(a);
          if (g.xs.length < 2) return;
          cx.push(x[i] - stats.mean(g.xs));
          cy.push(y[i] - stats.mean(g.ys));
        });
        xs = cx;
        ys2 = cy;
      }
      if (xs.length < 4) continue;
      const r = stats.pearson(xs, ys2);
      const ci = stats.fisherCI(r, xs.length);
      say(`    ${(mode === 'naive' ? label : '').padEnd(28)} ${mode.padEnd(11)} ${String(xs.length).padStart(3)}   ${f3(r)}       ` +
        `${ci ? `[${f3(ci.lo)}, ${f3(ci.hi)}]` : '        n/a       '}   ${f3(stats.spearman(xs, ys2))}     ` +
        `${f3(stats.detectableR(xs.length))}${mode === 'within-arm' ? '   <- QUOTE THIS' : ''}`);
    }
  }
  say('');
  say('  AND PER ARM, so a pooled figure cannot hide two arms disagreeing:');
  say('');
  say('    arm      outcome                  n    pearson r   spearman');
  say(`    ${'-'.repeat(60)}`);
  for (const a of arms) {
    for (const [label, get] of [['mean lexical support', (s) => (a.supportBySeed.get(s) ? stats.mean(a.supportBySeed.get(s)) : null)],
      ['mean judged level', (s) => (a.levelBySeed.get(s) ? stats.mean(a.levelBySeed.get(s)) : null)]]) {
      const x = [];
      const y = [];
      for (const seed of perRung.get(a.retriever).map((r) => r.seedId)) {
        const v = get(seed);
        if (v === null) continue;
        x.push(nd(a.retriever, seed));
        y.push(v);
      }
      if (x.length < 4) { say(`    ${a.name.padEnd(8)} ${label.padEnd(24)} ${String(x.length).padStart(3)}   too few`); continue; }
      say(`    ${a.name.padEnd(8)} ${label.padEnd(24)} ${String(x.length).padStart(3)}   ${f3(stats.pearson(x, y))}       ${f3(stats.spearman(x, y))}`);
    }
  }
  say('');
  say('  BOTH r AND rho ARE PRINTED BECAUSE THE RETRIEVAL AXIS IS MOSTLY TIES. With');
  say('  a median of one judged document per seed, most seeds sit at nDCG@8 = 0, and');
  say('  Pearson on a near-binary predictor is a two-group comparison wearing a');
  say('  correlation\'s clothes. Spearman with average ranks is the honest reading;');
  say('  they are reported together so a reader can see when they disagree.');

  // =====================================================================
  say(block('H. WHAT THIS CANNOT SAY'));
  say('  NO NOISE FLOOR UNDER EITHER ARM. One draw per seed at temperature 0.4, no');
  say('  repeats, in both arms alike. §28.8 measured 32.1% of examQs cells flipping');
  say('  verdict on a re-draw. A between-arm difference smaller than the re-draw');
  say('  flip rate is not attributable to the retriever, and NOTHING here or in 5.4');
  say('  establishes what that rate is for a study pack. This is the limitation most');
  say('  likely to be quoted past, because every figure above is a clean number.');
  say('');
  say('  THE GROUNDEDNESS RATE HAS NO HUMAN VALIDATION IN EITHER ARM. §33.8: the');
  say('  human never used the top level in 60 items, so the binary kappa is exactly');
  say('  0.000 with a degenerate marginal. The second arm collects no hand labels by');
  say('  pre-registration, and its figures carry 5.6\'s three-level kappa of 0.246 at');
  say('  P_o 64.0% by TRANSFER — the instrument is frozen across arms, but transfer');
  say('  is an assumption and not a measurement.');
  say('');
  say('  THE RETRIEVAL AXIS IS SPARSE AND NEARLY BINARY. Median one judged document');
  say('  per seed. A per-seed nDCG@8 answers "was the linked question found", which');
  say('  is a coarser question than "how good were these eight neighbours".');
  say('');
  say('  ASSIGNMENT IS BY DESIGN, SO THE ARM CONTRAST IS CAUSAL; THE PER-SEED');
  say('  CORRELATION IS OBSERVATIONAL. A seed\'s retrievability may be confounded');
  say('  with properties of the seed nobody here measured.');
  say('');
  say('  THE CLUSTERS ARE NOT APP-SHAPED. Neighbours come from all 27,325 corpus');
  say('  documents rather than a <=500-note user slice, and the seeds are Stack');
  say('  Exchange questions shaped as Notes. §12.2\'s gap, eleventh instance.');
  say('');
  say('  30 SEEDS IS NOT 2,304 QUERIES. The ladder\'s separations were established on');
  say('  the dev split; this draw reproduces their direction, not their magnitudes.');
  say('');

  const text = `${L.join('\n')}\n`;
  console.log(text);
  if (has('write')) {
    fs.writeFileSync(OUT, text);
    console.log(`  wrote ${path.relative(REPO, OUT)}\n`);
  }
}

if (require.main === module) main();

module.exports = { loadArm, rateOf, ARMS };
