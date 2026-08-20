#!/usr/bin/env node
'use strict';

/**
 * eval-gen.js — Phase 5.4. The four programmatic generation metrics.
 *
 *   npm run eval:gen              print the table
 *   npm run eval:gen -- --write   print it and write results/gen-metrics.txt
 *
 * ---------------------------------------------------------------------------
 * PURE. NO KEY, NO NETWORK, NOTHING UNDER data/. THAT IS A DECISION.
 * ---------------------------------------------------------------------------
 *
 * All four metrics are computable over ledgers that are already committed, so
 * this issues no API call. The RUNNERS are separate commands — `gen:baseline`,
 * `gen:v2`, `gen:v5` — and they are the only half that spends quota.
 *
 * The consequence worth stating: this can run anywhere, including CI, and it
 * costs nothing to re-run when a ledger grows. §28.13 narrowed §17.1's "the
 * Node eval path is dependency-free" to exclude the whole generation eval path;
 * 5.4 splits that narrowing in half. The generation RUNNER needs `groq-sdk`, a
 * network and a key. The generation REPORTER needs none of them.
 *
 * IT READS ONLY results/. Not data/gen-eval/clusters.jsonl, even though that
 * file is tracked and CI would have it — because §29.11 records that the LOCAL
 * reproduction of CI moves data/ aside entirely, "a superset of what CI lacks".
 * A check that passes in CI and fails in the local reproduction of CI is the
 * worst of both, and §30.3 already made this same choice for
 * tests/studypack.context.test.js.
 *
 * ---------------------------------------------------------------------------
 * ROADMAP 5.4's DONE CRITERION NAMES A TARGET THAT DOES NOT EXIST
 * ---------------------------------------------------------------------------
 *
 * It reads: "npm run eval:gen prints a table; all four metrics populated for
 * gen-v1."
 *
 * TWO OF THE FOUR CANNOT BE POPULATED FOR gen-v1, EVER. gen-v1 and gen-v2 are
 * SINGLE-NOTE generation. §28.12 states it in terms: "No citation validity, no
 * citation support, no groundedness. Those are 5.4 and 5.6, they need generated
 * citations, and single-note generation produces none." There is no run to make
 * and no prompt to fix; the five control prompts have no `source` field and
 * adding one would edit the A/B control.
 *
 * SO THE CITATION COLUMNS READ `n/a - no citations` FOR gen-v1 AND gen-v2, and
 * the criterion is amended in ROADMAP rather than ticked past.
 *
 * THE DEVICE IS ALREADY THIS REPOSITORY'S. gen-schema.js returns `schema: null`
 * for `summarize` and `eli5` and the report prints `n/a`, because — its words —
 * "scoring them 100% conforming would invent a ceiling nobody defined and would
 * drag every mean across features upward for free". A citation-validity of 100%
 * on a run that emits no citations is that exact error, one metric over.
 *
 * WHAT WAS REJECTED, so this is a choice rather than a shrug:
 *   - scoring gen-v1 at 100% (invents a ceiling) or at 0% (calls a design
 *     decision a defect);
 *   - assigning gen-v1 items a citation post-hoc by best lexical overlap. That
 *     is §30.5's rejected move made worse — it is THIS FILE'S SUPPORT METRIC
 *     used as the assignment rule, which would make support 100% by
 *     construction and measuring nothing;
 *   - re-running gen-v1's prompts over cluster text (§28.2's offered fix). It
 *     does not help: the five prompts have no `source` field, so cluster text
 *     still yields zero citations. It would double the quota for nothing.
 *
 * ---------------------------------------------------------------------------
 * TWO DENOMINATORS, INHERITED VERBATIM FROM §5.3a AND gen-schema.js
 * ---------------------------------------------------------------------------
 *
 *   conformance = conforming / completed    garbage is a ZERO
 *   delivery    = completed  / attempted    an API failure is an EXCLUSION
 *
 * Neither is printed alone, in any section, for any run.
 *
 * AND CITATION SUPPORT GETS THE SAME TREATMENT, WHICH IS THE ONE NEW THING HERE.
 * A support rate has no scale on its own: if a claim scores 0.60 against the
 * note it cites and 0.55 against every other note in the same prompt, the
 * citation carries almost no information and a headline of "0.60" hides that
 * completely. So support is never printed without its NULL — the mean
 * containment against the notes in the same prompt the item did NOT cite.
 */

const fs = require('fs');
const path = require('path');

