#!/usr/bin/env node
'use strict';

/**
 * build-judge-set.js — Phase 5.6. The pre-registration.
 *
 *   npm run judge:set                 print the plan; write nothing
 *   npm run judge:set -- --write      write results/gen-judge-set.jsonl
 *                                     and  results/gen-judge-rubric.txt
 *   npm run judge:set -- --variant v7 --write     the 5.7 arm
 *
 * ---------------------------------------------------------------------------
 * 5.7's ARM CARRIES NO HUMAN SAMPLE, AND THAT IS PRE-REGISTERED, NOT SKIPPED
 * ---------------------------------------------------------------------------
 *
 * A variant set is built by the SAME buildPairSet over a different generation
 * ledger, with one difference: `humanLabelled` is false on every row.
 *
 * WHY. The hand labels validate the INSTRUMENT — this judge, at this
 * temperature, under this rubric — and the instrument is byte-identically
 * frozen across the two arms (scripts/lib/judge-rubric.js and
 * scripts/lib/judge-metrics.js are untouched by 5.7, and the run refuses to
 * start if the model moves). A second kappa would therefore measure the same
 * instrument twice rather than validate a new one. What it WOULD buy is a
 * second three-level agreement figure on a different item population, which is
 * a real experiment and a different one.
 *
 * WHAT IT COSTS, STATED HERE RATHER THAN DISCOVERED IN THE WRITEUP: arm B's
 * groundedness figures carry 5.6's kappa beside them by TRANSFER, and transfer
 * is an assumption. §33.8 already establishes that the binary kappa is 0.000
 * with a degenerate marginal, so the headline rate has no human validation in
 * either arm — collecting 60 more labels would not change that, and pretending
 * it would is the misreading this paragraph exists to block.
 *
 * THE WITHHOLDING MECHANISM IS UNCHANGED AND STILL EXACTLY AS STRICT. Both
 * display paths gate on `humanWanted > 0 && labels incomplete`. Arm A wants 60
 * and has 60. Arm B wants none, so there is no rater to anchor and nothing to
 * withhold. §33.6's guarantee is untouched where it applies.
 *
 * PURE. No key, no network, nothing under data/. It reads one committed ledger
 * and regenerates byte-identically, the same property `npm run
 * studypack:calibrate` has.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS COMMITTED WHEN IT REGENERATES
 * ---------------------------------------------------------------------------
 *
 * §8.5 sends regenerable output to .gitignore, and this is the documented
 * exception rather than a lapse: the file is a PRE-REGISTRATION. It fixes which
 * 322 items get judged, which distractor each is judged against, and which 60 a
 * human labels — all before any of it happens. "It regenerates from a fixed
 * seed" is only reassuring if the seed was fixed BEFOREHAND, and the way to
 * show that is a commit that predates the labelling and the run.
 *
 * KEYS ONLY, NO TEXT. Claim and passage both resolve from
 * results/gen-v5.calls.jsonl, which already carries the rendered text of every
 * note that was sent. Copying it here would be §8.5's actual prohibition —
 * derived data committed twice — and would put the judged text out of sync with
 * the judged ledger the first time either moved.
 */

const fs = require('fs');
const path = require('path');

const judge = require('./lib/judge-metrics');
const { RUBRIC } = require('./lib/judge-rubric');

const REPO = path.resolve(__dirname, '..', '..');

/**
 * The default arm is 5.6's and its three paths are the committed ones. A
 * variant names its own everywhere and shares nothing but the code.
 */
const ARMS = {
  default: {
    ledger: path.join(REPO, 'results', 'gen-v5.calls.jsonl'),
    set: path.join(REPO, 'results', 'gen-judge-set.jsonl'),
    rubricFile: path.join(REPO, 'results', 'gen-judge-rubric.txt'),
    retriever: 'v4-bm25',
    human: true,
    phase: '5.6'
  },
  v7: {
    ledger: path.join(REPO, 'results', 'gen-v7.calls.jsonl'),
    set: path.join(REPO, 'results', 'gen-judge-v7-set.jsonl'),
    rubricFile: null,
    retriever: 'v5-embeddings',
    human: false,
    phase: '5.7'
  }
};

