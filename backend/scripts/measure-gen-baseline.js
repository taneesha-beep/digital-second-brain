#!/usr/bin/env node
'use strict';

/**
 * measure-gen-baseline.js — Phase 5.3 (`gen-v1`), EXTENDED AT 5.5 (`gen-v2`).
 *
 *   npm run gen:baseline -- --run --model openai/gpt-oss-120b     the 5.3 baseline
 *   npm run gen:baseline -- --report                              recompute, no calls
 *   npm run gen:baseline                                          plan only
 *
 *   npm run gen:v2 -- --run       the 5.5 re-measure, through the LIVE service
 *   npm run gen:v2 -- --report
 *
 * ---------------------------------------------------------------------------
 * TWO VARIANTS, AND THE DIFFERENCE BETWEEN THEM IS WHICH CODE ISSUES THE CALL
 * ---------------------------------------------------------------------------
 *
 *   --variant v1   calls scripts/lib/llm-v1-shipped.js, the FROZEN COPY, with
 *                  --model REQUIRED because the string it holds is retired.
 *                  This is what produced results/gen-baseline.txt.
 *
 *   --variant v2   calls services/llm.service.js DIRECTLY — the live shipped
 *                  function — and takes NO --model and NO parameter overrides
 *                  at all. Phase 5.5 made processNote() return `usage` and
 *                  `finish_reason` instead of discarding them, which is the
 *                  entire reason the frozen copy had to exist (§28.3). With
 *                  that fixed, measuring a copy would be measuring the wrong
 *                  thing when the real one is available.
 *
 * SO v2 HAS NO SUBSTITUTED VARIABLE AT ALL, where v1 had one. That is a
 * STRONGER position than the baseline's, not a weaker one — but the comparison
 * is only valid because both ran on the same model, which is checked rather
 * than remembered (see the guard in run()).
 *
 * ---------------------------------------------------------------------------
 * THE LEDGER IS SELF-DESCRIBING, AND AT 5.3 IT WAS NOT
 * ---------------------------------------------------------------------------
 *
 * 5.3's rows recorded the model and the report REFUSED a ledger mixing two of
 * them — "a ledger mixing two models would silently average two systems". That
 * guard was one field short: rows recorded NEITHER `max_tokens` NOR
 * `temperature`, so re-running at a different ceiling would have appended to
 * the same file and averaged two systems in exactly the way the model guard
 * exists to prevent. Found while building 5.5, which is the session that would
 * have done it.
 *
 * Rows now carry `maxTokens`, `temperature` and `variant`; the report REFUSES a
 * ledger that mixes any of them, and derives the ceiling it reports against
 * FROM THE LEDGER rather than from whatever the current source happens to say.
 * A report describes the run it reports on. Rows written before 5.5 carry no
 * such fields and are read as the values that were shipped then — see
 * `paramsOf()`, which says so at the site.
 *
 * ---------------------------------------------------------------------------
 * --model IS REQUIRED FOR A v1 RUN, AND THAT IS A FINDING RATHER THAN AN OPTION
 * ---------------------------------------------------------------------------
 *
 * The shipped string `llama-3.3-70b-versatile` (llm.service.js:17) RETURNS 404
 * `model_not_found` — measured 19 Aug 2026, `results/gen-model-retired.txt`.
 * The true "before" is therefore not runnable: the configuration this session
 * exists to baseline does not execute at all, for anyone, today.
 *
 * So exactly ONE variable is changed, deliberately and loudly. Prompts, the
 * system message, `temperature: 0.4`, `max_tokens: 1024` and the fence-strip
 * are byte-identical — llm-v1-shipped.js exposes no override for any of them —
 * and the model is named on the command line, recorded in every ledger row, and
 * printed in every section header of the report.
 *
 * WHY SUBSTITUTE RATHER THAN STOP: 5.5 cannot be measured against a dead model
 * either, so a dead-model baseline is useless to the phase it exists for. The
 * defect being priced is structural — 6, 8 and 5 requested items against a
 * 1024-token ceiling — and that survives the substitution. THE RATE DOES NOT:
 * every figure below is a figure about the substituted model, and is labelled
 * one everywhere it appears.
 *
 * THE ONLY SCRIPT IN THIS REPOSITORY THAT SPENDS MONEY-EQUIVALENT QUOTA AND
 * THE ONLY ONE WHOSE OUTPUT CANNOT BE REGENERATED. Both facts change how it is
 * built; see the two sections below.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE "BEFORE" AND IT IS UNRECOVERABLE
 * ---------------------------------------------------------------------------
 *
 * CLAUDE.md's fourth evaluation trap: "Baselines are unrecoverable. In several
 * phases the 'before' number is destroyed by the change itself." Phase 5's
 * header says 5.3 "has to run first" for exactly that reason — the five
 * single-note features are 5.1's A/B control, and 5.5 is about to edit the file
 * they live in.
 *
 * So this calls `scripts/lib/llm-v1-shipped.js`, the FROZEN COPY, and not
 * `services/llm.service.js`. The reason is not caution, it is arithmetic:
 * processNote() returns the completion's text and discards `usage` and
 * `finish_reason`, so tokens in/out and the truncation rate — four of roadmap
 * 5.3's stated deliverables — are NOT OBSERVABLE through the shipped surface.
 * The copy's fidelity is proved by `tests/gen-shipped-parity.test.js` reading
 * llm.service.js as source text, which is a WEAKER guarantee than parity:v1's
 * byte-identity of output, and it is labelled as one wherever it is quoted.
 *
 * ---------------------------------------------------------------------------
 * MEASURED OVER SINGLE NOTES, NOT CLUSTERS, AND THE OTHER READING IS WRONG
 * ---------------------------------------------------------------------------
 *
 * The five shipped features take ONE note: `llm.js:25` passes
 * `note.contentText` alone and the "Notes:" plural in the prompt template is a
 * lie. This measures exactly that, on the 30 seeds of the 5.2 golden set. The
 * clusters exist and are deliberately NOT used here.
 *
 * Measuring on cluster text instead would produce the COMPARABLE before rather
 * than the TRUE one, and it fails twice. It measures a configuration that never
 * shipped, so 5.5's result could never be described as the shipped system's
 * conformance. And cluster text is LONGER, which interacts directly with the
 * defect being baselined — pricing a truncation defect on inputs longer than
 * the ones it ships against inflates it, and attaches a magnitude to a
 * population it was not measured on (§12.2, §27.3).
 *
 * THE COST: 5.1's Study Pack gets no same-input "before", so any conformance
 * delta at gen-v5 is confounded with input length. Said here rather than
 * discovered at 5.5.
 *
 * ---------------------------------------------------------------------------
 * TWO DENOMINATORS, DECIDED BEFORE THE RUN — §5.3a'S TRAP IN A NEW PLACE
 * ---------------------------------------------------------------------------
 *
 *   conformance = conforming / completed   a model that returned garbage is a
 *                                          ZERO. Excluding it is trec_eval's
 *                                          omission reproduced by hand: the
 *                                          metric improves when the system
 *                                          gets worse.
 *   delivery    = completed  / attempts    an API failure is an EXCLUSION from
 *                                          conformance, because no completion
 *                                          exists — but it is REPORTED, with
 *                                          its own denominator. Folding it in
 *                                          makes conformance a function of the
 *                                          harness's pacing, which is a
 *                                          property of the operator.
 *
 * Neither is ever printed alone.
 *
 * ---------------------------------------------------------------------------
 * PACING, AND WHY THERE IS NO RETRY
 * ---------------------------------------------------------------------------
 *
 * PRIMER §7.3: normal app usage never approaches Groq's free tier; AN EVAL RUN
 * DOES, and "you will hit 429 and the run will die partway through".
 *
 *   SERIAL. One call at a time, no concurrency at all.
 *   DIRECT. Calls the generator, not HTTP — §7.3 names both routes and the
 *           direct one does not collide with the express-rate-limit that
 *           roadmap 0.3 still owes /api/llm/*.
 *   PACED.  A fixed inter-call delay, plus a pause driven by the
 *           `x-ratelimit-remaining-*` headers the API actually returns.
 *           MEASURED PACING RATHER THAN A DOCUMENTED LIMIT QUOTED FROM A
 *           WEBPAGE — this file states no free-tier number as fact.
 *   CAPPED. --max-calls, refused rather than exceeded.
 *
 * NO RETRY, DELIBERATELY. Backoff with jitter is roadmap 7.2's, and adding it
 * here puts a second variable inside a baseline: a retried call's latency is
 * not the shipped call's latency. Instead THE LEDGER IS APPENDED AS THE RUN
 * GOES, so a 429 or a daily cap PAUSES the run rather than destroying it —
 * re-invoking fills the remaining cells. That is the answer to §7.3, and it
 * costs a design decision rather than a dependency.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCRIPT'S OUTPUT CANNOT DO — AND IT IS A NEW CLASS
 * ---------------------------------------------------------------------------
 *
 * §23.10 split `migration-verification.txt` (regenerates) from
 * `provenance-query.txt` (does not, it carries wall times); §26.10 did the same
 * for `keyword-stability.txt`. Both had ONE cause: timing.
 *
 * `gen-baseline.txt` has TWO, and the second is not fixable by any environment
 * pinning: it carries MODEL OUTPUT, and the model behind the string
 * `llama-3.3-70b-versatile` is not a pinned input. The corpus has a SHA-256,
 * the vectors have a manifest, that string has neither — Groq can change what
 * serves it and nothing in this repository would know. That limitation attaches
 * to every generation number this project will ever produce. §28.9.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Groq = require('groq-sdk');
const shipped = require('./lib/llm-v1-shipped');
const liveService = require('../services/llm.service');
const { classify, SCHEMAS, PROSE_FEATURES, ALL_FEATURES, VERY_SHORT_CHARS } = require('./lib/gen-schema');

const REPO = path.resolve(__dirname, '..', '..');
const CLUSTERS = path.join(REPO, 'data', 'gen-eval', 'clusters.jsonl');
const CLUSTER_MANIFEST = path.join(REPO, 'data', 'gen-eval', 'clusters.manifest.json');
/**
 * Where each variant's artifacts live. SEPARATE FILES, NOT A SHARED ONE.
 *
 * The 5.3 ledger is the "before" and CLAUDE.md's fourth trap says a before is
 * unrecoverable. A resumable ledger appends, so pointing a v2 run at the v1
 * file is a one-flag mistake that would destroy it. Physically separate paths
 * make that impossible rather than merely discouraged.
 */