const { classify, ALL_FEATURES, SCHEMAS } = require('./lib/gen-schema');
const spm = require('./lib/studypack-metrics');
const shipped = require('./lib/llm-v1-shipped');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'results', 'gen-metrics.txt');

/**
 * The three runs, in the order they happened.
 *
 * `citations: false` is not a gap in the data — it is a property of the
 * configuration, and the table says so in the cell rather than in a footnote.
 */
const RUNS = [
  {
    key: 'gen-v1', ledger: 'results/gen-baseline.calls.jsonl', kind: 'single-note',
    citations: false, what: 'Phase 5.3 baseline. Five single-note features, max_tokens 1024, frozen copy.'
  },
  {
    key: 'gen-v2', ledger: 'results/gen-v2.calls.jsonl', kind: 'single-note',
    citations: false, what: 'Phase 5.5 re-measure. Same prompts and model, max_tokens 2048, LIVE service.'
  },
  {
    key: 'gen-v5', ledger: 'results/gen-v5.calls.jsonl', kind: 'study-pack',
    citations: true, what: 'Phase 5.4. Study Pack: seed + v4-bm25 neighbours, one call, a citation per item.'
  }
];

/**
 * The golden set is 30 seeds (5.2). Hardcoded rather than read from
 * data/gen-eval/clusters.jsonl on purpose — this script reads nothing under
 * data/ (see the header), and the number it needs is the DENOMINATOR of a
 * coverage statement, which must not silently shrink to whatever happens to be
 * on disk. A ledger covering 9 seeds should say "9 of 30", never "9 of 9".
 */
const GOLDEN_SEEDS = 30;

const has = (name) => process.argv.includes(`--${name}`);

