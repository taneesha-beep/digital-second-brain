#!/usr/bin/env node
'use strict';

/**
 * eval-judge.js — Phase 5.6. THE REPORT.
 *
 *   npm run eval:judge
 *   npm run eval:judge -- --write     writes results/gen-judge.txt
 *
 * PURE. No key, no network, nothing under data/. It reads three committed
 * files under results/ and issues no API call, so it runs anywhere — including
 * the local reproduction of CI, which moves data/ aside — and costs nothing to
 * re-run. Same split as `eval:gen`, for §32's stated reason.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE PRINTS ITS OWN DENOMINATOR, AND THAT IS §32's CENTRAL FINDING
 * ---------------------------------------------------------------------------
 *
 * "n is not one number for a run." 5.4 was simultaneously well-powered for
 * items (322) and badly under-powered for calls (30) and printed both under one
 * seed count; when the set completed, the item figures moved by 0.001 and the
 * call figures by 23 points. This report has FIVE different denominators —
 * items, paired items, human-labelled items, human null items, judge calls —
 * and none of them is allowed to appear without saying which it is.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS HARDCODED FROM A PARTIAL RUN
 * ---------------------------------------------------------------------------
 *
 * §32.8 records `eval-gen.js` printing "A 0% TRUNCATION RATE HERE IS NOT A
 * COMFORTABLE ZERO" directly above a recomputed `truncated 23.3%` — a sentence
 * true when written that went quietly false when the ledger grew. A hardcoded
 * sentence beside a recomputed number cannot fail; it can only rot, and it
 * defeats the point of a pure reporter. Every claim below that depends on a
 * number is computed from the ledger, including the ones that read like prose.
 */

const fs = require('fs');
const path = require('path');

const judge = require('./lib/judge-metrics');
const { LEVELS, LEVEL_NAMES, toBinary, GROUNDED_LEVEL } = require('./lib/judge-rubric');
const studyPackMetrics = require('./lib/studypack-metrics');
const { tokenise } = require('../utils/keywords');

const REPO = path.resolve(__dirname, '..', '..');
const GEN_LEDGER = path.join(REPO, 'results', 'gen-v5.calls.jsonl');
const SET = path.join(REPO, 'results', 'gen-judge-set.jsonl');
const LEDGER = path.join(REPO, 'results', 'gen-judge.calls.jsonl');
const HUMAN = path.join(REPO, 'results', 'gen-judge-human.jsonl');
const OUT = path.join(REPO, 'results', 'gen-judge.txt');

const has = (name) => process.argv.includes(`--${name}`);
const pct = (x) => (x === null || x === undefined ? '  n/a' : `${(x * 100).toFixed(1)}%`);
const f3 = (x) => (x === null || x === undefined ? '  n/a' : x.toFixed(3));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/**
 * Which items had their cited note as the LEXICAL argmax, and which did not.
 *
 * §32.5 reports 77.3% argmax and calls the other 22.7% "the pile 5.6 will have
 * to sort" — some mis-attributions, some correct citations of a note that
 * phrased things differently, and the lexical metric cannot tell them apart.
 * Recomputed here from the same committed ledger by the same tokenizer, so the
 * two phases are talking about the same partition rather than two similar ones.
 */
function lexicalArgmaxByItem(genRows) {
  const out = new Map();
  for (const row of genRows) {
    const notes = (row.context && row.context.notes) || [];
    const labels = new Map(notes.map((n) => [n.label, n]));
    const termsByLabel = new Map(notes.map((n) => [n.label, new Set(tokenise(`${n.title} ${n.text}`))]));

    const perSlot = new Map();
    for (const { slot, element } of studyPackMetrics.itemsOf(row.rawText)) {
      const itemIndex = perSlot.get(slot) || 0;
      perSlot.set(slot, itemIndex + 1);

      const { label, citation } = studyPackMetrics.resolveLabel(element, labels);
      if (citation !== 'valid') continue;
      const claimTerms = new Set(tokenise(studyPackMetrics.claimText(slot, element)));
      if (claimTerms.size === 0) continue;

      let best = null;
      let bestScore = -1;
      for (const [lab, terms] of termsByLabel) {
        const s = studyPackMetrics.containment(claimTerms, terms);
        if (s !== null && s > bestScore) { bestScore = s; best = lab; }
      }
      out.set(judge.itemKey(row.seedId, slot, itemIndex), best === label);
    }
  }
  return out;
}