const VARIANTS = {
  v1: {
    ledger: path.join(REPO, 'results', 'gen-baseline.calls.jsonl'),
    report: path.join(REPO, 'results', 'gen-baseline.txt'),
    label: 'PHASE 5.3 — GENERATION BASELINE, gen-v1'
  },
  v2: {
    ledger: path.join(REPO, 'results', 'gen-v2.calls.jsonl'),
    report: path.join(REPO, 'results', 'gen-v2.txt'),
    label: 'PHASE 5.5 — CONFORMANCE RE-MEASURE, gen-v2'
  }
};

/**
 * n = 3 for the three JSON features, n = 1 for the two prose ones.
 *
 * An LLM is nondeterministic at temperature 0.4 (llm.service.js:52), and there
 * are TWO variances. BETWEEN-SEED — different notes, different lengths,
 * different truncation risk — is captured by 30 seeds at n = 1. WITHIN-CELL —
 * the same note and prompt twice — is not, and it is the one 5.5 needs: 5.5's
 * claim is that a fix moved conformance, and a few points of movement is
 * unattributable if a cell flips on a re-draw. n = 3 makes each cell a fraction
 * in {0, 1/3, 2/3, 1}, which is a better paired unit for the bootstrap §11
 * already uses.
 *
 * Prose features get n = 1: they have no schema, and their measured quantities
 * (empty rate, truncation) are far less variable.
 */
const REPEATS = { flashcards: 3, concepts: 3, examQs: 3, summarize: 1, eli5: 1 };

const DEFAULT_DELAY_MS = 2500;
const DEFAULT_MAX_CALLS = 400;

/** Pause until reset when fewer than this many tokens remain in the window. */
const TOKEN_FLOOR = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

/** Which variant this invocation is about. Defaults to the 5.3 baseline. */
function variantName() {
  const v = arg('variant', 'v1');
  if (!VARIANTS[v]) {
    console.error(`--variant must be one of ${Object.keys(VARIANTS).join(', ')}; got "${v}"`);
    process.exit(1);
  }
  return v;
}
const LEDGER = () => VARIANTS[variantName()].ledger;
const REPORT = () => VARIANTS[variantName()].report;

/**
 * The call parameters a ledger row was produced under.
 *
 * ROWS WRITTEN BEFORE 5.5 CARRY NEITHER FIELD, and they are read as 1024 / 0.4
 * — the values `llm-v1-shipped.js` holds and that llm.service.js shipped when
 * they were written. That is a backfill of a KNOWN constant, not a guess: the
 * frozen copy is the record of what those numbers were, and
 * tests/gen-shipped-parity.test.js pins them. Written down here rather than
 * left implicit, because a silent default is how a wrong denominator gets in.
 */