function readJsonl(rel) {
  const file = path.join(REPO, rel);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const rate = (n, d) => (d === 0 || d === null ? null : n / d);
const NA = 'n/a';
const pctCell = (r, width = 7) => (r === null ? NA.padStart(width) : `${(r * 100).toFixed(1)}%`.padStart(width));
const numCell = (v, d = 3, width = 7) => (v === null || v === undefined ? NA.padStart(width) : v.toFixed(d).padStart(width));

function pct(values, p) {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ---------------------------------------------------------------------------
// SINGLE-NOTE RUNS — gen-v1 and gen-v2
// ---------------------------------------------------------------------------

/**
 * Score a single-note ledger with gen-schema.js, UNCHANGED.
 *
 * §29.4 lists "same grader: gen-schema.js NOT EDITED, pinned by its 58 existing
 * tests" as one of four things holding the gen-v1 vs gen-v2 comparison
 * together. This file imports it and does not touch it, so the conformance
 * figures below are the same numbers §28 and §29 published, recomputed rather
 * than restated.
 */
function scoreSingleNote(rows) {
  const attempts = rows.length;
  const okRows = rows.filter((r) => r.ok);

  // One record per cell, first draw only — §28.11's weighting bug. Pooling all
  // draws would let a cell with two count twice, and which cells got two is a
  // property of where the quota ran out.
  const byCell = new Map();
  for (const r of okRows) {
    const k = `${r.seedId}|${r.feature}|${r.repeat}`;
    if (!byCell.has(k)) byCell.set(k, r);
  }
  const completed = [...byCell.values()];

  // Balanced: a seed counts only if all five features completed for it, so
  // every feature is scored over the SAME seeds. §29.6.
  const seedFeatures = new Map();
  for (const r of completed.filter((x) => x.repeat === 0)) {
    if (!seedFeatures.has(String(r.seedId))) seedFeatures.set(String(r.seedId), new Set());
    seedFeatures.get(String(r.seedId)).add(r.feature);
  }
  const balanced = new Set([...seedFeatures.entries()]
    .filter(([, fs]) => fs.size === ALL_FEATURES.length).map(([k]) => k));
  const firstPass = completed.filter((r) => r.repeat === 0 && balanced.has(String(r.seedId)));

  const verdicts = firstPass.map((r) => ({
    row: r,
    v: classify(shipped.applyShippedStrip(r.rawText, r.feature), r.feature)
  }));
  const json = verdicts.filter((x) => x.v.schema !== null);

  return {
    attempts,
    completedCalls: okRows.length,
    seeds: balanced.size,
    scored: verdicts.length,
    jsonCalls: json.length,
    conformance: rate(json.filter((x) => x.v.schema.shape).length, json.length),
    cardinality: rate(json.filter((x) => x.v.schema.cardinality).length, json.length),
    empty: rate(verdicts.filter((x) => x.v.empty).length, verdicts.length),
    veryShort: rate(verdicts.filter((x) => x.v.veryShort).length, verdicts.length),
    truncated: rate(verdicts.filter((x) => x.row.finishReason === 'length').length, verdicts.length),
    perFeature: ALL_FEATURES.map((f) => {
      const mine = verdicts.filter((x) => x.row.feature === f);
      const myJson = mine.filter((x) => x.v.schema !== null);
      return {
        name: f,
        n: mine.length,
        conformance: myJson.length ? rate(myJson.filter((x) => x.v.schema.shape).length, myJson.length) : null,
        empty: rate(mine.filter((x) => x.v.empty).length, mine.length),
        truncated: rate(mine.filter((x) => x.row.finishReason === 'length').length, mine.length)
      };
    }),
    causes: countCauses(json.filter((x) => !x.v.schema.shape).map((x) => x.v.schema.cause))
  };
}

function countCauses(list) {
  const m = new Map();
  for (const c of list) m.set(c || 'unknown', (m.get(c || 'unknown') || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// THE STUDY-PACK RUN — gen-v5
// ---------------------------------------------------------------------------

function scoreStudyPack(rows) {
  const attempts = rows.length;
  const okRows = rows.filter((r) => r.ok);

  // One record per seed, first completion only.
  const bySeed = new Map();
  for (const r of okRows) if (!bySeed.has(String(r.seedId))) bySeed.set(String(r.seedId), r);
  const completed = [...bySeed.values()];

  const scored = completed.map((r) => ({
    row: r,
    v: spm.classifyStudyPack(r.rawText),
    s: spm.scoreCall(r.rawText, (r.context && r.context.notes) || [])
  }));

  const allItems = scored.flatMap((x) => x.s.items);
  const support = scored.flatMap((x) => x.s.support.values);
  const supportOther = scored.flatMap((x) => x.s.support.otherValues);
  const bestMatch = scored.reduce((a, x) => a + x.s.support.bestMatch, 0);
  const unscorable = scored.reduce((a, x) => a + x.s.support.unscorable, 0);

  const cite = (v) => allItems.filter((i) => i.citation === v).length;

  return {
    attempts,
    completedCalls: okRows.length,
    seeds: completed.length,
    scored: scored.length,
    // --- metric 1: schema conformance ---------------------------------------
    conformance: rate(scored.filter((x) => x.v.shape).length, scored.length),
    cardinality: rate(scored.filter((x) => x.v.cardinality).length, scored.length),
    causes: countCauses(scored.filter((x) => !x.v.shape).map((x) => x.v.cause)),
    // --- metric 4: empty / refusal ------------------------------------------
    empty: rate(scored.filter((x) => x.v.empty).length, scored.length),
    veryShort: rate(scored.filter((x) => x.v.veryShort).length, scored.length),
    emptyPack: rate(scored.filter((x) => x.s.items.length === 0).length, scored.length),
    truncated: rate(scored.filter((x) => x.row.finishReason === 'length').length, scored.length),
    // --- metric 2: citation validity ----------------------------------------
    items: allItems.length,
    expectedItems: scored.length * spm.EXPECTED_ITEMS,
    valid: rate(cite('valid'), allItems.length),
    outOfRange: rate(cite('out-of-range'), allItems.length),
    missing: rate(cite('missing'), allItems.length),
    validN: cite('valid'),
    outOfRangeN: cite('out-of-range'),
    missingN: cite('missing'),
    notesCited: mean(scored.map((x) => x.s.citations.notesCited)),
    notesInContext: mean(scored.map((x) => x.s.citations.notesInContext)),
    coverage: mean(scored.map((x) => (x.s.citations.notesInContext
      ? x.s.citations.notesCited / x.s.citations.notesInContext : null)).filter((v) => v !== null)),
    // --- metric 3: citation support -----------------------------------------
    perSlot: spm.SLOT_NAMES.map((slot) => {
      const mine = allItems.filter((i) => i.slot === slot && i.support !== null);
      const oth = mine.map((i) => i.supportOther).filter((v) => v !== null);
      return {
        slot,
        n: mine.length,
        support: mean(mine.map((i) => i.support)),
        other: mean(oth),
        gap: mean(mine.map((i) => i.support)) !== null && mean(oth) !== null
          ? mean(mine.map((i) => i.support)) - mean(oth) : null
      };
    }),
    // Items pointing at label 1, the seed. A pack that leans on the seed is a
    // pack that used the cluster less than it looks. §30.8 reports notesCited
    // for the same reason; this is the sharper version of it.
    seedShare: rate(allItems.filter((i) => i.label === 1).length, allItems.length),
    maxCompletion: Math.max(...completed.map((r) => r.completionTokens || 0)),
    reservedTokens: completed.reduce((a, r) => a + ((r.promptTokens || 0) + (r.maxTokens || 0)), 0),
    support: {
      n: support.length,
      unscorable,
      mean: mean(support),
      median: pct(support, 50),
      p10: pct(support, 10),
      cuts: spm.SUPPORT_CUTS.map((c) => ({ c, rate: rate(support.filter((s) => s >= c).length, support.length) })),
      otherMean: mean(supportOther),
      gap: mean(support) !== null && mean(supportOther) !== null ? mean(support) - mean(supportOther) : null,
      bestMatch: rate(bestMatch, support.length)
    },
    // --- operational --------------------------------------------------------
    latencyP50: pct(completed.map((r) => r.latencyMs), 50),
    latencyP95: pct(completed.map((r) => r.latencyMs), 95),
    promptTokens: mean(completed.map((r) => r.promptTokens).filter(Number.isFinite)),
    completionTokens: mean(completed.map((r) => r.completionTokens).filter(Number.isFinite)),
    reasoningTokens: mean(completed.map((r) => r.reasoningTokens).filter(Number.isFinite)),
    totalTokens: completed.reduce((a, r) => a + (r.totalTokens || 0), 0),
    reasoningShare: (() => {
      const c = mean(completed.map((r) => r.completionTokens).filter(Number.isFinite));
      const g = mean(completed.map((r) => r.reasoningTokens).filter(Number.isFinite));
      return c && g !== null ? g / c : null;
    })(),
    slack: completed.map((r) => r.estimatorSlackTokens).filter(Number.isFinite),
    quintiles: (() => {
      const m = new Map();
      for (const x of scored) m.set(x.row.quintile, (m.get(x.row.quintile) || 0) + 1);
      return [...m.entries()].sort();
    })(),
    droppedNotes: completed.reduce((a, r) => a + ((r.context && r.context.droppedCount) || 0), 0)
  };
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

function main() {
  const out = [];
  const w = (s = '') => out.push(s);

  const loaded = RUNS.map((run) => {
    const rows = readJsonl(run.ledger);
    if (rows === null || rows.length === 0) return { ...run, rows: null, m: null };
    const m = run.kind === 'study-pack' ? scoreStudyPack(rows) : scoreSingleNote(rows);
    return { ...run, rows, m };
  });

  w('PHASE 5.4 — PROGRAMMATIC GENERATION METRICS');
  w('');
  w('  Four metrics, no judge model: schema conformance, citation validity,');
  w('  citation support, empty/refusal rate. Computed over COMMITTED LEDGERS —');
  w('  this script issues no API call, needs no key and reads nothing under');
  w('  data/, so it runs anywhere and costs nothing to re-run.');
  w('');
  w('  Produced by:  cd backend && npm run eval:gen -- --write');
  w('');
  w('='.repeat(78));
  w('A. WHAT IS BEING COMPARED, AND WHY TWO COLUMNS ARE STRUCTURALLY EMPTY');
  w('='.repeat(78));
  w('');
  for (const r of loaded) {
    w(`  ${r.key.padEnd(8)} ${r.kind.padEnd(12)} ${r.rows === null ? 'LEDGER ABSENT' : `${r.rows.length} ledger rows`}`);
    w(`           ${r.what}`);
  }
  w('');
  const v5run = loaded.find((r) => r.key === 'gen-v5');
  if (v5run.m && v5run.m.seeds < GOLDEN_SEEDS) {
    w('  ' + '!'.repeat(74));
    w(`  !! gen-v5 IS PARTIAL: ${v5run.m.seeds} OF ${GOLDEN_SEEDS} GOLDEN SEEDS.`);
    w('  ' + '!'.repeat(74));
    w('');
    w('  EVERY gen-v5 FIGURE BELOW IS OVER THAT FRACTION AND MAY NOT BE QUOTED AS');
    w('  A PROPERTY OF THE GOLDEN SET. This is not a formality. 5.5 reported a');
    w('  15-of-30 result with its partiality stated loudly at every site, drew a');
    w('  headline conclusion from it, and THE OTHER HALF OF THE SET OVERTURNED');
    w('  THAT CONCLUSION — the ceiling it called "mostly variance" turned out to');
    w('  be binding on 43.3% against 46.7%, a gap of 3.4 points rather than 20.');
    w('  §29.5\'s ↳. A sample described honestly is not the same as a sample large');
    w('  enough, and this one is thinner than the one that failed.');
    w('');
    w('  The run stopped on the 200,000/day ORGANISATION cap. Resume with:');
    w('    npm run gen:v5 -- --run        (nothing completed is lost)');
    w('');
  }
  w('  ROADMAP 5.4 ASKS FOR "ALL FOUR METRICS POPULATED FOR gen-v1" AND THAT IS');
  w('  NOT POSSIBLE. gen-v1 and gen-v2 are SINGLE-NOTE generation and produce no');
  w('  citations at all — §28.12: "they need generated citations, and single-note');
  w('  generation produces none." There is no run to make and no prompt to fix:');
  w('  the five control prompts have no `source` field and adding one would edit');
  w('  the A/B control that results/gen-baseline.txt and results/gen-v2.txt');
  w('  measure.');
  w('');
  w('  So the citation columns read `n/a - no citations` for the two single-note');
  w('  runs. THAT IS NOT A GAP IN THE DATA, IT IS A PROPERTY OF THE');
  w('  CONFIGURATION, and it is the device gen-schema.js already uses for');
  w('  `summarize` and `eli5`, which have no schema: n/a rather than 100%,');
  w('  because scoring an undefined thing as perfect invents a ceiling nobody');
  w('  defined and drags every average upward for free.');
  w('');
  w('  Rejected: scoring gen-v1 at 100% or 0%; assigning its items a citation');
  w('  post-hoc by best lexical overlap (that is this file\'s own support metric');
  w('  used as the assignment rule — it would read 100% by construction and');
  w('  measure nothing, §30.5); and re-running the control prompts on cluster');
  w('  text, which still yields no citations and doubles the quota.');
  w('');

  w('='.repeat(78));
  w('B. THE FOUR METRICS');
  w('='.repeat(78));
  w('');
  w('  run       schema conf   citation valid   citation support   empty rate');
  w('  ' + '-'.repeat(70));
  for (const r of loaded) {
    if (r.m === null) {
      w(`  ${r.key.padEnd(9)} ${'no ledger'.padStart(11)}   ${'no ledger'.padStart(14)}   ${'no ledger'.padStart(16)}   ${'no ledger'.padStart(10)}`);
      continue;
    }
    const cv = r.citations ? pctCell(r.m.valid, 14) : 'n/a - none'.padStart(14);
    const cs = r.citations ? numCell(r.m.support.mean, 3, 16) : 'n/a - none'.padStart(16);
    w(`  ${r.key.padEnd(9)} ${pctCell(r.m.conformance, 11)}   ${cv}   ${cs}   ${pctCell(r.m.empty, 10)}`);
  }
  w('');
  w('  `n/a - none` is "this configuration emits no citations", not "not measured".');
  w('  Schema conformance for the single-note runs is over their JSON features');
  w('  only; `summarize` and `eli5` have no schema and are n/a there too.');
  w('');
  w('  DELIVERY IS PRINTED BESIDE CONFORMANCE, NEVER INSTEAD OF IT (§5.3a):');
  w('');
  w('  run       attempted   completed   delivery   scored   seeds');
  w('  ' + '-'.repeat(58));
  for (const r of loaded) {
    if (r.m === null) continue;
    w(`  ${r.key.padEnd(9)} ${String(r.m.attempts).padStart(9)}   ${String(r.m.completedCalls).padStart(9)}   ` +
      `${pctCell(rate(r.m.completedCalls, r.m.attempts), 8)}   ${String(r.m.scored).padStart(6)}   ${String(r.m.seeds).padStart(5)}`);
  }
  w('');
  w('  `scored` is below `completed` where a run kept only balanced first draws:');
  w('  a seed counts only if every feature completed for it, so each feature is');
  w('  measured over the same seeds. §29.6.');
  w('');

  const v5 = loaded.find((r) => r.key === 'gen-v5');

  if (!v5.m) {
    w('='.repeat(78));
    w('C. CITATION METRICS — NOT MEASURED. THE gen-v5 LEDGER DOES NOT EXIST.');
    w('='.repeat(78));
    w('');
    w('  results/gen-v5.calls.jsonl is absent, so citation validity and citation');
    w('  support have no data on any row of this table. They are not "n/a" here');
    w('  the way they are for gen-v1 — they are UNMEASURED, which is a different');
    w('  and worse thing, and the two must not be confused.');
    w('');
    w('  Run it:   npm run gen:v5              (prices it)');
    w('            npm run gen:v5 -- --run     (spends quota)');
    w('');
  } else {
    const m = v5.m;
    w('='.repeat(78));
    w('C. CITATION VALIDITY — gen-v5 ONLY');
    w('='.repeat(78));
    w('');
    w('  Does the note a generated item cites exist in the context that was sent?');
    w('  Mechanical: the label is resolved against the notes on the ledger row.');
    w('');
    w(`    items returned            ${m.items} of ${m.expectedItems} expected`);
    w(`    valid                     ${m.validN.toString().padStart(4)}   ${pctCell(m.valid)}`);
    w(`    out-of-range              ${m.outOfRangeN.toString().padStart(4)}   ${pctCell(m.outOfRange)}   a note that was not there`);
    w(`    missing                   ${m.missingN.toString().padStart(4)}   ${pctCell(m.missing)}   no usable \`source\` at all`);
    w('');
    w(`    notes cited per pack      ${numCell(m.notesCited, 2, 6)} of ${numCell(m.notesInContext, 2, 5)} in context   ` +
      `coverage ${pctCell(m.coverage)}`);
    w('');
    w('    THIS MOSTLY MEASURES OUT-OF-RANGE LABELS, NOT FABRICATED IDENTIFIERS.');
    w('    §30.5 chose small integers over 24-hex ObjectIds — ~1 token per item');
    w('    against ~10, and a model copies a small integer more reliably — and');
    w('    recorded the cost there: this is an easier test than raw ids would be.');
    w('    The MIS-ATTRIBUTION mode is untouched by it and is section D\'s.');
    w('');
    w('='.repeat(78));
    w('D. CITATION SUPPORT — A PROXY, AND IT SHIPS WITH ITS NULL');
    w('='.repeat(78));
    w('');
    w('  Lexical containment of the claim\'s terms in the cited note\'s terms:');
    w('  |claim n note| / |claim|. Tokenizer is utils/keywords.js — the app\'s own,');
    w('  retriever-INDEPENDENT so 5.7 can vary the retriever without moving the');
    w('  measuring instrument, and not a fourth tokenizer.');
    w('');
    w(`    items scored              ${String(m.support.n).padStart(4)}`);
    w(`    unscorable                ${String(m.support.unscorable).padStart(4)}   valid citation, no terms after stopwords`);
    w('');
    w(`    mean                      ${numCell(m.support.mean)}`);
    w(`    median                    ${numCell(m.support.median)}`);
    w(`    p10                       ${numCell(m.support.p10)}`);
    for (const cut of m.support.cuts) {
      w(`    rate >= ${cut.c.toFixed(1)}               ${pctCell(cut.rate)}` +
        (cut.c === spm.SUPPORT_THRESHOLD ? '   <- the PRE-COMMITTED cut' : ''));
    }
    w('');
    w('  THE NULL. The same claims scored against the notes in the SAME prompt');
    w('  they did NOT cite. Without it a support figure has no scale at all.');
    w('');
    w(`    mean vs CITED note        ${numCell(m.support.mean)}`);
    w(`    mean vs OTHER notes       ${numCell(m.support.otherMean)}`);
    w(`    GAP                       ${numCell(m.support.gap)}   <- the number that says whether`);
    w('                                        a citation carries information');
    w('');
    w(`    cited note is the argmax  ${pctCell(m.support.bestMatch)}`);
    w('');
    w('    by slot:');
    for (const ps of m.perSlot) {
      w(`      ${ps.slot.padEnd(11)} n=${String(ps.n).padStart(4)}   cited ${numCell(ps.support)}   ` +
        `other ${numCell(ps.other)}   gap ${numCell(ps.gap)}`);
    }
    w('');
    w(`    items citing the SEED     ${pctCell(m.seedShare)}   label 1 of ${numCell(m.notesInContext, 1, 4)} notes`);
    w('      A pack that leans on the seed used the cluster less than `notesCited`');
    w('      suggests. This is the sharper version of that number.');
    w('');
    w('    argmax IS NOT A CORRECTNESS RATE. A model may legitimately cite a note');
    w('    that is not the best lexical match — that is the paraphrase mode below,');
    w('    seen from the other side. It is a countable event, not a verdict.');
    w('');
    w('  WHAT THIS NUMBER IS NOT, AND BOTH DIRECTIONS ARE REAL:');
    w('    - a correct PARAPHRASE sharing no vocabulary scores zero, and that is');
    w('      NOT a hallucination;');
    w('    - a claim built from generic vocabulary scores high against ANY note in');
    w('      the cluster, so a high score is not evidence of support either.');
    w('  5.6\'s judge is what actually answers the question. This is the cheap');
    w('  programmatic proxy that needs no judge, which is the whole point of 5.4.');
    w('');
    w('='.repeat(78));
    w('E. SCHEMA CONFORMANCE AND EMPTY/REFUSAL — gen-v5');
    w('='.repeat(78));
    w('');
    w(`    shape conformance         ${pctCell(m.conformance)}   object envelope, both arrays, exact keys`);
    w(`    cardinality (6 and 8)     ${pctCell(m.cardinality)}   reported SEPARATELY, not a schema failure`);
    w(`    truncated at ${String(v5.rows.find((r) => r.ok).maxTokens).padEnd(4)}         ${pctCell(m.truncated)}   finish_reason === 'length'`);
    w('');
    w('    A 0% TRUNCATION RATE HERE IS NOT A COMFORTABLE ZERO. The worst call');
    w(`    returned ${m.maxCompletion} completion tokens against a ${v5.rows.find((r) => r.ok).maxTokens} ceiling — ` +
      `${((m.maxCompletion / v5.rows.find((r) => r.ok).maxTokens) * 100).toFixed(1)}% of it,`);
    w('    with the whole run bunched just under the cap. `max_tokens` is INHERITED');
    w('    from a value §29.2 derived for `examQs` demand and never re-derived for a');
    w('    study pack (§30.9), and this says it is close to binding rather than');
    w('    comfortably clear. Read the rate with the headroom beside it.');
    w('');
    w(`    empty response            ${pctCell(m.empty)}`);
    w(`    empty PACK (0 items)      ${pctCell(m.emptyPack)}   parsed fine, returned nothing`);
    w(`    very short (<40 chars)    ${pctCell(m.veryShort)}   A FLAG FOR A HUMAN, NOT A REFUSAL RATE`);
    if (m.causes.length) {
      w('');
      w('    failure causes:');
      for (const [cause, n] of m.causes) w(`      ${cause.padEnd(16)} ${n}`);
    }
    w('');
    w('    `veryShort` is not called a refusal. Detecting "the model declined" is');
    w('    a semantic judgment and belongs to 5.6\'s judge; a length threshold');
    w('    cannot tell a refusal from a terse answer. gen-schema.js\'s rule.');
    w('');
    w('='.repeat(78));
    w('F. OPERATIONAL — gen-v5');
    w('='.repeat(78));
    w('');
    w(`    latency p50 / p95         ${String(m.latencyP50).padStart(6)} / ${String(m.latencyP95).padStart(6)} ms`);
    w('      §29.2\'s linear model (420 + 2.15 x completion) predicts ~4,400 ms at this');
    w('      output length and matched §30.8\'s single call to 2.9%. It does NOT hold');
    w('      across this run: five calls land near the prediction and four are 12-30 s.');
    w('      That spread is provider-side, not output length, so p95 here is a figure');
    w('      about one afternoon on one home connection. 6.5 owns the controlled one.');
    w(`    mean prompt tokens        ${numCell(m.promptTokens, 0, 6)}`);
    w(`    mean completion tokens    ${numCell(m.completionTokens, 0, 6)}`);
    w(`    mean reasoning tokens     ${numCell(m.reasoningTokens, 0, 6)}   ${pctCell(m.reasoningShare)} of the completion`);
    w(`    total ACTUAL tokens       ${String(m.totalTokens).padStart(6)}   what the DAILY cap charged (§30.1)`);
    w(`    total RESERVED tokens     ${String(m.reservedTokens).padStart(6)}   what the PER-MINUTE gate charged`);
    w(`    actual / reserved         ${numCell(rate(m.totalTokens, m.reservedTokens), 2, 6)}`);
    w('');
    w('    THAT RATIO IS 0.40 FOR THE SINGLE-NOTE RUN (§30.1) AND IT IS NOT A');
    w('    PROPERTY OF THE API. It is how much of `max_tokens` a feature actually');
    w('    uses: single-note calls spent ~900 of 2048, a study pack spends ~1,850.');
    w('    So pricing a cluster run at the single-note ratio underestimates it by');
    w('    roughly 2.4x. §30.1\'s instruction — price in ACTUAL tokens — is right;');
    w('    the constant carried into it has to come from the same population.');
    w('');
    w('    THE ESTIMATOR CHECKING ITSELF, on every call, for free:');
    w(`      slack min / mean        ${String(Math.min(...m.slack)).padStart(4)} / ${(mean(m.slack) || 0).toFixed(1)} tokens`);
    w(`      never underestimates    ${m.slack.every((s) => s >= 0) ? 'YES' : 'NO — THE BOUND IS BROKEN'}   over ${m.slack.length} calls`);
    w('');
    w(`    neighbours dropped for budget   ${m.droppedNotes} across ${m.seeds} clusters`);
    w(`    seeds by length quintile        ${m.quintiles.map(([q, n]) => `Q${q}:${n}`).join('  ')}`);
    w('');
    w('='.repeat(78));
    w('G. WHAT THESE NUMBERS CANNOT SAY');
    w('='.repeat(78));
    w('');
    if (m.seeds < GOLDEN_SEEDS) {
      w(`  NOT THE GOLDEN SET. ${m.seeds} of ${GOLDEN_SEEDS} seeds, stopped by the daily cap. The`);
      w('  quintile spread is printed in section F precisely because the golden set');
      w('  is 6 per quintile and a partial run has no mechanism protecting that');
      w('  balance — the seeds are called in file order, which is by id, and any');
      w('  stratification a prefix happens to have is luck rather than design.');
      w('');
    }
    w('  NO NOISE FLOOR EXISTS FOR ANY gen-v5 FIGURE. n = 1 per seed measures');
    w('  BETWEEN-SEED variation only. §28.8 measured 32.1% of `examQs` cells');
    w('  flipping verdict on a re-draw at this temperature and nothing here');
    w('  establishes the equivalent for a study pack. So no figure in sections');
    w('  C-F may be compared against a later one until repeats are bought.');
    w('');
    w('  NO BEFORE. Study Pack has no single-note counterpart with citations, so');
    w('  every gen-v5 figure is a first measurement rather than a delta. §28.2');
    w('  records the confound that makes gen-v1 an unusable "before" for it, and');
    w('  §30.2 names the four variables involved.');
    w('');
    w('  CITATION SUPPORT IS A PROXY (section D) and is labelled one everywhere.');
    w('');
    w('  THE NEIGHBOURS ARE RETRIEVED OVER 27,325 CORPUS DOCUMENTS, not over a');
    w('  <=500-note user slice. §12.2\'s gap, and the seeds are Stack Exchange');
    w('  questions shaped as Notes rather than anybody\'s notebook.');
    w('');
    w('  NOT A COMPARISON ACROSS RETRIEVERS. That is 5.7, and it is what the');
    w('  retriever parameter on buildCluster() and the stamped digest exist for.');
    w('');
  }

  w('='.repeat(78));
  w('H. PER-FEATURE DETAIL — THE SINGLE-NOTE RUNS');
  w('='.repeat(78));
  w('');
  w('  Recomputed from the ledgers by gen-schema.js UNCHANGED, so these agree');
  w('  with results/gen-baseline.txt and results/gen-v2.txt rather than restating');
  w('  them. §29.4\'s same-grader guarantee is what makes that true.');
  w('');
  for (const r of loaded.filter((x) => x.kind === 'single-note' && x.m)) {
    w(`  ${r.key}   ${r.m.seeds} balanced seeds`);
    w('    feature       n   schema conf   truncated   empty');
    w('    ' + '-'.repeat(50));
    for (const f of r.m.perFeature) {
      w(`    ${f.name.padEnd(11)} ${String(f.n).padStart(3)}   ${pctCell(f.conformance, 11)}   ${pctCell(f.truncated, 9)}   ${pctCell(f.empty, 5)}`);
    }
    if (r.m.causes.length) w(`    failure causes: ${r.m.causes.map(([c, n]) => `${c} ${n}`).join(', ')}`);
    w('');
  }
  w('  `summarize` and `eli5` show n/a for schema because they have no schema.');
  w('  Their truncation IS measured — §28.5 recorded a prose truncation that no');
  w('  conformance metric in this project could see, and this is the column.');
  w('');

  const text = out.join('\n') + '\n';
  console.log(text);
  if (has('write')) {
    fs.writeFileSync(OUT, text);
    console.log(`Wrote ${path.relative(REPO, OUT)}`);
  }
}

main();