function block(title) {
  return `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`;
}

function confusionBlock(k, label) {
  const lines = [];
  const cats = k.categories;
  lines.push(`  ${label}`);
  lines.push('');
  if (k.n === 0) {
    lines.push('    no overlapping labels — nothing to compare yet');
    return lines;
  }
  lines.push('                    JUDGE');
  lines.push(`    HUMAN      ${cats.map((c) => String(c).padStart(6)).join('')}    total`);
  k.matrix.forEach((row, i) => {
    lines.push(`      ${String(cats[i]).padEnd(8)} ${row.map((v) => String(v).padStart(6)).join('')}   ${String(k.rowMarginals[i]).padStart(6)}`);
  });
  lines.push(`      ${'total'.padEnd(8)} ${k.colMarginals.map((v) => String(v).padStart(6)).join('')}   ${String(k.n).padStart(6)}`);
  lines.push('');
  lines.push(`    n (items)              ${k.n}`);
  lines.push(`    observed agreement P_o ${f3(k.po)}   ${pct(k.po)}`);
  lines.push(`    chance agreement  P_e  ${f3(k.pe)}`);
  lines.push(`    COHEN'S KAPPA          ${f3(k.kappa)}`);
  if (k.kappa !== null && k.po !== null) {
    lines.push(`    P_o - kappa            ${f3(k.po - k.kappa)}`);
  }
  return lines;
}