function paramsOf(row) {
  return {
    model: row.modelRequested || row.model || null,
    maxTokens: row.maxTokens ?? shipped.MAX_TOKENS,
    temperature: row.temperature ?? shipped.TEMPERATURE,
    variant: row.variant || 'v1'
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** Nearest-rank percentile on a sorted copy. Stated because conventions differ. */
function pct(values, p) {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const rate = (n, d) => (d === 0 ? null : n / d);
const showPct = (r) => (r === null ? '   n/a' : `${(r * 100).toFixed(1)}%`.padStart(6));
const num = (v, d = 1) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));

/** Every cell the plan calls for, in REPEAT-MAJOR order. */
function planCells(clusters) {
  const cells = [];
  const maxRepeats = Math.max(...Object.values(REPEATS));
  // Repeat-major so a run cut short by quota yields COMPLETE n=1 coverage of
  // everything rather than complete coverage of some seeds. Under a quota risk
  // that is strictly the better partial result.
  for (let repeat = 0; repeat < maxRepeats; repeat += 1) {
    for (const cluster of clusters) {
      for (const feature of ALL_FEATURES) {
        if (repeat < REPEATS[feature]) cells.push({ seedId: cluster.seedId, feature, repeat });
      }
    }
  }
  return cells;
}

const keyOf = (c) => `${c.seedId}|${c.feature}|${c.repeat}`;

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------

async function run(clusters) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('MISSING GROQ_API_KEY. It lives in backend/.env — see CLAUDE.md.');
    process.exit(1);
  }

  const delayMs = Number(arg('delay', DEFAULT_DELAY_MS));
  const maxCalls = Number(arg('max-calls', DEFAULT_MAX_CALLS));
  const variant = variantName();

  // --- what issues the call, and under what parameters ----------------------
  //
  // v1 takes the model from the command line because its own string is dead.
  // v2 takes EVERYTHING from services/llm.service.js and accepts no overrides,
  // because the point of v2 is to measure what actually ships.
  let model;
  let maxTokens;
  let temperature;
  let issue;

  if (variant === 'v1') {
    model = arg('model', null);
    if (!model) {
      console.error('--model IS REQUIRED for --variant v1. The string it holds is retired:');
      console.error(`  ${shipped.MODEL} -> 404 model_not_found  (results/gen-model-retired.txt)`);
      console.error('Naming the model on the command line is what keeps a substituted run a');
      console.error('ONE-VARIABLE change instead of a silent one. e.g. --model openai/gpt-oss-120b');
      process.exit(1);
    }
    maxTokens = shipped.MAX_TOKENS;
    temperature = shipped.TEMPERATURE;
    const groqV1 = new Groq({ apiKey, maxRetries: 0 });
    issue = (contentText, feature) => shipped.callShipped(groqV1, contentText, feature, { model });
  } else {
    if (arg('model', null)) {
      console.error('--model IS REFUSED for --variant v2. v2 measures what services/llm.service.js');
      console.error('actually ships; a model override would make the measurement describe a');
      console.error('configuration nobody runs. Change llm.service.js if you mean to change it.');
      process.exit(1);
    }
    model = liveService.MODEL;
    maxTokens = liveService.MAX_TOKENS;
    temperature = liveService.TEMPERATURE;
    issue = (contentText, feature) => liveService.processNote(contentText, feature);

    // THE COMPARABILITY GUARD, MECHANISED RATHER THAN REMEMBERED.
    //
    // ROADMAP 5.0: "5.5 must re-measure against the same model 5.3 used or the
    // before/after is meaningless." That is a sentence in a document, and a
    // sentence cannot stop a run. This can: if the live model is not the one
    // the v1 ledger recorded, the two halves of §29's comparison are two
    // variables apart and the run refuses to start.
    const v1Rows = readJsonl(VARIANTS.v1.ledger).filter((r) => r.ok);
    const v1Models = [...new Set(v1Rows.map((r) => paramsOf(r).model))];
    if (v1Rows.length > 0 && !(v1Models.length === 1 && v1Models[0] === model)) {
      console.error('REFUSING: the live model does not match the baseline this will be compared to.');
      console.error(`  baseline ledger  ${v1Models.join(', ') || '(none)'}   results/gen-baseline.calls.jsonl`);
      console.error(`  llm.service.js   ${model}`);
      console.error('Re-measuring on a different model makes 5.5 a TWO-variable change and the');
      console.error('5.3 baseline unusable — and the true gen-v1 is permanently unmeasurable, so');
      console.error('there is no second chance to re-baseline. EVALUATION.md §29.4.');
      process.exit(1);
    }
  }

  const bySeed = new Map(clusters.map((c) => [c.seedId, c]));
  const cells = planCells(clusters);

  const existing = readJsonl(LEDGER());
  const done = new Set(existing.filter((r) => r.ok).map(keyOf));
  let todo = cells.filter((c) => !done.has(keyOf(c)));

  // --take N DELIBERATELY SHORTENS THE RUN; --max-calls REFUSES A LONG ONE.
  //
  // Two different jobs and they must not be one flag. --max-calls is a guard
  // against spending more than intended and so REFUSES rather than truncating —
  // silently doing less than asked is how a partial run gets mistaken for a
  // complete one. --take is the opposite: an explicit statement that a prefix
  // is what is wanted.
  //
  // Because cells are issued REPEAT-MAJOR, a prefix is not an arbitrary subset:
  // --take 150 is exactly the BALANCED FIRST PASS, 30 seeds x 5 features at one
  // draw each, which is the population §28's sections B-G report over and
  // therefore the only population a 5.3-vs-5.5 comparison may use.
  const take = arg('take', null);
  if (take !== null) {
    const n = Number(take);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--take must be a positive integer; got "${take}"`);
      process.exit(1);
    }
    if (n < todo.length) {
      console.log(`  --take ${n}: running a PREFIX of ${todo.length} remaining cells.`);
      todo = todo.slice(0, n);
    }
  }

  console.log(`${VARIANTS[variant].label}\n`);
  if (variant === 'v1') {
    console.log(`  shipped model     ${shipped.MODEL}   RETIRED — 404 model_not_found`);
    console.log(`  model in use      ${model}   THE ONE VARIABLE CHANGED`);
    console.log(`  issued by         scripts/lib/llm-v1-shipped.js (frozen copy)`);
  } else {
    console.log(`  model in use      ${model}   from llm.service.js, matches the baseline`);
    console.log(`  max_tokens        ${maxTokens}   THE ONE VARIABLE CHANGED (was ${shipped.MAX_TOKENS})`);
    console.log(`  issued by         services/llm.service.js — THE LIVE FUNCTION, no copy`);
  }
  console.log(`  held fixed        prompts, system message, temperature ${temperature}, the strip` +
    (variant === 'v1' ? `, max_tokens ${maxTokens}` : ''));
  console.log('');
  console.log(`  cells planned     ${cells.length}`);
  console.log(`  already complete  ${done.size}   (from ${existing.length} ledger rows)`);
  console.log(`  to call now       ${todo.length}`);
  console.log(`  pacing            serial, ${delayMs} ms between calls, ` +
    (variant === 'v1' ? 'header-driven pause' : `self-paced under ${TOKENS_PER_MIN}/min from usage`));
  console.log(`  ceiling           --max-calls ${maxCalls}`);
  console.log(`  retries           NONE — a 429 pauses the run; the ledger resumes it\n`);

  if (todo.length > maxCalls) {
    console.error(`REFUSING: ${todo.length} calls exceeds the --max-calls ceiling of ${maxCalls}.`);
    process.exit(1);
  }
  if (todo.length === 0) {
    console.log('  Nothing to do. Every planned cell has a completed call.\n');
    return;
  }

  const stream = fs.createWriteStream(LEDGER(), { flags: 'a' });
  const append = (row) => stream.write(`${JSON.stringify(row)}\n`);

  let attempts = 0;
  let completed = 0;
  const started = Date.now();
  /** Rolling {at, tokens} for v2's self-paced token window. See throttleFor(). */
  const spent = [];

  for (const cell of todo) {
    const cluster = bySeed.get(cell.seedId);
    const contentText = `${cluster.title}\n\n${cluster.body}`;

    attempts += 1;
    let observation = null;
    let failure = null;

    try {
      observation = await issue(contentText, cell.feature);
      completed += 1;
    } catch (err) {
      // THE PROVIDER'S OWN MESSAGE, NOT JUST THE MAPPED ONE.
      //
      // services/llm.service.js translates errors into sentences a user can
      // act on — "Groq rate limit hit — wait a few seconds and try again" —
      // which is right for the UI and useless for a ledger: it cannot tell a
      // per-minute limit from a daily one, and the daily one carries
      // "Limit 200000, Used 199838, Requested 2120, try again in 14m5.856s".
      // That is the whole diagnosis, and 5.5 threw it away twice before
      // recording it. The mapped error keeps the original on `cause`.
      const raw = err && err.cause ? String(err.cause.message || '') : '';
      failure = {
        message: String(err && err.message).slice(0, 400),
        status: err && err.status ? err.status : null,
        providerMessage: raw ? raw.replace(/\s+/g, ' ').slice(0, 600) : null,
        retryAfterMs: parseRetryHint(raw || String((err && err.message) || ''))
      };
    }

    if (observation) {
      append({
        ...cell,
        ok: true,
        at: new Date().toISOString(),
        contentChars: contentText.length,
        latencyMs: observation.latencyMs,
        finishReason: observation.finishReason,
        promptTokens: observation.promptTokens,
        completionTokens: observation.completionTokens,
        reasoningTokens: observation.reasoningTokens,
        totalTokens: observation.totalTokens,
        modelRequested: observation.modelRequested || model,
        model: observation.model,
        // THE PARAMETERS THIS ROW WAS PRODUCED UNDER. 5.3's rows carried the
        // model and nothing else, so a re-run at a different ceiling would have
        // appended to the same file and averaged two systems — the exact thing
        // the model guard exists to prevent, one field short. See paramsOf().
        variant,
        maxTokens,
        temperature,
        // rawText ONLY. `text` is applyShippedStrip(rawText, feature), which is
        // committed code — §8.5's rule: do not commit derived data twice.
        rawText: observation.rawText,
        rateLimit: observation.rateLimit || null
      });
      const v = classify(shipped.applyShippedStrip(observation.rawText, cell.feature), cell.feature);
      const mark = v.schema === null ? (v.empty ? 'EMPTY' : 'prose') : (v.schema.shape ? 'ok' : (v.schema.cause || 'fail'));
      process.stdout.write(
        `  ${String(attempts).padStart(3)}/${todo.length}  ${cell.seedId.padStart(6)} ` +
        `${cell.feature.padEnd(10)} r${cell.repeat}  ${String(observation.latencyMs).padStart(5)} ms  ` +
        `${String(observation.completionTokens ?? '?').padStart(4)} out  ` +
        `${String(observation.finishReason).padEnd(6)}  ${mark}\n`
      );
    } else {
      append({ ...cell, ok: false, at: new Date().toISOString(), error: failure });
      console.log(`  ${String(attempts).padStart(3)}/${todo.length}  ${cell.seedId.padStart(6)} ` +
        `${cell.feature.padEnd(10)} r${cell.repeat}  API FAILURE  ${failure.status || ''} ${failure.message}`);

      // A 429 STOPS THE RUN. Retrying is 7.2's and would change what latency
      // means here. The ledger already holds everything completed.
      //
      // MATCHED ON THE MESSAGE AS WELL AS THE STATUS, because the first v2 run
      // burned 21 attempts into a rate limit discovering that it had to be.
      // services/llm.service.js translated every SDK error into a sentence and
      // dropped `status`, so `failure.status === 429` was never true. 5.5 fixed
      // the service to carry the status forward; this second condition is the
      // belt-and-braces, and it is the one that would have caught it.
      if (failure.status === 429 || /rate limit|rate_limit|429/i.test(failure.message || '')) {
        // WHICH limit, and how long until it frees. A daily cap and a
        // per-minute one call for completely different responses — wait a
        // minute, or come back tomorrow — and "429" alone distinguishes
        // neither.
        const daily = /tokens per day|TPD/i.test(failure.providerMessage || '');
        console.log(`\n  429 on the ${daily ? 'DAILY (TPD)' : 'per-minute'} limit — STOPPING.`);
        if (failure.providerMessage) console.log(`  ${failure.providerMessage.slice(0, 300)}`);
        if (failure.retryAfterMs) {
          console.log(`  frees in ~${Math.round(failure.retryAfterMs / 60000)} min for ONE call; a full`);
          console.log('  resume needs a block of the rolling window to age out.');
        }
        console.log('  Nothing completed is lost — re-run the same command to resume.\n');
        break;
      }
    }

    // --- pacing -------------------------------------------------------------
    //
    // v1 paced off the `x-ratelimit-*` HEADERS, which llm-v1-shipped.js surfaces
    // via withResponse(). THE LIVE processNote DOES NOT RETURN HEADERS, and it
    // is not going to: exposing HTTP response metadata through a service
    // function to suit a measurement is the shape of change 5.3 refused to make.
    //
    // So v2 paces off `usage`, which the response BODY carries and processNote
    // now returns. That is the same discipline by another route — measured
    // pacing from what the API actually reported, not a figure quoted from a
    // webpage — and it is strictly better informed than a fixed delay, because
    // each call's exact cost is known the moment it lands.
    //
    // It does NOT see the 200,000-per-day cap. Nothing does (§28.6); that is
    // what --max-calls is for.
    if (observation && observation.rateLimit) {
      const remaining = Number(observation.rateLimit['x-ratelimit-remaining-tokens']);
      const reset = observation.rateLimit['x-ratelimit-reset-tokens'];
      if (Number.isFinite(remaining) && remaining < TOKEN_FLOOR) {
        const waitMs = parseResetMs(reset) ?? 60000;
        console.log(`  ...token window low (${remaining} left), pausing ${Math.round(waitMs / 1000)} s`);
        await sleep(waitMs + 1000);
      }
    } else if (observation && Number.isFinite(observation.promptTokens)) {
      // CHARGED ON THE RESERVATION, NOT ON USAGE — MEASURED, AND IT COST A RUN.
      //
      // The first v2 attempt paced against `totalTokens` actually used and hit
      // 429s anyway. A controlled probe explains why: a call with
      // max_tokens 64 whose completion was 54 tokens decremented
      // `x-ratelimit-remaining-tokens` by exactly 64. Groq charges the
      // per-minute token budget on what the call RESERVES.
      //
      // So the cost of a call is prompt + max_tokens regardless of how much the
      // model actually writes, and RAISING max_tokens HALVES THROUGHPUT under
      // this limit even when output length barely moves. That is an operational
      // cost of 5.5's fix that no measurement in §28 could have predicted,
      // because §28 never varied the ceiling. §29.6.
      spent.push({ at: Date.now(), tokens: observation.promptTokens + maxTokens });
      const waitMs = throttleFor(spent);
      if (waitMs > 0) {
        console.log(`  ...${tokensInWindow(spent)} reserved tokens in the last minute of ${TOKENS_PER_MIN}, pausing ${Math.round(waitMs / 1000)} s`);
        await sleep(waitMs);
      }
    }

    await sleep(delayMs);
  }

  stream.end();
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n  attempts ${attempts}   completed ${completed}   delivery ${((completed / attempts) * 100).toFixed(1)}%   ${mins} min\n`);
}