const has = (name) => process.argv.includes(`--${name}`);
function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}
function resolveArm() {
  const name = argOf('variant', 'default');
  if (!ARMS[name]) {
    console.error(`unknown --variant "${name}" — known: ${Object.keys(ARMS).join(', ')}`);
    process.exit(1);
  }
  return { name, ...ARMS[name] };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function rubricArtifact(built) {
  const strata = [...built.human.strata.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const humanCited = new Set(built.human.cited);
  const humanNull = new Set(built.human.null);

  const lines = [];
  lines.push('PHASE 5.6 — THE GROUNDEDNESS RUBRIC, COMMITTED VERBATIM');
  lines.push('='.repeat(80));
  lines.push('');
  lines.push('ROADMAP 5.6 requires the rubric to be committed verbatim, and this is that');
  lines.push('file. It is RENDERED from backend/scripts/lib/judge-rubric.js, which is the');
  lines.push('single copy the judge actually receives — a rubric that lives in two places is');
  lines.push('committed twice and verbatim nowhere. tests/judge-rubric.test.js asserts the');
  lines.push('block below still matches that module character for character, so this file');
  lines.push('cannot drift into being a description of the rubric instead of the rubric.');
  lines.push('');
  lines.push('A RUBRIC EDITED AFTER SEEING SCORES IS NOT A RUBRIC. Committed before the');
  lines.push('first judge call, alongside results/gen-judge-predictions.txt.');
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('THE SYSTEM MESSAGE, VERBATIM');
  lines.push('-'.repeat(80));
  lines.push('');
  lines.push(RUBRIC);
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('THE USER MESSAGE');
  lines.push('-'.repeat(80));
  lines.push('');
  lines.push('  PASSAGE');
  lines.push('  <title>');
  lines.push('  <body>');
  lines.push('');
  lines.push('  CLAIM');
  lines.push('  <q + " " + a, or term + " " + definition>');
  lines.push('');
  lines.push('  VERDICT:');
  lines.push('');
  lines.push('PASSAGE BEFORE CLAIM, deliberately. The other order invites the model to read');
  lines.push('the claim first and then scan for confirmation, which is the shape of');
  lines.push('confirmation bias and the thing a groundedness judge exists to resist.');
  lines.push('');
  lines.push('WHAT THE JUDGE IS NEVER SHOWN: the integer label the generator emitted, any');
  lines.push('other note from the same pack, the slot name, the seed id, the quintile, or');
  lines.push('whether this passage is the one the item cited. Both conditions are');
  lines.push('structurally identical at the model\'s input, which is what makes the null a');
  lines.push('null rather than an assertion that it is one.');
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('WHAT WILL BE JUDGED');
  lines.push('-'.repeat(80));
  lines.push('');
  lines.push(`  items judged            ${built.items.length}`);
  lines.push(`  judged pairs            ${built.pairs.length}   (each item twice: cited, null)`);
  lines.push(`  items not judgeable     ${built.unciteable}   no valid citation or no claim text`);
  lines.push(`  null draw               uniform over the other notes in the SAME prompt,`);
  lines.push(`                          keyed on the item and seed ${judge.NULL_SEED}`);
  lines.push('');
  lines.push('  stratum        items   human-cited   human-null');
  lines.push('  ' + '-'.repeat(50));
  for (const [stratum, n] of strata) {
    const hc = built.items.filter((i) => i.stratum === stratum && humanCited.has(i.key)).length;
    const hn = built.items.filter((i) => i.stratum === stratum && humanNull.has(i.key)).length;
    lines.push(`  ${stratum.padEnd(14)} ${String(n).padStart(5)}   ${String(hc).padStart(11)}   ${String(hn).padStart(10)}`);
  }
  lines.push('  ' + '-'.repeat(50));
  lines.push(`  ${'total'.padEnd(14)} ${String(built.items.length).padStart(5)}   ` +
    `${String(built.human.cited.length).padStart(11)}   ${String(built.human.null.length).padStart(10)}`);
  lines.push('');
  lines.push('THE HUMAN\'S 10 NULL ITEMS ARE DRAWN FROM THE COMPLEMENT OF THE 50 CITED ONES.');
  lines.push('A rater shown the same claim twice, once against each passage, has been told');
  lines.push('the two are a pair — the provenance the blinding withholds, handed over by the');
  lines.push('interface instead of by the prompt. The 60 are shuffled together for labelling.');
  lines.push('');
  lines.push('-'.repeat(80));
  lines.push('EMISSION ORDER');
  lines.push('-'.repeat(80));
  lines.push('');
  lines.push('Items are sorted by a fractional within-stratum position, so ANY PREFIX holds');
  lines.push('each stratum in proportion to its size — a partial run is a SAMPLE of the 322,');
  lines.push('not a corner of it. Round-robin was rejected: the strata run 48 down to 18, so');
  lines.push('equal-per-stratum would over-represent Q5 relative to the population the');
  lines.push('headline rate is about. An item\'s two conditions are emitted back to back, so');
  lines.push('a stop never leaves a cited verdict without its null. Human-labelled items sort');
  lines.push('first within their stratum, so kappa is available early rather than last.');
  lines.push('');
  lines.push('§32.8 recorded that gen-v5 had no mechanism protecting its stratification and');
  lines.push('got a balanced partial set by luck, and drew the lesson that the protection has');
  lines.push('to be re-derived for whatever axis a new harness stratifies on. This is that.');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const arm = resolveArm();
  const rows = readJsonl(arm.ledger).filter((r) => r.ok === true);
  if (rows.length === 0) {
    console.error(`No completed rows in ${path.relative(REPO, arm.ledger)}.`);
    process.exit(1);
  }

  // THE LEDGER MUST BE THE ARM'S OWN, CHECKED AGAINST ITS STAMPED RETRIEVER
  // RATHER THAN ITS FILENAME. §33.2's rule: a guard that follows the data
  // cannot be defeated by editing a constant in the same commit as the thing
  // it guards.
  const stamped = new Set(rows.map((r) => (r.retrieval || {}).version));
  if (stamped.size !== 1 || !stamped.has(arm.retriever)) {
    console.error(
      `REFUSING: arm "${arm.name}" expects a ledger retrieved by ${arm.retriever}; ` +
      `${path.relative(REPO, arm.ledger)} is stamped ${[...stamped].map(String).join(', ') || '(nothing)'}.`
    );
    process.exit(1);
  }

  const built = judge.buildPairSet(rows);
  // A variant arm collects no hand labels — see the header. buildPairSet is
  // FROZEN and always nominates 60, so the flag is cleared here, in the
  // script that owns the pre-registration, rather than by editing the metric
  // library 5.6's fifteen mutations are pinned against.
  if (!arm.human) for (const p of built.pairs) p.humanLabelled = false;
  const cited = built.pairs.filter((p) => p.condition === 'cited').length;
  const nulls = built.pairs.filter((p) => p.condition === 'null').length;

  console.log(`PHASE ${arm.phase} — JUDGE PAIR SET${arm.name === 'default' ? '' : ` — ARM "${arm.name}"`}\n`);
  console.log(`  retriever             ${arm.retriever}   THE ONLY VARIABLE ACROSS ARMS`);
  console.log(`  source                ${path.relative(REPO, arm.ledger)}  (${rows.length} ok rows)`);
  console.log(`  items judgeable       ${built.items.length}`);
  console.log(`  not judgeable         ${built.unciteable}`);
  console.log(`  pairs                 ${built.pairs.length}   cited ${cited}, null ${nulls}`);
  console.log(arm.human
    ? `  human sample          ${built.human.cited.length} cited + ${built.human.null.length} null`
    : '  human sample          0   PRE-REGISTERED — the instrument is frozen and was\n' +
      '                            validated on the default arm; a second kappa would\n' +
      '                            measure the same instrument twice. Header says why.');
  console.log(`  null seed             ${judge.NULL_SEED}`);
  console.log('');
  const strata = [...built.human.strata.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [s, n] of strata) console.log(`    ${s.padEnd(16)} ${String(n).padStart(4)} items`);
  console.log('');

  if (!has('write')) {
    console.log('  Nothing written. Add --write.\n');
    return;
  }

  fs.writeFileSync(arm.set, built.pairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
  console.log(`  wrote ${path.relative(REPO, arm.set)}`);
  // The rubric artifact is written once, by the default arm. Both arms receive
  // the same frozen rubric, so a second rendering would be the same bytes under
  // a second name — §33.3's "a rubric in two places is committed twice and
  // verbatim nowhere", which is the reason the rendering exists at all.
  if (arm.rubricFile) {
    fs.writeFileSync(arm.rubricFile, rubricArtifact(built));
    console.log(`  wrote ${path.relative(REPO, arm.rubricFile)}`);
  }
  console.log('');
}

main();