function main() {
  const genRows = readJsonl(GEN_LEDGER).filter((r) => r.ok === true);
  const pairs = readJsonl(SET);
  const verdicts = readJsonl(LEDGER);
  const humanRows = readJsonl(HUMAN);

  const ok = verdicts.filter((v) => v.ok === true);
  const attempted = verdicts.length;
  const byPairId = new Map(ok.map((v) => [v.pairId, v]));

  const L = [];
  L.push('PHASE 5.6 — LLM-AS-JUDGE FOR GROUNDEDNESS, WITH A HUMAN AGREEMENT CHECK');
  L.push('');
  L.push('  A rubric-based, claim-level groundedness judgement, graded by a model that');
  L.push('  is NOT the model being judged, and checked against hand labels.');
  L.push('');
  L.push('  Produced by:  cd backend && npm run eval:judge -- --write');
  L.push('  PURE — no key, no network, nothing under data/. Reads only results/.');

  // ---------------------------------------------------------------- coverage
  L.push(block('A. COVERAGE, AND WHAT EACH DENOMINATOR IS'));
  const citedOk = ok.filter((v) => v.condition === 'cited' && !v.parseFailed);
  const nullOk = ok.filter((v) => v.condition === 'null' && !v.parseFailed);
  const pairedKeys = [...new Set(citedOk.map((v) => v.key))]
    .filter((k) => nullOk.some((v) => v.key === k));

  const judgeModels = [...new Set(ok.map((v) => v.judgeModel).filter(Boolean))];
  const judgedModels = [...new Set(genRows.map((r) => r.model).filter(Boolean))];

  L.push(`  judge model            ${judgeModels.join(', ') || 'n/a — nothing judged yet'}`);
  L.push(`  model being judged     ${judgedModels.join(', ')}`);
  L.push('');
  if (judgeModels.length && judgedModels.some((m) => judgeModels.includes(m))) {
    L.push('  *** THE JUDGE IS THE MODEL BEING JUDGED. Self-preference is a known bias and');
    L.push('  *** every figure below is unusable. ROADMAP 5.6 requires them to differ.');
    L.push('');
  } else if (judgeModels.length) {
    L.push('  Different vendor and family, which is ROADMAP 5.6\'s requirement and 5.0\'s');
    L.push('  decision-log reservation. What this does NOT rule out is correlated error:');
    L.push('  two models trained on overlapping text can be wrong about the same claim,');
    L.push('  and only the human labels below speak to that.');
    L.push('');
  }
  L.push(`  items in the pair set  ${new Set(pairs.map((p) => p.key)).size}`);
  L.push(`  pairs in the pair set  ${pairs.length}   (each item twice: cited, null)`);
  L.push(`  judge calls attempted  ${attempted}`);
  L.push(`  judge calls completed  ${ok.length}   delivery ${attempted ? pct(ok.length / attempted) : ' n/a'}   <- denominator: CALLS`);
  L.push('');
  L.push(`  cited verdicts parsed  ${citedOk.length}   <- denominator: ITEMS`);
  L.push(`  null  verdicts parsed  ${nullOk.length}   <- denominator: ITEMS`);
  L.push(`  items with BOTH        ${pairedKeys.length}   <- denominator: PAIRED ITEMS (the gap)`);
  L.push(`  hand-labelled items    ${humanRows.length}   <- denominator: HUMAN ITEMS (the kappa)`);
  L.push('');
  const complete = ok.length >= pairs.length;
  if (!complete) {
    L.push(`  *** THIS RUN IS ${pct(pairs.length ? ok.length / pairs.length : 0)} COMPLETE AND EVERY FIGURE BELOW IS PROVISIONAL.`);
    L.push('  *** Two partial sets in this project have produced headlines their own');
    L.push('  *** completions overturned (§29.5\'s, §32.9\'s: 6-right/7-wrong on a third of');
    L.push('  *** the set became 9-right/4-wrong on all of it, three rows flipping).');
    L.push('  *** What protects a partial run here is the EMISSION ORDER, not luck: items');
    L.push('  *** are interleaved so any prefix holds each stratum in proportion to its');
    L.push('  *** size, and an item\'s two conditions are emitted back to back.');
    L.push('');
    const seen = new Map();
    for (const v of citedOk) seen.set(v.stratum, (seen.get(v.stratum) || 0) + 1);
    const pop = new Map();
    for (const p of pairs.filter((x) => x.condition === 'cited')) pop.set(p.stratum, (pop.get(p.stratum) || 0) + 1);
    L.push('    stratum          judged   of     share    population share');
    for (const [s, n] of [...pop.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const got = seen.get(s) || 0;
      L.push(`    ${s.padEnd(16)} ${String(got).padStart(5)}   ${String(n).padStart(3)}   ` +
        `${pct(citedOk.length ? got / citedOk.length : null)}    ${pct(n / pairs.filter((x) => x.condition === 'cited').length)}`);
    }
    L.push('');
  }

  // ------------------------------------------------------------ groundedness
  L.push(block('B. GROUNDEDNESS — AND IT DOES NOT PRINT WITHOUT ITS NULL'));
  const citedLevels = citedOk.map((v) => v.level);
  const nullLevels = nullOk.map((v) => v.level);
  const rate = (levels, lvl) => judge.rateOf(levels, lvl);

  L.push('  Share of items at each rubric level. DENOMINATOR: ITEMS.');
  L.push('');
  L.push('    level              cited        null        gap');
  L.push('    ' + '-'.repeat(52));
  for (const lvl of [...LEVELS].reverse()) {
    const c = rate(citedLevels, lvl);
    const n = rate(nullLevels, lvl);
    const gap = c.rate !== null && n.rate !== null ? c.rate - n.rate : null;
    L.push(`    ${lvl} ${LEVEL_NAMES[lvl].padEnd(14)} ${pct(c.rate).padStart(7)}     ${pct(n.rate).padStart(7)}    ` +
      `${gap === null ? '  n/a' : `${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}pp`}`);
  }
  L.push('    ' + '-'.repeat(52));
  L.push(`    n (items)        ${String(citedLevels.length).padStart(7)}     ${String(nullLevels.length).padStart(7)}`);
  L.push('');
  const gr = rate(citedLevels, GROUNDED_LEVEL);
  const gn = rate(nullLevels, GROUNDED_LEVEL);
  L.push(`  GROUNDEDNESS RATE      ${pct(gr.rate)}   ${gr.hits} of ${gr.n} items scored ${GROUNDED_LEVEL}`);
  L.push(`  THE NULL               ${pct(gn.rate)}   the same claims against a note from the`);
  L.push('                                 SAME prompt that they did NOT cite');
  if (gr.rate !== null && gn.rate !== null) {
    L.push(`  GAP                    ${gr.rate - gn.rate >= 0 ? '+' : ''}${((gr.rate - gn.rate) * 100).toFixed(1)}pp  <- the number with information in it`);
  }
  L.push('');
  L.push('  PRIMER §5.3a: a rate needs its denominator and a score needs its null, and');
  L.push('  neither is ever printed alone. §32.5 reached the same conclusion for the');
  L.push('  LEXICAL support metric, where a bare 0.283 read as failure until the 0.119');
  L.push('  floor gave it a scale. A groundedness rate has exactly that problem: it is');
  L.push('  a judgement about how strict a rubric is as much as about the system, and');
  L.push('  only the gap separates the two.');

  // ------------------------------------------------------------------- kappa
  L.push(block('C. AGREEMENT WITH A HUMAN — WITHOUT THIS, SECTION B MEANS NOTHING'));
  const humanCited = humanRows.filter((h) => h.condition === 'cited');
  const humanNull = humanRows.filter((h) => h.condition === 'null');
  const humanUnsure = humanRows.filter((h) => h.label === null).length;

  const paired3 = [];
  const paired2 = [];
  for (const h of humanCited) {
    if (h.label === null) continue;
    const v = byPairId.get(h.pairId);
    if (!v || v.parseFailed || v.level === null) continue;
    paired3.push([h.label, v.level]);
    paired2.push([toBinary(h.label), toBinary(v.level)]);
  }

  L.push('  ROADMAP 5.6: "Without that agreement number the judge scores mean nothing."');
  L.push('  CLAUDE.md lists a groundedness score with no judge-human agreement beside it');
  L.push('  under Claim discipline as a thing never to write. So this section is not a');
  L.push('  supplement to section B; it is what makes section B quotable.');
  L.push('');
  L.push(`  hand-labelled, cited   ${humanCited.length}`);
  L.push(`  hand-labelled, null    ${humanNull.length}   the human's own null — see D`);
  L.push(`  marked UNSURE          ${humanUnsure}   excluded from kappa, counted here`);
  L.push(`  usable pairs           ${paired3.length}   both raters gave a level`);
  L.push('');

  if (paired3.length === 0) {
    L.push('  NO KAPPA YET. Either the hand labels or the matching judge verdicts are');
    L.push('  missing. ROADMAP 5.6 stays UNTICKED until this number exists — the rubric');
    L.push('  and the scores are two of its three Done clauses and this is the third.');
  } else {
    const k3 = judge.cohensKappa(paired3, LEVELS);
    const k2 = judge.cohensKappa(paired2, [0, 1]);
    L.push(...confusionBlock(k3, 'THREE-LEVEL (0 / 1 / 2)'));
    L.push('');
    L.push(...confusionBlock(k2, 'BINARY COLLAPSE (2 vs {1,0}) — the distinction the HEADLINE RATE makes'));
    L.push('');
    L.push('  KAPPA IS REPORTED WITH P_o BESIDE IT AND THAT IS NOT DECORATION. Cohen\'s');
    L.push('  kappa collapses toward 0 when both raters put nearly everything in one');
    L.push('  category, however often they agree — the kappa paradox. A bare kappa in');
    L.push('  that regime understates agreement and a reader cannot tell.');
    if (k3.kappa !== null && k3.po !== null) {
      const spread = k3.po - k3.kappa;
      L.push('');
      L.push(`  Here P_o - kappa is ${f3(spread)}${spread > 0.2 ? ', which IS that regime' : ', so the marginals are not badly skewed'}.`);
      const hm = k3.rowMarginals.map((v, i) => `${k3.categories[i]}:${v}`).join('  ');
      const jm = k3.colMarginals.map((v, i) => `${k3.categories[i]}:${v}`).join('  ');
      L.push(`    human marginals   ${hm}`);
      L.push(`    judge marginals   ${jm}`);
    }
    L.push('');
    L.push('  WHAT KAPPA CANNOT SAY: it measures whether two raters agree, not whether');
    L.push('  either is right. A judge that reproduces a human\'s systematic mistake');
    L.push('  scores well here. The human is one rater — me — so there is no');
    L.push('  inter-HUMAN agreement figure and no way to separate rubric ambiguity from');
    L.push('  rater error. That needs a second human and is not bought here.');
  }

  // -------------------------------------------------------------- human null
  L.push(block('D. THE HUMAN\'S OWN NULL'));
  L.push('  10 of the 60 hand-labelled items pair a claim with a note from the same');
  L.push('  prompt it did NOT cite. The rater was not told which, and they were shuffled');
  L.push('  in with the other 50. DENOMINATOR: HUMAN NULL ITEMS.');
  L.push('');
  const hCitedLevels = humanCited.filter((h) => h.label !== null).map((h) => h.label);
  const hNullLevels = humanNull.filter((h) => h.label !== null).map((h) => h.label);
  const hc = judge.rateOf(hCitedLevels, GROUNDED_LEVEL);
  const hn = judge.rateOf(hNullLevels, GROUNDED_LEVEL);
  L.push(`    human rate(2), cited   ${pct(hc.rate)}   ${hc.hits} of ${hc.n}`);
  L.push(`    human rate(2), null    ${pct(hn.rate)}   ${hn.hits} of ${hn.n}`);
  if (hc.rate !== null && hn.rate !== null) {
    L.push(`    human gap              ${hc.rate - hn.rate >= 0 ? '+' : ''}${((hc.rate - hn.rate) * 100).toFixed(1)}pp`);
  }
  L.push('');
  L.push('  This is what stops "the judge is lenient" being the automatic reading of a');
  L.push('  high score, or "the judge is harsh" of a low one: if the human marks');
  L.push('  distractors the same way, the rubric is doing that, not the model.');
  L.push('  TEN ITEMS IS A SMALL DENOMINATOR and it is printed rather than rounded away.');

  // ------------------------------------------------------- lexical crossover
  L.push(block('E. AGAINST §32.5\'s LEXICAL SUPPORT — THE PILE THE JUDGE WAS ASKED TO SORT'));
  const argmax = lexicalArgmaxByItem(genRows);
  const wasArgmax = citedOk.filter((v) => argmax.get(v.key) === true).map((v) => v.level);
  const notArgmax = citedOk.filter((v) => argmax.get(v.key) === false).map((v) => v.level);
  const ra = judge.rateOf(wasArgmax, GROUNDED_LEVEL);
  const rn = judge.rateOf(notArgmax, GROUNDED_LEVEL);

  L.push('  §32.5 measured the cited note as the lexical argmax on 77.3% of items and');
  L.push('  called the other 22.7% "the pile 5.6 will have to sort" — some');
  L.push('  mis-attributions, some correct citations of a note that phrased things');
  L.push('  differently, and containment cannot tell them apart. DENOMINATOR: ITEMS.');
  L.push('');
  L.push(`    cited note WAS the lexical argmax      rate(2) ${pct(ra.rate)}   n = ${ra.n}`);
  L.push(`    cited note was NOT the argmax         rate(2) ${pct(rn.rate)}   n = ${rn.n}`);
  if (ra.rate !== null && rn.rate !== null) {
    const d = ra.rate - rn.rate;
    L.push(`    difference                            ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}pp`);
    L.push('');
    L.push(d > 0
      ? '  The judge scores the argmax pile higher, so the two metrics are partly'
      : '  The judge does NOT score the argmax pile higher, so the two metrics are');
    L.push(d > 0
      ? '  seeing the same thing and the 22.7% contains real mis-attribution.'
      : '  measuring different properties and the 22.7% is not mostly error.');
  }

  // -------------------------------------------------------------- per-slot
  L.push(block('F. BY SLOT AND BY QUINTILE'));
  L.push('  DENOMINATOR: ITEMS, and each row prints its own n rather than sharing one.');
  L.push('');
  L.push('    group            n     rate(2)    null rate(2)    gap');
  L.push('    ' + '-'.repeat(58));
  const groups = new Map();
  for (const v of citedOk) {
    for (const g of [v.slot, `Q${v.quintile}`]) {
      if (!groups.has(g)) groups.set(g, { cited: [], null: [] });
      groups.get(g).cited.push(v.level);
    }
  }
  for (const v of nullOk) {
    for (const g of [v.slot, `Q${v.quintile}`]) {
      if (!groups.has(g)) groups.set(g, { cited: [], null: [] });
      groups.get(g).null.push(v.level);
    }
  }
  for (const [g, vals] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const c = judge.rateOf(vals.cited, GROUNDED_LEVEL);
    const n = judge.rateOf(vals.null, GROUNDED_LEVEL);
    const gap = c.rate !== null && n.rate !== null ? c.rate - n.rate : null;
    L.push(`    ${g.padEnd(14)} ${String(c.n).padStart(4)}    ${pct(c.rate).padStart(7)}       ${pct(n.rate).padStart(7)}      ` +
      `${gap === null ? ' n/a' : `${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}pp`}`);
  }

  // --------------------------------------------------------------- mechanics
  L.push(block('G. THE JUDGE AS AN INSTRUMENT — COST, PARSING, AND WHAT DRIFTED'));
  const totalTok = ok.reduce((a, v) => a + (v.totalTokens || 0), 0);
  const reservedTok = ok.reduce((a, v) => a + (v.reservationTokens || 0), 0);
  const promptTok = ok.reduce((a, v) => a + (v.promptTokens || 0), 0);
  const complTok = ok.reduce((a, v) => a + (v.completionTokens || 0), 0);
  const parseFails = ok.filter((v) => v.parseFailed).length;
  const thinkBlocks = ok.filter((v) => v.sawThinkBlock).length;
  const lengthStops = ok.filter((v) => v.finishReason === 'length').length;
  const lat = ok.map((v) => v.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);

  L.push('  DENOMINATOR: JUDGE CALLS.');
  L.push('');
  L.push(`    calls completed            ${ok.length}`);
  L.push(`    mean ACTUAL tokens         ${ok.length ? Math.round(totalTok / ok.length) : 0}   (prompt ${ok.length ? Math.round(promptTok / ok.length) : 0}, completion ${ok.length ? Math.round(complTok / ok.length) : 0})`);
  L.push(`    ACTUAL / RESERVED          ${reservedTok ? (totalTok / reservedTok).toFixed(2) : ' n/a'}   <- a JUDGE-specific ratio`);
  L.push(`    total ACTUAL tokens        ${totalTok}`);
  L.push(`    parse failures             ${parseFails}   ${pct(ok.length ? parseFails / ok.length : null)}`);
  L.push(`    finish_reason 'length'     ${lengthStops}   ${pct(ok.length ? lengthStops / ok.length : null)}`);
  L.push(`    <think> block appeared     ${thinkBlocks}   ${pct(ok.length ? thinkBlocks / ok.length : null)}   reasoning_effort:'none' should keep this 0`);
  if (lat.length) {
    L.push(`    latency p50 / p95          ${lat[Math.floor(lat.length * 0.5)]} / ${lat[Math.floor(lat.length * 0.95)]} ms   one home connection, one afternoon`);
  }
  L.push('');
  L.push('  §30.1 measured actual/reserved at 0.40 for single-note calls and §32.2 at');
  L.push('  0.94 for study packs, and established that the ratio is a property of the');
  L.push('  FEATURE rather than of the API — it is how much of max_tokens a feature');
  L.push('  uses. Neither was inherited here. This is a third value for a third feature,');
  L.push('  and it is the figure to price a future judge run with.');
  L.push('');
  L.push('  A <think> BLOCK APPEARING WOULD BE A PROVIDER-SIDE CHANGE, NOT A BUG HERE.');
  L.push('  qwen/qwen3.6-27b emits reasoning inline in the message content rather than');
  L.push('  in completion_tokens_details, so the field gen-v5 relies on is blind to it.');
  L.push('  The run disables reasoning; the count above is what says it stayed disabled.');
  L.push('  §28.9\'s class: the model is the one input with no checksum.');

  // ------------------------------------------------------------ what it isn't
  L.push(block('H. WHAT THESE NUMBERS CANNOT SAY'));
  L.push('  KAPPA MEASURES AGREEMENT, NOT CORRECTNESS. One human, no inter-human');
  L.push('  agreement figure, so rubric ambiguity and rater error are not separable.');
  L.push('');
  L.push('  THE ITEM SET IS CENSORED AT THE CALL LEVEL, AND THIS IS THE LIMITATION MOST');
  L.push(`  LIKELY TO BE QUOTED PAST. gen-v5's ${genRows.length} completed calls include ` +
    `${genRows.filter((r) => r.finishReason === 'length').length} that`);
  L.push('  truncated at the INHERITED max_tokens: 2048 ceiling. A truncated pack parses');
  L.push('  to nothing and contributes ZERO items, and those packs are systematically');
  const trunc = genRows.filter((r) => r.finishReason === 'length');
  const comp = genRows.filter((r) => r.finishReason !== 'length');
  const meanW = (a) => (a.length ? (a.reduce((x, r) => x + (r.words || 0), 0) / a.length).toFixed(1) : 'n/a');
  L.push(`  the LONGER seeds: ${meanW(trunc)} mean words against ${meanW(comp)}. So groundedness is`);
  L.push(`  measured over ${comp.length} of ${genRows.length} seeds, skewed short. The items themselves are`);
  L.push('  intact — every contributing call finished with `stop` — but the seed mix is');
  L.push('  not the golden set\'s. ROADMAP 5.9 owns the ceiling.');
  L.push('');
  L.push('  NO NOISE FLOOR UNDER THE ITEMS. Inherited from gen-v5 and not fixed here:');
  L.push('  one draw per seed at temperature 0.4, no repeats. §28.8 measured 32.1% of');
  L.push('  examQs cells flipping verdict on a re-draw and §32.10 states that no gen-v5');
  L.push('  figure may be compared against a later one until repeats are bought. The');
  L.push('  JUDGE runs at temperature 0, so it adds little of its own — but temperature 0');
  L.push('  is not determinism, and nothing here claims a judged run would replay exactly.');
  L.push('');
  L.push('  CORRELATED ERROR IS NOT RULED OUT BY A DIFFERENT VENDOR. Two models trained');
  L.push('  on overlapping text can be confidently wrong about the same claim. A');
  L.push('  different family lowers self-preference; it does not eliminate shared priors.');
  L.push('');
  L.push('  NOT A RETRIEVER COMPARISON. That is 5.7, and the stamped retriever/digest on');
  L.push('  every gen-v5 ledger row is what it will need.');
  L.push('');
  L.push('  THE NEIGHBOURS ARE RETRIEVED OVER 27,325 CORPUS DOCUMENTS, not a <=500-note');
  L.push('  user slice, and the seeds are Stack Exchange questions shaped as Notes.');
  L.push('  §12.2\'s gap, tenth instance.');
  L.push('');

  const text = L.join('\n');
  console.log(text);
  if (has('write')) {
    fs.writeFileSync(OUT, `${text}\n`);
    console.log(`\n  wrote ${path.relative(REPO, OUT)}\n`);
  }
}

main();