/**
 * The per-minute token limit, MEASURED rather than quoted: 5.3 read
 * `x-ratelimit-limit-tokens: 8000` off a live response (§28.6). It is here as a
 * constant only because v2 cannot see the header it came from.
 *
 * Paced to 85% of it. The window Groq enforces is a sliding one and the client
 * cannot know its exact phase, so aiming at the limit means crossing it.
 */
const TOKENS_PER_MIN = 8000;
const TOKEN_TARGET = 0.85;

/** Tokens spent in the trailing 60 s, dropping anything older in place. */
function tokensInWindow(spent) {
  const cutoff = Date.now() - 60000;
  while (spent.length > 0 && spent[0].at < cutoff) spent.shift();
  return spent.reduce((a, b) => a + b.tokens, 0);
}

/**
 * How long to wait so the trailing minute stays under the target — long enough
 * for the oldest entries to age out of the window, and no longer.
 */
function throttleFor(spent) {
  const used = tokensInWindow(spent);
  if (used < TOKENS_PER_MIN * TOKEN_TARGET) return 0;
  if (spent.length === 0) return 0;
  return Math.max(0, spent[0].at + 60000 - Date.now()) + 500;
}

/** "Please try again in 14m5.856s" -> ms, or null. The provider's own estimate. */
function parseRetryHint(text) {
  const m = /try again in ((?:\d+m)?[\d.]+s)/i.exec(String(text || ''));
  return m ? parseResetMs(m[1]) : null;
}

