#!/usr/bin/env node
'use strict';

/**
 * label-judge-set.js — Phase 5.6. THE HUMAN RATER'S SURFACE.
 *
 *   npm run judge:label            label the next unlabelled item
 *   npm run judge:label -- --review   re-read what you labelled; change nothing
 *
 * PURE. No key, no network, nothing under data/. It spends no quota and can be
 * run at any point, including while the daily cap is empty — which is the whole
 * reason the labelling is sequenced FIRST.
 *
 * ---------------------------------------------------------------------------
 * THE HUMAN LABELS BEFORE THE JUDGE RUNS, AND THAT IS SEQUENCING RATHER THAN
 * DISCIPLINE
 * ---------------------------------------------------------------------------
 *
 * Cohen's kappa is only a number about two INDEPENDENT raters. A human who has
 * seen the judge's verdict is not one, and no instruction undoes that after the
 * fact — "I did not let it influence me" is exactly the claim that cannot be
 * checked. So this tool never displays a judge verdict, never reads the judge
 * ledger at all, and is run before the first judge call.
 *
 * THE RATER IS ALSO BLIND TO THE CONDITION. 50 of the 60 items pair a claim
 * with the note it cited; 10 pair it with a note from the same prompt it did
 * NOT cite. They are shuffled together and rendered identically, so the human
 * null is a real null — and if the rater marks distractors SUPPORTED at a
 * material rate, the judge's own leniency stops being the obvious reading of a
 * high score.
 *
 * WHAT THE RATER SEES IS WHAT THE MODEL SEES. The passage and claim are built
 * by the same judge-rubric.js functions the runner uses, from the same ledger
 * row, so the two raters are grading the same object rather than two renderings
 * of it. The rubric is printed on request with `?`.
 *
 * ---------------------------------------------------------------------------
 * RESUMABLE FROM THE FIRST KEYSTROKE
 * ---------------------------------------------------------------------------
 *
 * Every keypress appends one line to results/gen-judge-human.jsonl and is
 * flushed before the next item renders. Ctrl-C at item 37 loses nothing. This
 * is the same rule the API runners follow for the same reason — every long run
 * in this project has stopped early — and a human sitting is a long run whose
 * interruptions are not even rate limits.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const judge = require('./lib/judge-metrics');
const { RUBRIC, buildUserMessage, LEVEL_NAMES } = require('./lib/judge-rubric');

const REPO = path.resolve(__dirname, '..', '..');
const LEDGER = path.join(REPO, 'results', 'gen-v5.calls.jsonl');
const SET = path.join(REPO, 'results', 'gen-judge-set.jsonl');
const HUMAN = path.join(REPO, 'results', 'gen-judge-human.jsonl');

const has = (name) => process.argv.includes(`--${name}`);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/**
 * Resolve one pair into the exact passage and claim the judge will be sent.
 *
 * Nothing is stored on the pair row but identifiers (§8.5), so this is where
 * the text comes back — from the gen-v5 ledger, which carries what was actually
 * sent to the generator.
 */
function resolvePair(pair, rowsBySeed) {
  const studyPackMetrics = require('./lib/studypack-metrics');
  const row = rowsBySeed.get(String(pair.seedId));
  if (!row) return null;

  const notes = (row.context && row.context.notes) || [];
  const passage = notes.find((n) => n.label === pair.passageLabel);
  if (!passage) return null;

  let seen = 0;
  for (const { slot, element } of studyPackMetrics.itemsOf(row.rawText)) {
    if (slot !== pair.slot) continue;
    if (seen === pair.itemIndex) {
      return {
        claim: studyPackMetrics.claimText(slot, element),
        passageTitle: passage.title,
        passageText: passage.text
      };
    }
    seen += 1;
  }
  return null;
}

function wrap(text, width, indent) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > width) {
        out.push(indent + line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(indent + line);
  }
  return out.join('\n');
}

function render(pair, resolved, n, total) {
  console.clear();
  console.log('='.repeat(78));
  console.log(`  ITEM ${n} of ${total}                         ? rubric   q save and quit`);
  console.log('='.repeat(78));
  console.log('');
  console.log('  PASSAGE');
  console.log(wrap(resolved.passageTitle, 72, '    '));
  console.log('');
  console.log(wrap(resolved.passageText, 72, '    '));
  console.log('');
  console.log('-'.repeat(78));
  console.log('');
  console.log('  CLAIM');
  console.log(wrap(resolved.claim, 72, '    '));
  console.log('');
  console.log('='.repeat(78));
  console.log('   2 SUPPORTED     every assertion is in the passage or follows from it');
  console.log('   1 PARTIAL       right subject, but part of the assertion is not there');
  console.log('   0 UNSUPPORTED   contradicted, about something else, or simply absent');
  console.log('   u UNSURE        recorded, and excluded from kappa with its count stated');
  console.log('');
  process.stdout.write('   your verdict >  ');
}

function summarise(labels) {
  const counts = { 0: 0, 1: 0, 2: 0, u: 0 };
  for (const l of labels) counts[l.label === null ? 'u' : l.label] += 1;
  const n = labels.length;
  console.log(`\n  labelled ${n}`);
  for (const k of ['2', '1', '0']) {
    console.log(`    ${k} ${LEVEL_NAMES[k].padEnd(12)} ${String(counts[k]).padStart(3)}` +
      `${n ? `   ${((counts[k] / n) * 100).toFixed(1)}%` : ''}`);
  }
  console.log(`    u UNSURE       ${String(counts.u).padStart(3)}`);
}

async function main() {
  const pairs = readJsonl(SET);
  if (pairs.length === 0) {
    console.error('No pair set. Build it first:  npm run judge:set -- --write');
    process.exit(1);
  }
  const rowsBySeed = new Map(readJsonl(LEDGER).filter((r) => r.ok).map((r) => [String(r.seedId), r]));

  // The 60 the human rates, shuffled so the 10 nulls are not clustered and the
  // rater cannot infer a condition from position. Deterministic: the same
  // sitting resumes in the same order after an interrupt.
  const wanted = pairs
    .filter((p) => p.humanLabelled)
    .sort((a, b) => judge.hash32(`order|${a.pairId}`) - judge.hash32(`order|${b.pairId}`));

  const done = readJsonl(HUMAN);
  const doneIds = new Set(done.map((d) => d.pairId));

  if (has('review')) {
    console.log(`\nPHASE 5.6 — ${done.length} of ${wanted.length} items labelled.`);
    summarise(done);
    console.log('\n  This tool never shows a judge verdict. Agreement is `npm run eval:judge`.\n');
    return;
  }

  const todo = wanted.filter((p) => !doneIds.has(p.pairId));
  if (todo.length === 0) {
    console.log(`\n  All ${wanted.length} items are labelled.`);
    summarise(done);
    console.log('\n  Next:  npm run judge:run          (this one SPENDS QUOTA)\n');
    return;
  }

  console.log('\nPHASE 5.6 — HAND LABELLING\n');
  console.log(`  ${todo.length} of ${wanted.length} items left. One keypress each; every answer is`);
  console.log('  saved before the next item renders, so Ctrl-C loses nothing.\n');
  console.log('  You are rating a CLAIM against a PASSAGE. Some passages are the note the');
  console.log('  claim cited and some are a different note from the same prompt — you are');
  console.log('  not told which, deliberately, and neither is the model.\n');
  console.log('  Press any key to start, ? for the full rubric.');

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const stream = fs.createWriteStream(HUMAN, { flags: 'a' });
  let i = 0;
  let shownAt = Date.now();

  // Three states rather than a boolean. The rubric screen has to return to the
  // CURRENT item without recording a verdict for it, and a two-state flag
  // cannot express "showing the rubric on top of an item already rendered" —
  // it silently skips the item instead, which is a labelling harness losing a
  // rating without saying so.
  let mode = 'intro';

  const advance = () => {
    if (i >= todo.length) {
      stream.end();
      console.clear();
      console.log('\n  DONE. All items labelled.');
      summarise(readJsonl(HUMAN));
      console.log('\n  Next:  npm run judge:run          (this one SPENDS QUOTA)\n');
      process.exit(0);
    }
    const pair = todo[i];
    const resolved = resolvePair(pair, rowsBySeed);
    if (!resolved) {
      console.error(`\nCannot resolve ${pair.pairId} against the gen-v5 ledger.`);
      process.exit(1);
    }
    render(pair, resolved, done.length + i + 1, wanted.length);
    mode = 'item';
    shownAt = Date.now();
  };

  const showRubric = (back) => {
    console.clear();
    console.log(RUBRIC);
    console.log(`\n  Press any key to ${back}.`);
    mode = 'rubric';
  };

  process.stdin.on('keypress', (str, key) => {
    if (key && key.ctrl && key.name === 'c') {
      stream.end();
      console.log('\n\n  Stopped. Everything answered so far is saved.\n');
      process.exit(0);
    }
    const ch = String(str || '').toLowerCase();

    if (mode === 'intro') {
      if (ch === '?') showRubric('begin');
      else advance();
      return;
    }
    if (mode === 'rubric') {
      // Re-render the CURRENT item. `i` only moves on a verdict, so returning
      // from the rubric cannot skip one.
      advance();
      return;
    }

    if (ch === '?') {
      showRubric('return to the item');
      return;
    }
    if (ch === 'q') {
      stream.end();
      console.log('\n\n  Saved and stopped.\n');
      process.exit(0);
    }
    if (!['0', '1', '2', 'u'].includes(ch)) return;

    const pair = todo[i];
    stream.write(`${JSON.stringify({
      pairId: pair.pairId,
      key: pair.key,
      seedId: pair.seedId,
      slot: pair.slot,
      stratum: pair.stratum,
      condition: pair.condition,
      passageLabel: pair.passageLabel,
      label: ch === 'u' ? null : Number(ch),
      unsure: ch === 'u',
      ms: Date.now() - shownAt,
      at: new Date().toISOString()
    })}\n`);
    i += 1;
    advance();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