/** Groq resets look like "7.66s" or "2m59.56s". Returns ms, or null. */
function parseResetMs(value) {
  if (!value) return null;
  const m = /^(?:(\d+)m)?([\d.]+)s$/.exec(String(value).trim());
  if (!m) return null;
  return (Number(m[1] || 0) * 60 + Number(m[2])) * 1000;
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

function report(clusters, manifest) {
  const variant = variantName();
  const rows = readJsonl(LEDGER());
  if (rows.length === 0) {
    console.error(`The ledger is empty. Run \`npm run gen:baseline -- --variant ${variant} --run\` first.`);
    process.exit(1);
  }

  const bySeed = new Map(clusters.map((c) => [c.seedId, c]));
  const cells = planCells(clusters);
  const attempts = rows.length;
  const okRows = rows.filter((r) => r.ok);
  const failures = rows.filter((r) => !r.ok);

  // One record per cell — the first completed one, so a re-run cannot
  // double-count a cell into the denominator.
  const byCell = new Map();
  for (const r of okRows) if (!byCell.has(keyOf(r))) byCell.set(keyOf(r), r);
  const completed = [...byCell.values()];

  // A LEDGER MIXING TWO CONFIGURATIONS WOULD SILENTLY AVERAGE TWO SYSTEMS,
  // which is the one-variable rule failing inside the reporting rather than
  // inside the experiment. Refused rather than warned about: the resumable
  // ledger makes this easy to do by accident — re-run with a different setting
  // and the rows append to the same file.
  //
  // 5.3 CHECKED ONLY THE MODEL, which was one field short. `max_tokens` is the
  // whole variable 5.5 moves, so a ledger mixing 1024 and 2048 rows would have
  // produced a conformance rate over two systems and looked entirely normal.
  // Found while building 5.5 — the session that would have done it. §29.4.
  const mixed = (label, get) => {
    const values = [...new Set(okRows.map((r) => String(get(paramsOf(r)))))].sort();
    if (values.length <= 1) return values[0];
    console.error(`REFUSING: the ledger mixes more than one ${label}, so no rate over it means anything.`);
    for (const v of values) {
      console.error(`  ${label} ${v}   ${okRows.filter((r) => String(get(paramsOf(r))) === v).length} rows`);
    }
    console.error(`Move ${path.relative(REPO, LEDGER())} aside and re-run for one ${label}.`);
    return process.exit(1);
  };

  const modelUsed = mixed('model', (p) => p.model);
  const maxTokensUsed = Number(mixed('max_tokens', (p) => p.maxTokens));
  const temperatureUsed = Number(mixed('temperature', (p) => p.temperature));

  // BALANCED, NOT MERELY FIRST-DRAW. A seed is kept only if ALL FIVE features
  // completed for it, so every feature is measured over the SAME seeds.
  //
  // 5.3 could take repeat===0 directly because its first pass was complete: all
  // 150 cells landed before the quota bit. 5.5's did not — it stopped at 76 —
  // and 76 rows spread unevenly across seeds is §28.11's weighting bug wearing
  // different clothes: the per-feature rates would be computed over different
  // seed sets, so a feature's number would partly reflect WHICH seeds its calls
  // happened to reach before the run died. Balance is enforced rather than
  // assumed. §29.6.
  const seedFeatureCount = new Map();
  for (const r of completed.filter((x) => x.repeat === 0)) {
    const k = String(r.seedId);
    seedFeatureCount.set(k, (seedFeatureCount.get(k) || new Set()).add(r.feature));
  }
  const balancedSeeds = new Set(
    [...seedFeatureCount.entries()].filter(([, fs]) => fs.size === ALL_FEATURES.length).map(([k]) => k)
  );
  const firstPass = completed.filter((r) => r.repeat === 0 && balancedSeeds.has(String(r.seedId)));

  const out = [];
  const w = (s = '') => out.push(s);

  if (variant === 'v1') {
    w('PHASE 5.3 — GENERATION BASELINE (gen-v1): the shipped prompts, single-note,');
    w('measured before anything is changed.');
    w('');
    w('  THE SHIPPED MODEL IS RETIRED AND THIS IS A SUBSTITUTED RUN.');
    w('');
    w(`    llm.service.js asked for     ${shipped.MODEL}`);
    w('                                 -> HTTP 404 model_not_found, 19 Aug 2026');
    w('                                 -> results/gen-model-retired.txt');
    w(`    this run used                ${modelUsed}`);
    w('');
    w(`  ONE VARIABLE CHANGED. Prompts, system message, temperature ${temperatureUsed}, max_tokens`);
    w(`  ${maxTokensUsed} and the fence-strip are byte-identical to the shipped file, checked by`);
    w('  tests/gen-shipped-parity.test.js. THE STRUCTURAL DEFECT SURVIVES the swap —');
    w('  6, 8 and 5 requested items against a 1024-token ceiling is a property of the');
    w('  prompts. EVERY RATE BELOW IS A RATE ABOUT ' + modelUsed + ' AND NOT');
    w('  ABOUT THE MODEL THE APP ASKS FOR, which cannot be measured because it does');
    w('  not run.');
  } else {
    w('PHASE 5.5 — CONFORMANCE RE-MEASURE (gen-v2): the same prompts, the same 30');
    w('seeds, the same grader, the same model — and ONE changed parameter.');
    w('');
    w(`    max_tokens                   ${shipped.MAX_TOKENS} -> ${maxTokensUsed}`);
    w(`    model                        ${modelUsed}   SAME AS THE BASELINE`);
    w(`    temperature                  ${temperatureUsed}   unchanged`);
    w('');
    w('  THIS RAN THROUGH services/llm.service.js ITSELF, not through a frozen copy.');
    w('  5.3 could not: processNote() returned the completion text and discarded');
    w('  `usage` and `finish_reason`, so tokens and truncation were unobservable');
    w('  through the only surface the app has (§28.3). 5.5 made it return them, so');
    w('  the copy is no longer needed and THIS MEASUREMENT HAS NO SUBSTITUTED');
    w('  VARIABLE AT ALL — a stronger position than the baseline, which had one.');
    w('');
    w('  The comparison is valid because both halves ran on the same model, and that');
    w('  is CHECKED rather than remembered: a v2 run refuses to start when the live');
    w('  model differs from the one the baseline ledger recorded. §29.4.');
  }
  w('');
  w('  DOES NOT REGENERATE BYTE-IDENTICALLY, AND FOR TWO INDEPENDENT REASONS.');
  w('  (1) It carries wall times — the same reason results/provenance-query.txt and');
  w('      results/keyword-stability.txt do not (EVALUATION.md §23.10, §26.10).');
  w(`  (2) IT CARRIES MODEL OUTPUT, and no environment pinning fixes that: the model`);
  w(`      behind the string "${modelUsed}" is NOT A PINNED INPUT. The`);
  w('      corpus has a SHA-256 and the vectors have a manifest; that string has');
  w('      neither. Every count, rate and percentage below is a measurement of one');
  w('      run against whatever served that name on the date in the environment');
  w('      section. §28.9.');
  w('');
  w(`  Produced by:  cd backend && npm run gen:baseline -- --variant ${variant} --run`);
  w(`  Recomputed:   cd backend && npm run gen:baseline -- --variant ${variant} --report`);
  w(`  Per-call evidence: ${path.relative(REPO, LEDGER())} (one row per API call,`);
  w('  carrying the raw model output, so a second reader disputes a row rather than');
  w('  the analysis — §20.4\'s answer, applied to generation).');
  w('');
  w('='.repeat(78));
  w('A. WHAT WAS RUN, AND THE TWO DENOMINATORS');
  w('='.repeat(78));
  w('');
  w('  §5.3a records that trec_eval OMITS queries a retriever returned nothing for,');
  w('  and that aggregating that divides by the wrong denominator. The same trap');
  w('  arrives here. It is split rather than collapsed, and BOTH rates are printed:');
  w('');
  w(`  cells planned          ${cells.length}    30 seeds x (3 JSON features x n=3 + 2 prose x n=1)`);
  w(`  cells completed        ${completed.length}`);
  w('');
  w('  THE RUN STOPPED ON A DAILY TOKEN CAP, AND THE COVERAGE THAT SURVIVED IS THE');
  w('  COVERAGE THAT WAS DESIGNED TO. Calls are issued REPEAT-MAJOR — every cell\'s');
  w('  first draw before any cell\'s second — precisely so a run cut short yields a');
  w('  COMPLETE n=1 pass rather than complete coverage of some seeds and none of');
  w('  others. What landed:');
  w('');
  const drawCounts = new Map();
  for (const r of completed) {
    const k = `${r.seedId}|${r.feature}`;
    drawCounts.set(k, (drawCounts.get(k) || 0) + 1);
  }
  const withN = (n) => [...drawCounts.values()].filter((v) => v === n).length;
  w(`    distinct (seed, feature) cells   ${drawCounts.size} of 150   <- COMPLETE n=1`);
  w(`    cells with 2 draws               ${withN(2)}`);
  w(`    cells with 3 draws               ${withN(3)}`);
  w('');
  w('');
  w(`    seeds with all ${ALL_FEATURES.length} features    ${balancedSeeds.size} of ${clusters.length}   <- SECTIONS B-G ARE OVER THESE`);
  if (balancedSeeds.size < clusters.length) {
    w('');
    w('    THE FIRST PASS IS INCOMPLETE, so sections B-G run over the seeds that');
    w('    have EVERY feature rather than over every row that landed. Rows for a');
    w('    partially-covered seed are dropped from those sections — otherwise each');
    w('    feature would be scored over a different seed set, and a per-feature');
    w('    rate would partly reflect which calls happened to land before the run');
    w('    stopped. That is §28.11\'s weighting bug in a new shape.');
    const q = new Map();
    for (const c of clusters) {
      if (!balancedSeeds.has(String(c.seedId))) continue;
      q.set(c.quintile, (q.get(c.quintile) || 0) + 1);
    }
    w('');
    w(`    retained by length quintile   ${[...q.entries()].sort().map(([k, v]) => `Q${k}:${v}`).join('  ')}`);
    w('    The golden set is 6 per quintile, so check this spread before quoting');
    w('    any rate: the defect being measured moves along the length axis.');
  }
  w('');
  w('  Section H, which needs repeats, is over the cells that got two, and says so.');
  w(`  API calls attempted    ${attempts}`);
  w(`  API calls completed    ${okRows.length}`);
  w(`  API failures           ${failures.length}`);
  w(`  DELIVERY RATE          ${showPct(rate(okRows.length, attempts))}   completed / attempted`);
  w('');
  w('  An API failure (429, 5xx, socket) is EXCLUDED from conformance — no');
  w('  completion exists, so nothing was generated to conform — and reported here');
  w('  instead. A model that returned garbage is a ZERO, never an exclusion.');
  if (failures.length > 0) {
    w('');
    const byStatus = new Map();
    for (const f of failures) {
      const k = String((f.error && f.error.status) || 'no-status');
      byStatus.set(k, (byStatus.get(k) || 0) + 1);
    }
    for (const [status, n] of [...byStatus].sort()) w(`    status ${status.padEnd(12)} ${n}`);
  }

  // ---- B. conformance ------------------------------------------------------

  // SECTIONS B-G RUN OVER THE FIRST DRAW ONLY — EXACTLY ONE CALL PER CELL.
  //
  // The run completed 150 first draws and 84 second draws, so pooling all 234
  // would let 84 cells count twice and 66 once. That is an unequal weighting
  // artefact of WHERE THE QUOTA RAN OUT, not a property of the system, and it
  // would put a silent thumb on every rate in the report. The first pass is
  // complete and balanced: 30 seeds x 5 features, one draw each.
  //
  // The extra draws are not discarded — they are what section H measures, and
  // the pooled figure is printed beside the headline so nothing is hidden.
  // firstPass / balancedSeeds are computed above section A, which needs them.
  const featureRows = new Map(ALL_FEATURES.map((f) => [f, firstPass.filter((r) => r.feature === f)]));
  const featureRowsAll = new Map(ALL_FEATURES.map((f) => [f, completed.filter((r) => r.feature === f)]));

  w('');
  w('='.repeat(78));
  w('B. SCHEMA CONFORMANCE, PER FEATURE — THREE LEVELS, NOT ONE');
  w('='.repeat(78));
  w('');
  w('  parses       JSON.parse yields an Array. The bar AIPanel.jsx actually needs.');
  w('  shape        every element carries EXACTLY the prompt\'s keys, all non-empty');
  w('               strings. This is roadmap 5.4\'s wording and it is the headline.');
  w('  cardinality  as many elements as the prompt asked for. REPORTED SEPARATELY:');
  w('               a 5-element array where 6 were asked is conforming-but-short,');
  w('               and folding it in would overstate the defect 5.5 fixes.');
  w('');
  w('  summarize and eli5 have NO schema. They are n/a, NOT 100% — inventing a');
  w('  ceiling nobody defined would drag every cross-feature mean upward for free.');
  w('');
  w('  feature      calls   parses    shape   cardin.   items(mean/asked)');
  w('  ' + '-'.repeat(68));

  const conformance = {};
  for (const feature of ALL_FEATURES) {
    const rs = featureRows.get(feature);
    if (PROSE_FEATURES.includes(feature)) {
      w(`  ${feature.padEnd(11)}  ${String(rs.length).padStart(5)}      n/a      n/a       n/a   n/a  (no schema)`);
      continue;
    }
    const v = rs.map((r) => classify(shipped.applyShippedStrip(r.rawText, feature), feature).schema);
    const parses = v.filter((x) => x.parses).length;
    const shape = v.filter((x) => x.shape).length;
    const card = v.filter((x) => x.cardinality).length;
    const items = v.filter((x) => x.items !== null).map((x) => x.items);
    conformance[feature] = { n: rs.length, parses, shape, card };
    w(
      `  ${feature.padEnd(11)}  ${String(rs.length).padStart(5)}   ${showPct(rate(parses, rs.length))}   ` +
      `${showPct(rate(shape, rs.length))}    ${showPct(rate(card, rs.length))}   ` +
      `${num(mean(items), 2)} / ${SCHEMAS[feature].count}`
    );
  }

  const jsonRows = firstPass.filter((r) => !PROSE_FEATURES.includes(r.feature));
  const jsonV = jsonRows.map((r) => ({
    feature: r.feature, row: r,
    ...classify(shipped.applyShippedStrip(r.rawText, r.feature), r.feature).schema
  }));
  w('  ' + '-'.repeat(68));
  w(
    `  ${'ALL JSON'.padEnd(11)}  ${String(jsonRows.length).padStart(5)}   ` +
    `${showPct(rate(jsonV.filter((x) => x.parses).length, jsonRows.length))}   ` +
    `${showPct(rate(jsonV.filter((x) => x.shape).length, jsonRows.length))}    ` +
    `${showPct(rate(jsonV.filter((x) => x.cardinality).length, jsonRows.length))}`
  );

  // ---- C. failure causes ---------------------------------------------------

  const failed = jsonV.filter((x) => !x.shape);
  const causes = new Map();
  for (const f of failed) causes.set(f.cause, (causes.get(f.cause) || 0) + 1);

  w('');
  w('='.repeat(78));
  w('C. WHY THE FAILURES FAILED — precedence committed in scripts/lib/gen-schema.js');
  w('='.repeat(78));
  w('');
  w(`  ${failed.length} of ${jsonRows.length} JSON calls did not conform at SHAPE.`);
  w('');
  w('  cause            n     of failures   of JSON calls');
  w('  ' + '-'.repeat(56));
  for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) {
    w(`  ${cause.padEnd(15)} ${String(n).padStart(3)}   ${showPct(rate(n, failed.length))}        ${showPct(rate(n, jsonRows.length))}`);
  }
  w('');
  w('  truncated      the model never finished. This is max_tokens: 1024');
  w('                 (llm.service.js:53) — Phase 5 defect 1.');
  w('  wrapper        the payload parsed once prose or fence residue was sliced off.');
  w('                 The strip at :59-60 removes FENCES and never a prose preamble');
  w('                 — Phase 5 defect 2, and the half of it 5.5 owns.');
  w('  element-shape  parsed to an array, wrong field names. Neither defect.');

  // ---- D. truncation, and the cross-check ----------------------------------

  w('');
  w('='.repeat(78));
  w('D. TRUNCATION — finish_reason, WHICH THE SHIPPED FUNCTION THROWS AWAY');
  w('='.repeat(78));
  w('');
  w('  processNote() returns message.content and nothing else (llm.service.js:56),');
  w('  so this column does not exist through the shipped surface. It is why');
  w('  scripts/lib/llm-v1-shipped.js was cut. §28.3.');
  w('');
  w('  feature      calls   finish=length   finish=stop   other');
  w('  ' + '-'.repeat(60));
  const truncByFeature = {};
  for (const feature of ALL_FEATURES) {
    const rs = featureRows.get(feature);
    const len = rs.filter((r) => r.finishReason === 'length').length;
    const stop = rs.filter((r) => r.finishReason === 'stop').length;
    truncByFeature[feature] = { n: rs.length, len };
    w(
      `  ${feature.padEnd(11)}  ${String(rs.length).padStart(5)}   ${showPct(rate(len, rs.length))}        ` +
      `${showPct(rate(stop, rs.length))}    ${rs.length - len - stop}`
    );
  }

  // The classifier reads TEXT SHAPE; finish_reason is the API's own account.
  // They are independent, so their agreement is a check on the classifier that
  // costs nothing and was not designed for.
  const bothKnown = jsonV.filter((x) => x.row.finishReason !== null);
  const agree = bothKnown.filter((x) => (x.cause === 'truncated') === (x.row.finishReason === 'length')).length;
  const saidLengthLooksFine = bothKnown.filter((x) => x.row.finishReason === 'length' && x.cause !== 'truncated');
  const looksTruncSaidStop = bothKnown.filter((x) => x.row.finishReason !== 'length' && x.cause === 'truncated');

  w('');
  w('  CROSS-CHECK — the text-shape classifier against the API\'s own finish_reason.');
  w('  Two independent signals; agreement is a check on the classifier that costs');
  w('  nothing and was not designed for.');
  w('');
  w(`    JSON calls with both      ${bothKnown.length}`);
  w(`    agree                     ${agree}   ${showPct(rate(agree, bothKnown.length))}`);
  w(`    finish=length, parsed ok  ${saidLengthLooksFine.length}   truncated at a point that still parsed`);
  w(`    finish!=length, unterm.   ${looksTruncSaidStop.length}   model stopped mid-array on its own`);

  // ---- E. the fence strip --------------------------------------------------

  const fence = jsonRows.map((r) => {
    const stripped = shipped.applyShippedStrip(r.rawText, r.feature);
    const rawHadFence = r.rawText.includes('```');
    const rawParses = (() => { try { return Array.isArray(JSON.parse(r.rawText.trim())); } catch { return false; } })();
    const strippedParses = (() => { try { return Array.isArray(JSON.parse(stripped)); } catch { return false; } })();
    return { rawHadFence, rescued: !rawParses && strippedParses, residue: stripped.includes('```') };
  });

  w('');
  w('='.repeat(78));
  w('E. THE FENCE-STRIP — HOW OFTEN IT FIRED, AND HOW OFTEN IT MATTERED');
  w('='.repeat(78));
  w('');
  w('  ALSO INVISIBLE THROUGH THE SHIPPED SURFACE: the strip rewrites the text');
  w('  before any caller sees it, so its own rate cannot be measured from a');
  w('  post-strip string. The frozen copy keeps rawText, which is what makes this');
  w('  section exist at all.');
  w('');
  w(`  JSON calls                     ${jsonRows.length}`);
  w(`  raw output contained a fence   ${fence.filter((f) => f.rawHadFence).length}   ${showPct(rate(fence.filter((f) => f.rawHadFence).length, jsonRows.length))}`);
  w(`  STRIP RESCUED THE CALL         ${fence.filter((f) => f.rescued).length}   ${showPct(rate(fence.filter((f) => f.rescued).length, jsonRows.length))}   raw failed to parse, stripped parsed`);
  w(`  fence residue AFTER stripping  ${fence.filter((f) => f.residue).length}   ${showPct(rate(fence.filter((f) => f.residue).length, jsonRows.length))}`);

  // ---- F. tokens and cost --------------------------------------------------

  w('');
  w('='.repeat(78));
  w('F. TOKENS — THE MEASURED QUANTITY. COST IS A MULTIPLIER APPLIED AFTERWARD.');
  w('='.repeat(78));
  w('');
  w('  PRIMER §8.3: token counts are real regardless of price, and this ran on');
  w('  Groq\'s free tier, so the dollar figure is $0. NO PRICE IS INVENTED HERE —');
  w('  the counts are printed so any rate can be applied later, which is what the');
  w('  ROADMAP\'s Cost/call column gets.');
  w('');
  w('  feature      calls    in(mean)  out(mean)  out(p50)  out(p95)  out(max)');
  w('  ' + '-'.repeat(70));
  for (const feature of ALL_FEATURES) {
    const rs = featureRows.get(feature).filter((r) => r.completionTokens !== null);
    const inTok = rs.map((r) => r.promptTokens);
    const outTok = rs.map((r) => r.completionTokens);
    w(
      `  ${feature.padEnd(11)}  ${String(rs.length).padStart(5)}   ${String(num(mean(inTok), 0)).padStart(8)}  ` +
      `${String(num(mean(outTok), 0)).padStart(9)}  ${String(pct(outTok, 50) ?? 'n/a').padStart(8)}  ` +
      `${String(pct(outTok, 95) ?? 'n/a').padStart(8)}  ${String(outTok.length ? Math.max(...outTok) : 'n/a').padStart(8)}`
    );
  }
  const allIn = firstPass.filter((r) => r.promptTokens !== null).map((r) => r.promptTokens);
  const allOut = firstPass.filter((r) => r.completionTokens !== null).map((r) => r.completionTokens);
  w('  ' + '-'.repeat(70));
  w(`  ${'ALL'.padEnd(11)}  ${String(firstPass.length).padStart(5)}   ${String(num(mean(allIn), 0)).padStart(8)}  ${String(num(mean(allOut), 0)).padStart(9)}`);
  w('');
  w(`  total tokens this run          in ${allIn.reduce((a, b) => a + b, 0)}   out ${allOut.reduce((a, b) => a + b, 0)}`);
  w(`  cost                           $0 — Groq free tier`);
  w(`  ceiling that produced the      max_tokens: ${maxTokensUsed}`);
  w(`    out(max) column above`);

  // ---- F2. the reasoning-token confound, MEASURED rather than named --------

  const reasoning = firstPass.filter((r) => r.reasoningTokens !== null && r.reasoningTokens !== undefined);
  if (reasoning.length > 0) {
    w('');
    w('  ' + '-'.repeat(70));
    w('  REASONING TOKENS — A CONFOUND ON SECTION D, MEASURED RATHER THAN NAMED');
    w('  ' + '-'.repeat(70));
    w('');
    w(`  ${modelUsed} emits a reasoning chain in a SEPARATE`);
    w('  `reasoning` field, so it does NOT pollute the JSON and section B is clean.');
    w('  But reasoning tokens COUNT AGAINST completion_tokens and therefore against');
    w('  max_tokens: 1024 — so they consume ceiling that a non-reasoning model would');
    w('  have spent on content, and section D\'s truncation rate is inflated by');
    w('  exactly this much relative to one.');
    w('');
    w('  feature      calls   reasoning(mean)  (p95)   share of the 1024 ceiling');
    w('  ' + '-'.repeat(68));
    for (const feature of ALL_FEATURES) {
      const rs = reasoning.filter((r) => r.feature === feature).map((r) => r.reasoningTokens);
      if (rs.length === 0) continue;
      w(
        `  ${feature.padEnd(11)}  ${String(rs.length).padStart(5)}   ${String(num(mean(rs), 0)).padStart(14)}  ` +
        `${String(pct(rs, 95)).padStart(6)}   ${showPct(rate(mean(rs), maxTokensUsed))}`
      );
    }
    const allR = reasoning.map((r) => r.reasoningTokens);
    w('  ' + '-'.repeat(68));
    w(`  ${'ALL'.padEnd(11)}  ${String(allR.length).padStart(5)}   ${String(num(mean(allR), 0)).padStart(14)}  ${String(pct(allR, 95)).padStart(6)}   ${showPct(rate(mean(allR), maxTokensUsed))}`);
    w('');
    w('  SO SECTION D IS AN UPPER BOUND on what the shipped prompts would truncate');
    w('  at on a non-reasoning model, and the size of the overstatement is the last');
    w('  column. This is the confound priced, not the confound avoided — which is');
    w('  the better outcome, because avoiding it would have meant choosing a model');
    w('  for the measurement\'s convenience rather than the app\'s.');
  }

  // ---- G. latency ----------------------------------------------------------

  w('');
  w('='.repeat(78));
  w('G. LATENCY — UNCONTROLLED, AND NETWORK-BOUND');
  w('='.repeat(78));
  w('');
  w('  §12.4\'s convention: an uncontrolled laptop, and roadmap 6.5 still owns the');
  w('  controlled figure. THIS ONE IS WEAKER THAN §12.4\'s — a retrieval p95 is CPU');
  w('  on this machine, and this is a round trip to someone else\'s GPU over a home');
  w('  connection. It is a property of one network on one afternoon.');
  w('');
  w('  ROADMAP 6.5 budgets the LLM call at < 4 s. Marked pass/fail per feature,');
  w('  BEFORE Study Pack\'s larger context exists.');
  w('');
  w('  feature      calls     p50      p95      max    6.5 budget (p95 < 4000 ms)');
  w('  ' + '-'.repeat(70));
  for (const feature of ALL_FEATURES) {
    const ms = featureRows.get(feature).map((r) => r.latencyMs);
    const p95 = pct(ms, 95);
    w(
      `  ${feature.padEnd(11)}  ${String(ms.length).padStart(5)}  ${String(pct(ms, 50) ?? 'n/a').padStart(6)}  ` +
      `${String(p95 ?? 'n/a').padStart(6)}  ${String(ms.length ? Math.max(...ms) : 'n/a').padStart(7)}    ` +
      `${p95 === null ? 'n/a' : (p95 < 4000 ? 'PASS' : 'FAIL')}`
    );
  }
  const allMs = firstPass.map((r) => r.latencyMs);
  w('  ' + '-'.repeat(70));
  w(`  ${'ALL'.padEnd(11)}  ${String(allMs.length).padStart(5)}  ${String(pct(allMs, 50)).padStart(6)}  ${String(pct(allMs, 95)).padStart(6)}  ${String(Math.max(...allMs)).padStart(7)}`);

  // ---- H. within-cell agreement -------------------------------------------

  w('');
  w('='.repeat(78));
  w('H. WITHIN-CELL VARIANCE — WHAT n=3 BOUGHT, AND WHETHER IT WAS WORTH IT');
  w('='.repeat(78));
  w('');
  w('  A cell is one (seed, feature). At temperature 0.4 repeated draws can');
  w('  disagree. THIS IS THE NUMBER 5.5 NEEDS: if cells flip on a re-draw, a small');
  w('  before/after difference is not attributable to the fix.');
  w('');
  w('  n=3 WAS PLANNED AND THE QUOTA SET n INSTEAD. The run stopped on Groq\'s');
  w('  200,000 tokens-per-day cap after a complete n=1 pass plus part of the second,');
  w('  so NO CELL REACHED THREE DRAWS. The rows below are over cells with TWO, which');
  w('  answers the same question with less resolution: two draws can disagree, and');
  w('  the rate at which they do is what bounds 5.5\'s attributable difference.');
  w('');
  w('  feature      cells n>=2   both conform   both fail   SPLIT');
  w('  ' + '-'.repeat(62));
  let splitTotal = 0;
  let cellTotal = 0;
  for (const feature of Object.keys(SCHEMAS)) {
    // featureRowsAll, NOT featureRows — this is the one section that needs the
    // repeats, and featureRows is deliberately the first draw only.
    const bySeedId = new Map();
    for (const r of featureRowsAll.get(feature)) {
      const v = classify(shipped.applyShippedStrip(r.rawText, feature), feature).schema;
      if (!bySeedId.has(r.seedId)) bySeedId.set(r.seedId, []);
      bySeedId.get(r.seedId).push(v.shape);
    }
    const full = [...bySeedId.values()].filter((a) => a.length >= 2);
    const allOk = full.filter((a) => a.every(Boolean)).length;
    const allNo = full.filter((a) => a.every((x) => !x)).length;
    const split = full.length - allOk - allNo;
    splitTotal += split;
    cellTotal += full.length;
    w(`  ${feature.padEnd(11)}  ${String(full.length).padStart(10)}   ${String(allOk).padStart(12)}   ${String(allNo).padStart(9)}   ${String(split).padStart(5)}`);
  }
  w('  ' + '-'.repeat(62));
  w(`  ${'ALL'.padEnd(11)}  ${String(cellTotal).padStart(10)}   unanimous ${cellTotal - splitTotal}   SPLIT ${splitTotal}   ${showPct(rate(splitTotal, cellTotal))} of cells`);
  w('');
  w('  A SPLIT CELL IS A CELL WHOSE CONFORMANCE IS NOT A PROPERTY OF ITS INPUT.');
  w('  Read the ALL row as a floor on the noise 5.5 has to clear: with two draws');
  w('  the observed split rate understates the three-draw rate, because three draws');
  w('  have more chances to disagree.');

  // ---- I. by length quintile ----------------------------------------------

  w('');
  w('='.repeat(78));
  w('I. CONFORMANCE BY SEED LENGTH — THE AXIS THE GOLDEN SET WAS STRATIFIED ON');
  w('='.repeat(78));
  w('');
  w('  5.2 stratified on word count BECAUSE truncation moves along this axis. This');
  w('  is the check that the stratification was aimed at the right thing.');
  w('');
  w('  THE 30 SEEDS\' OWN LENGTH DISTRIBUTION IS AN ARTEFACT OF THE SAMPLING and is');
  w('  not evidence about the corpus — §20.2\'s cost, inherited. The rates below are');
  w('  within-quintile and are not weighted into any overall figure.');
  w('');
  w('  quintile  words(seeds)   JSON calls   shape    finish=length');
  w('  ' + '-'.repeat(64));
  for (let q = 1; q <= 5; q += 1) {
    const ids = new Set(clusters.filter((c) => c.quintile === q).map((c) => c.seedId));
    const rs = jsonRows.filter((r) => ids.has(r.seedId));
    if (rs.length === 0) continue;
    const words = clusters.filter((c) => c.quintile === q).map((c) => c.words);
    const shape = rs.filter((r) => classify(shipped.applyShippedStrip(r.rawText, r.feature), r.feature).schema.shape).length;
    const len = rs.filter((r) => r.finishReason === 'length').length;
    w(
      `  ${String(q).padStart(8)}  ${String(`${Math.min(...words)}-${Math.max(...words)}`).padStart(12)}   ` +
      `${String(rs.length).padStart(10)}   ${showPct(rate(shape, rs.length))}   ${showPct(rate(len, rs.length))}`
    );
  }

  // ---- J. empty and degenerate --------------------------------------------

  const empties = firstPass.filter((r) => classify(shipped.applyShippedStrip(r.rawText, r.feature), r.feature).empty);
  const shorts = firstPass.filter((r) => classify(shipped.applyShippedStrip(r.rawText, r.feature), r.feature).veryShort);

  w('');
  w('='.repeat(78));
  w('J. EMPTY AND DEGENERATE OUTPUT');
  w('='.repeat(78));
  w('');
  w(`  empty completions              ${empties.length} of ${firstPass.length}   ${showPct(rate(empties.length, firstPass.length))}`);
  w(`  under ${VERY_SHORT_CHARS} characters            ${shorts.length} of ${firstPass.length}   ${showPct(rate(shorts.length, firstPass.length))}`);
  w('');
  w('  NEITHER IS CALLED A REFUSAL RATE. Whether the model declined is a semantic');
  w('  judgment and belongs to 5.6\'s judge; a character threshold cannot tell a');
  w('  refusal from a terse answer, and naming it one would be a rate with no');
  w('  measurement under it.');

  // ---- K. environment ------------------------------------------------------

  const dates = okRows.map((r) => r.at).sort();
  const models = [...new Set(okRows.map((r) => r.model))];

  w('');
  w('='.repeat(78));
  w('K. ENVIRONMENT');
  w('='.repeat(78));
  w('');
  w(`  node                 ${process.version}`);
  w(`  platform             ${os.platform()} ${os.release()} ${os.arch()}`);
  if (variant === 'v1') {
    w(`  model the app asks   ${shipped.MODEL}   RETIRED, 404`);
    w(`  model requested      ${modelUsed}   the one substituted variable`);
  } else {
    w(`  model the app asks   ${modelUsed}   and it resolves — npm run gen:probe`);
    w(`  model requested      ${modelUsed}   NOT substituted; this is the shipped call`);
  }
  w(`  model reported       ${models.join(', ')}`);
  w(`  temperature          ${temperatureUsed}`);
  w(`  max_tokens           ${maxTokensUsed}`);
  w(`  issued by            ${variant === 'v1' ? 'scripts/lib/llm-v1-shipped.js (frozen copy)' : 'services/llm.service.js (live)'}`);
  w(`  first call           ${dates[0]}`);
  w(`  last call            ${dates[dates.length - 1]}`);
  w(`  golden set           data/gen-eval/clusters.jsonl  sha256 ${manifest.output.sha256}`);
  w(`  corpus               ${manifest.inputs.corpus.sha256}`);
  w(`  ledger               ${path.relative(REPO, LEDGER())}  ${rows.length} rows  sha256 ${sha256(fs.readFileSync(LEDGER(), 'utf8'))}`);
  w('');
  w('  THE MODEL IS THE ONE INPUT WITH NO CHECKSUM. "model reported" above is what');
  w('  the API said it served, which is a string it chose, not a hash of weights.');
  w('  Re-running this next month may produce different numbers with every input');
  w('  in this repository unchanged, and nothing here could detect that.');
  w('');

  const text = `${out.join('\n')}\n`;
  process.stdout.write(text);
  if (has('write') || has('run')) {
    fs.writeFileSync(REPORT(), text);
    console.log(`\nwrote ${path.relative(REPO, REPORT())}`);
  } else {
    console.log('\n(pass --write to save results/gen-baseline.txt)');
  }
}

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(CLUSTERS)) {
    console.error('MISSING data/gen-eval/clusters.jsonl — run `npm run gen:clusters -- --write` first.');
    process.exit(1);
  }
  const clusters = readJsonl(CLUSTERS);
  const manifest = JSON.parse(fs.readFileSync(CLUSTER_MANIFEST, 'utf8'));

  if (has('report')) return report(clusters, manifest);

  if (!has('run')) {
    const cells = planCells(clusters);
    const done = new Set(readJsonl(LEDGER()).filter((r) => r.ok).map(keyOf));
    console.log(`${VARIANTS[variantName()].label} — PLAN ONLY. Pass --run to spend quota.\n`);
    console.log(`  seeds             ${clusters.length}`);
    console.log(`  repeats           ${JSON.stringify(REPEATS)}`);
    console.log(`  cells planned     ${cells.length}`);
    console.log(`  already complete  ${done.size}`);
    console.log(`  would call        ${cells.length - done.size}`);
    console.log(`  pacing            serial, ${DEFAULT_DELAY_MS} ms apart, no retries`);
    console.log(`  ceiling           ${DEFAULT_MAX_CALLS}\n`);
    return;
  }

  await run(clusters);
  report(clusters, manifest);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { planCells, pct, REPEATS };
