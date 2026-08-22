#!/usr/bin/env node
'use strict';

/**
 * run-judge-eval.js — Phase 5.6. THE JUDGE RUNNER.
 *
 *   npm run judge:run                 the plan. Prices the run and calls nothing.
 *   npm run judge:run -- --run        spends quota.
 *   npm run judge:run -- --run --take N     buy a prefix
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT SPENDS QUOTA. `npm run eval:judge` DOES NOT.
 * ---------------------------------------------------------------------------
 *
 * Same split as 5.4's, for the same reason: every figure the report prints is
 * computable over a committed ledger with no new API call, so the runner and
 * the reporter are two commands rather than two flags on one. §32's refinement
 * of §17.1 holds — the generation RUNNER needs groq-sdk, a network and a key;
 * the generation REPORTER needs none of them and reads only results/.
 *
 * ---------------------------------------------------------------------------
 * THE JUDGE IS NOT THE MODEL BEING JUDGED
 * ---------------------------------------------------------------------------
 *
 * gen-v5 ran on openai/gpt-oss-120b. This runs qwen/qwen3.6-27b — a different
 * vendor and a different family. ROADMAP 5.6 requires it and self-preference is
 * the reason; 5.0's decision log reserved this model for the purpose when it
 * picked the app's.
 *
 * THE RUN REFUSES TO START IF THAT SEPARATION IS NOT TRUE. §29.4 mechanised
 * "same model" for the baseline comparison because a sentence in a document
 * cannot stop a run; this is the mirror image — DIFFERENT model, enforced
 * against the ledger the items came from rather than against a constant, so
 * pointing JUDGE_MODEL at gpt-oss-120b stops the run instead of quietly
 * producing a self-graded number.
 *
 * ---------------------------------------------------------------------------
 * A SECOND MODEL STRING, WHICH IS A COST AND IS NAMED
 * ---------------------------------------------------------------------------
 *
 * §28.9 calls the model "the one input with no checksum" and gen-v5 avoided a
 * second hardcoded one by importing MODEL from llm.service.js. That is not
 * available here: the judge is by construction a different model from the app's,
 * so JUDGE_MODEL below is the repository's second model string and `gen:probe`
 * does not cover it.
 *
 * WHAT COVERS IT INSTEAD: the run resolves the judge against models.list()
 * before its first completion and exits non-zero if it has been retired — the
 * same check gen:probe makes, at the only moment it matters, and it costs no
 * quota because models.list() consumes no completion tokens. A retired judge is
 * loud. A judge silently swapped behind a name that still resolves is not, and
 * nothing here can see that (§29.5's "the one failure mode gen:probe cannot
 * see"); the ledger records the model the API ECHOES so at least the two can be
 * compared later.
 *
 * ---------------------------------------------------------------------------
 * reasoning_effort: 'none' — MEASURED, NOT ASSUMED, AND IT CHANGED THE DESIGN
 * ---------------------------------------------------------------------------
 *
 * qwen/qwen3.6-27b emits its reasoning INLINE in the message content, inside
 * <think> blocks, and reports completion_tokens_details.reasoning_tokens as
 * undefined — so the accounting field gen-v5 relies on is blind to it. Probed
 * on two real items before any of this was written:
 *
 *   think, max_tokens 1024      completion 1024 / 924   1 of 2 TRUNCATED
 *   reasoning_effort 'none'     completion   14 /  11   2 of 2 stop
 *
 * Same verdict both ways on both items, at a third of the cost and with no
 * truncation. Two observations is an existence proof and not a rate (§30.8),
 * so this is not a claim that the configurations agree in general — it is a
 * claim that the cheap one answered, and the HUMAN LABELS are what will say
 * whether it answered well. If kappa comes back poor, enabling reasoning is
 * the first variable to move, and it is a one-variable change.
 *
 * ---------------------------------------------------------------------------
 * PACING, AND WHY THE TWO LIMITS ARE PRICED SEPARATELY
 * ---------------------------------------------------------------------------
 *
 *   per-minute  charged on the RESERVATION, prompt + max_tokens (§29.6, probe)
 *   daily       charged on ACTUAL usage                          (§30.1)
 *
 * §32.2 established that the ratio between them is a property of the FEATURE
 * rather than of the API — 0.40 for single-note calls, 0.94 for study packs —
 * and that 5.4 stopped at 9 of 30 seeds for inheriting the wrong one. So
 * ACTUAL_TOKENS_PER_CALL below is neither: it is measured on THIS judge, on
 * THIS rubric, and the measured ratio is 0.77. See the constant for how the
 * first version of it was wrong anyway, and what caught it.
 *
 * The throttle takes the next call's reservation as an argument and runs
 * BEFORE the call, and a TPM 429 is slept off and retried while a TPD 429
 * stops the run — both of them §32.8's fixes, carried over deliberately rather
 * than rewritten.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Groq = require('groq-sdk');
const judgeMetrics = require('./lib/judge-metrics');
const { RUBRIC, buildUserMessage, parseVerdict } = require('./lib/judge-rubric');
const studyPackMetrics = require('./lib/studypack-metrics');

const REPO = path.resolve(__dirname, '..', '..');
const GEN_LEDGER = path.join(REPO, 'results', 'gen-v5.calls.jsonl');
const SET = path.join(REPO, 'results', 'gen-judge-set.jsonl');
const LEDGER = path.join(REPO, 'results', 'gen-judge.calls.jsonl');
const HUMAN = path.join(REPO, 'results', 'gen-judge-human.jsonl');

/** The judge. MUST differ from the model whose output it grades. */
const JUDGE_MODEL = 'qwen/qwen3.6-27b';
const JUDGE_TEMPERATURE = 0;
const JUDGE_MAX_TOKENS = 128;
const JUDGE_REASONING_EFFORT = 'none';

/**
 * temperature 0 because the judge is an INSTRUMENT, not a sample.
 *
 * gen-v5 ran at 0.4 and §32.10 records the consequence — no noise floor under
 * any of its figures. That is a property of the items being graded and this
 * phase does not fix it. What it can do is stop ADDING to it: a judge at 0
 * contributes as little variance of its own as the provider allows, so a
 * disagreement between two judged runs is about the items rather than about
 * the grader. It does not make the judge deterministic — batching on the
 * provider's side can still move a logit — and nothing here claims it does.
 */

const TOKENS_PER_MIN = 8000;
const DEFAULT_DELAY_MS = 400;
const MAX_TPM_PAUSES = 8;
const TPM_PAUSE_MARGIN_MS = 2000;
const DEFAULT_MAX_CALLS = 700;
const DAILY_CAP = 200000;

/**
 * Mean ACTUAL tokens per judge call. NOT inherited from §30.1's 0.40 or §32.2's
 * 0.94 — see the header for why the ratio is a property of the feature.
 *
 * 557, RE-DERIVED FROM THE COMPLETE 644-CALL LEDGER (21 Aug 2026): mean 557.2,
 * sd 85.3, range 430-914, ratio actual/reserved 0.782. This is now a measured
 * mean rather than an estimate, and it is the figure to price a future judge
 * run with.
 *
 * IT WAS NOT RE-DERIVED FROM ANY OF THE FOUR PARTIAL LEDGERS along the way (48,
 * 248, 382, 504 calls), although the plan output reported the running figure at
 * each stop so a stale constant could not mislead anyone. §32.2's rule: fitting
 * a constant to a partial stratified set is the same mistake at a smaller scale.
 *
 * The previous value was 522, from the first six real calls on this rubric.
 * IT REPLACES 445, AND THE CORRECTION IS §32.2's MISTAKE CAUGHT EARLY RATHER
 * THAN AVOIDED. 445 came from six probe calls made while characterising the
 * judge model — at 389-534 prompt tokens — and the rubric those probes carried
 * was SHORTER than the one that shipped an hour later. So it was a constant
 * fitted on a different population, which is exactly what
 * ACTUAL_TOKENS_PER_CALL = 2195 was at 5.4: drawn from a five-note cluster and
 * spent on nine-note ones, 46% low, and the run it priced stopped early because
 * of it.
 *
 * The difference is that this one was caught by the first six calls of the run
 * it prices rather than by the post-mortem, because the runner reports actual
 * against reserved on every stop. That is the ONLY reason it cost nothing.
 *
 * STILL RE-DERIVED FROM THE COMPLETE LEDGER AT THE END, and not from a larger
 * partial one: §32.2 records that fitting a constant to a partial stratified set
 * is the same mistake at a smaller scale, and 5.4's noticed list set that rule
 * before it had to be obeyed twice.
 */
const ACTUAL_TOKENS_PER_CALL = 557;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (name) => process.argv.includes(`--${name}`);
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i === process.argv.length - 1 ? fallback : process.argv[i + 1];
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** Resolve a pair row into the passage and claim that will be sent. */
function resolvePair(pair, rowsBySeed) {
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
        passageText: passage.text,
        passageNoteId: passage.noteId
      };
    }
    seen += 1;
  }
  return null;
}

function load() {
  const pairs = readJsonl(SET);
  if (pairs.length === 0) {
    console.error('No pair set. Build it first:  npm run judge:set -- --write');
    process.exit(1);
  }
  const genRows = readJsonl(GEN_LEDGER).filter((r) => r.ok === true);
  const rowsBySeed = new Map(genRows.map((r) => [String(r.seedId), r]));

  // THE SEPARATION IS ENFORCED AGAINST THE LEDGER, NOT AGAINST A CONSTANT.
  const judged = [...new Set(genRows.map((r) => r.model).filter(Boolean))];
  if (judged.includes(JUDGE_MODEL)) {
    console.error(`REFUSING: the judge (${JUDGE_MODEL}) is one of the models that produced the`);
    console.error(`items it would grade (${judged.join(', ')}). ROADMAP 5.6 requires them to differ.`);
    process.exit(1);
  }
  return { pairs, rowsBySeed, judged };
}

function estimateReservation(resolved) {
  // The same shape the study-pack estimator uses, per span, at the tighter
  // divisor §32.3 derived (4.333) rather than the shipped 4.5 — this is a
  // PACING estimate for the per-minute gate, not the shipped context budget,
  // so using the corrected number here changes no shipped behaviour and
  // invalidates no committed artifact. The open question stays open.
  const perSpan = (s) => Math.ceil(String(s || '').length / 4.333);
  const prompt = 60 + perSpan(RUBRIC) + perSpan(resolved.passageTitle) +
    perSpan(resolved.passageText) + perSpan(resolved.claim);
  return prompt + JUDGE_MAX_TOKENS;
}

function tokensInWindow(spent) {
  const cutoff = Date.now() - 60000;
  return spent.filter((s) => s.at >= cutoff).reduce((a, s) => a + s.tokens, 0);
}

/** §32.8's fix, carried over: the gate is `used_in_window + requested <= limit`. */
function throttleFor(spent, reservation = 0) {
  const inWindow = tokensInWindow(spent);
  if (inWindow + reservation <= TOKENS_PER_MIN) return 0;

  const cutoff = Date.now() - 60000;
  const live = spent.filter((s) => s.at >= cutoff);
  const mustFree = inWindow + reservation - TOKENS_PER_MIN;

  let freed = 0;
  for (const s of live) {
    freed += s.tokens;
    if (freed >= mustFree) return Math.max(0, s.at + 60000 - Date.now()) + 1000;
  }
  return live.length ? Math.max(0, live[live.length - 1].at + 60000 - Date.now()) + 1000 : 0;
}

function parseRetryHint(text) {
  const m = /try again in ([0-9]+)m([0-9.]+)s/i.exec(text) || /try again in ([0-9.]+)s/i.exec(text);
  if (!m) return null;
  return m.length === 3 ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : Number(m[1]) * 1000;
}

function plan({ pairs, rowsBySeed, judged }) {
  const done = new Set(readJsonl(LEDGER).filter((r) => r.ok).map((r) => r.pairId));
  const todo = pairs.filter((p) => !done.has(p.pairId));

  let reserved = 0;
  let resolvable = 0;
  for (const p of todo) {
    const r = resolvePair(p, rowsBySeed);
    if (!r) continue;
    resolvable += 1;
    reserved += estimateReservation(r);
  }
  const actual = todo.length * ACTUAL_TOKENS_PER_CALL;
  const humanTodo = todo.filter((p) => p.humanLabelled).length;

  console.log('PHASE 5.6 — JUDGE PLAN. Nothing is called.\n');
  console.log(`  judge              ${JUDGE_MODEL}`);
  console.log(`  judged model(s)    ${judged.join(', ')}   <- MUST differ, and does`);
  console.log(`  temperature        ${JUDGE_TEMPERATURE}   an instrument, not a sample`);
  console.log(`  max_tokens         ${JUDGE_MAX_TOKENS}   derived: probes wrote 11-14 tokens`);
  console.log(`  reasoning_effort   ${JUDGE_REASONING_EFFORT}   measured: 3x cheaper, no truncation`);
  console.log('');
  console.log(`  pairs total        ${pairs.length}   322 items x 2 conditions`);
  console.log(`  already judged     ${done.size}`);
  console.log(`  to call now        ${todo.length}   (${resolvable} resolve against the gen-v5 ledger)`);
  console.log(`  of those, human-labelled  ${humanTodo}   these carry the kappa`);
  console.log('');
  console.log('  COST — TWO FIGURES, BECAUSE THE TWO LIMITS CHARGE DIFFERENTLY (§30.1):');
  console.log('');
  console.log(`    RESERVED  ${String(reserved).padStart(7)} tokens   prompt + max_tokens per call.`);
  console.log('                               What the PER-MINUTE gate charges.');
  console.log(`    ACTUAL    ${String(actual).padStart(7)} tokens   ~${ACTUAL_TOKENS_PER_CALL}/call, MEASURED on this rubric`);
  console.log('                               What the DAILY cap charges.');
  console.log('');
  console.log(`    daily cap ${DAILY_CAP} per ORGANISATION, refilling at 2.3148 tokens/s.`);
  console.log(`    the actual figure is ${((actual / DAILY_CAP) * 100).toFixed(0)}% of a day; the reserved one is ` +
    `${((reserved / DAILY_CAP) * 100).toFixed(0)}%.`);
  if (actual > DAILY_CAP) {
    console.log(`\n    THIS RUN CANNOT FIT IN ONE DAY even priced on actual tokens —`);
    console.log(`    ~${(actual / (2.3148 * 3600)).toFixed(0)} hours of refill. It is a MULTI-SESSION run by`);
    console.log('    construction, which is why the emission order makes a prefix a sample.');
  }
  console.log('');
  const seen = readJsonl(LEDGER).filter((r) => r.ok && Number.isFinite(r.totalTokens));
  if (seen.length) {
    const mean = Math.round(seen.reduce((a2, r) => a2 + r.totalTokens, 0) / seen.length);
    const res = seen.reduce((a2, r) => a2 + (r.reservationTokens || 0), 0);
    console.log(`    MEASURED SO FAR on this ledger: ${mean} actual/call over ${seen.length} calls, ` +
      `ratio ${res ? (seen.reduce((a2, r) => a2 + r.totalTokens, 0) / res).toFixed(2) : 'n/a'}.`);
    console.log(`    The constant above is ${ACTUAL_TOKENS_PER_CALL}. If these diverge, the constant is stale —`);
    console.log('    it is re-derived from the COMPLETE ledger, never from a partial one (§32.2).');
  } else {
    console.log(`    ACTUAL_TOKENS_PER_CALL is measured on THIS judge and THIS rubric, not`);
    console.log('    borrowed from another feature (§30.1 measured 0.40 for single-note calls,');
    console.log('    §32.2 measured 0.94 for study packs, and the ratio is a property of the');
    console.log('    FEATURE). It is re-derived once this ledger is COMPLETE.');
  }
  console.log('');
  console.log(`  pacing             serial, ${DEFAULT_DELAY_MS} ms apart, throttled BEFORE each call`);
  console.log(`                     against its own reservation, under ${TOKENS_PER_MIN}/min`);
  console.log(`  retries            TPM 429 slept off and retried (<=${MAX_TPM_PAUSES}), NOT an attempt.`);
  console.log('                     TPD 429 STOPS; the ledger resumes it');
  console.log('');
  console.log('  Label first (no quota):   npm run judge:label');
  console.log('  Check the balance:        npm run gen:quota');
  console.log('  Run it:                   npm run judge:run -- --run\n');
}

async function run(state) {
  if (!process.env.GROQ_API_KEY) {
    console.error('MISSING GROQ_API_KEY. It lives in backend/.env — see CLAUDE.md.');
    process.exit(1);
  }
  const { pairs, rowsBySeed } = state;

  const maxCalls = Number(arg('max-calls', DEFAULT_MAX_CALLS));
  const done = new Set(readJsonl(LEDGER).filter((r) => r.ok).map((r) => r.pairId));
  let todo = pairs.filter((p) => !done.has(p.pairId));

  const take = arg('take', null);
  if (take !== null) {
    const n = Number(take);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--take must be a positive integer; got "${take}"`);
      process.exit(1);
    }
    if (n < todo.length) {
      console.log(`  --take ${n}: running a PREFIX of ${todo.length} remaining pairs.`);
      todo = todo.slice(0, n);
    }
  }
  if (todo.length === 0) {
    console.log('\n  Nothing to do. Every pair has a verdict.\n');
    console.log('  Report it:   npm run eval:judge -- --write\n');
    return;
  }
  if (todo.length > maxCalls) {
    console.error(`REFUSING: ${todo.length} calls exceeds the --max-calls ceiling of ${maxCalls}.`);
    process.exit(1);
  }

  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  // A RETIRED JUDGE IS LOUD, AND THIS IS THE ONLY MOMENT IT MATTERS. Costs no
  // quota — models.list() consumes no completion tokens (§29.3).
  const reachable = (await groq.models.list()).data.map((m) => m.id);
  if (!reachable.includes(JUDGE_MODEL)) {
    console.error(`\n  ${JUDGE_MODEL} DOES NOT RESOLVE. It is not in the ${reachable.length} models this key reaches.`);
    console.error('  A third party retired the app\'s model without warning once already (§28, §29.1).');
    console.error('  Pick a judge that is not the model being judged, and record the swap.\n');
    process.exit(1);
  }

  console.log('\nPHASE 5.6 — JUDGE RUN\n');
  console.log(`  judge            ${JUDGE_MODEL}   resolves`);
  console.log(`  pairs to call    ${todo.length} of ${pairs.length}`);
  console.log(`  retries          TPM 429 retried (<=${MAX_TPM_PAUSES}, not an attempt); TPD 429 STOPS\n`);

  const stream = fs.createWriteStream(LEDGER, { flags: 'a' });
  const append = (row) => stream.write(`${JSON.stringify(row)}\n`);

  let attempts = 0;
  let completed = 0;
  let actualTokens = 0;
  let reservedTokens = 0;
  const started = Date.now();
  const spent = [];
  const tally = { 0: 0, 1: 0, 2: 0, fail: 0 };

  /**
   * THE BLINDING IS MECHANISED HERE TOO, NOT ONLY IN THE PROMPT.
   *
   * Cohen's kappa is a number about two INDEPENDENT raters, and the human
   * reads this terminal. A judge verdict printed here — even an aggregate
   * tally — is an anchor available to the rater before they label, and "I did
   * not let it influence me" is exactly the claim that cannot be checked
   * afterwards. So verdicts are WITHHELD from stdout until every pre-registered
   * hand label exists; parse failures still print, because those are a property
   * of the harness rather than of any item.
   *
   * The ledger is written in full either way. This withholds a display, not a
   * measurement.
   */
  const humanDone = new Set(readJsonl(HUMAN).map((h) => h.pairId));
  const humanWanted = pairs.filter((p) => p.humanLabelled).length;
  const showVerdicts = humanWanted > 0 && humanDone.size >= humanWanted;
  if (!showVerdicts) {
    console.log(`  verdicts are WITHHELD from this terminal: ${humanDone.size} of ${humanWanted} hand`);
    console.log('  labels are in, and a rater who has seen them is not an independent rater.\n');
  }

  for (const pair of todo) {
    const resolved = resolvePair(pair, rowsBySeed);
    if (!resolved) {
      append({ pairId: pair.pairId, ok: false, at: new Date().toISOString(), error: { message: 'unresolvable against the gen-v5 ledger' } });
      console.log(`  SKIP ${pair.pairId} — cannot resolve`);
      continue;
    }

    const userMessage = buildUserMessage(resolved);
    const reservation = estimateReservation(resolved);
    attempts += 1;

    let response = null;
    let failure = null;
    let tpmPauses = 0;

    for (;;) {
      const waitMs = throttleFor(spent, reservation);
      if (waitMs > 0) {
        console.log(`  ...${tokensInWindow(spent)} reserved of ${TOKENS_PER_MIN}/min, next reserves ` +
          `${reservation} — pausing ${(waitMs / 1000).toFixed(1)} s`);
        await sleep(waitMs);
      }

      failure = null;
      const t0 = Date.now();
      try {
        response = await groq.chat.completions.create({
          model: JUDGE_MODEL,
          temperature: JUDGE_TEMPERATURE,
          max_tokens: JUDGE_MAX_TOKENS,
          reasoning_effort: JUDGE_REASONING_EFFORT,
          messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content: userMessage }]
        });
        response.__latencyMs = Date.now() - t0;
        completed += 1;
        const u = response.usage || {};
        actualTokens += u.total_tokens || 0;
        reservedTokens += reservation;
        spent.push({
          at: Date.now(),
          tokens: (Number.isFinite(u.prompt_tokens) ? u.prompt_tokens : reservation - JUDGE_MAX_TOKENS) + JUDGE_MAX_TOKENS
        });
        break;
      } catch (err) {
        /**
         * THE BODY IS ON `err.message` HERE, NOT ON `err.cause`, AND READING ONLY
         * `err.cause` COST THIS RUN ~20 HOURS OF WALL TIME.
         *
         * `run-studypack-eval.js` reads `err.cause.message` and is RIGHT to: its
         * calls go through services/studyPack.service.js, which wraps the SDK
         * error so the status survives (§29.6's third defect and its fix). This
         * runner calls the Groq SDK DIRECTLY — there is no wrapper — so
         * `err.cause` is `undefined` and the copied line yielded `''`.
         *
         * WHAT THAT BROKE IS THE CLASSIFICATION, NOT THE RETRY. `retryAfterMs`
         * already fell back to `err.message`, so the backoff read the provider's
         * hint correctly; only `daily` was computed from the empty string, so
         * EVERY refusal looked like per-minute backpressure. §32.8 fixed a runner
         * that "computed which limit it was, printed it, and then ignored it";
         * this one could not compute it at all, and the two halves of the same
         * error object disagreeing is what hid it.
         *
         * THE SYMPTOM WAS NOT AN ERROR. A daily refusal was slept off and
         * retried, and because the daily cap refills at 2.3148 tokens/s a
         * ~700-token call succeeds after ~300 s — so the run kept 100% delivery
         * and no failed rows while dropping from 11.4 calls/minute to 0.2.
         * Measured: `tokens per day (TPD): Limit 200000, Used 199450,
         * Requested 915. Please try again in 2m37.68s`.
         */
        const raw = String((err && err.cause && err.cause.message) || (err && err.message) || '');
        failure = {
          message: String(err && err.message).slice(0, 400),
          status: err && err.status ? err.status : null,
          providerMessage: raw ? raw.replace(/\s+/g, ' ').slice(0, 600) : null,
          retryAfterMs: parseRetryHint(raw || String((err && err.message) || ''))
        };
        response = null;
      }

      const rateLimited = failure.status === 429 || /rate limit|rate_limit|429/i.test(failure.message || '');
      const daily = /tokens per day|TPD/i.test(failure.providerMessage || '');
      const perMinute = /tokens per minute|TPM|requests per minute|RPM/i.test(failure.providerMessage || '');

      /**
       * AN UNCLASSIFIABLE 429 STOPS. It does not get retried as backpressure.
       *
       * The bug above defaulted the unknown case to "per-minute", which is the
       * expensive direction: a daily refusal then gets slept off at the refill
       * rate forever. Requiring a POSITIVE per-minute match makes the default
       * the safe one — stop, record the body, let the operator read it — and
       * §32.8's rule survives: a TPM refusal is the operator's pacing and is
       * retried, a TPD refusal IS the finding and is recorded.
       */
      if (rateLimited && perMinute && !daily && tpmPauses < MAX_TPM_PAUSES) {
        tpmPauses += 1;
        spent.push({ at: Date.now(), tokens: reservation });
        const backoff = (failure.retryAfterMs || 1000) + TPM_PAUSE_MARGIN_MS;
        console.log(`  ... per-minute (TPM) 429 — pausing ${(backoff / 1000).toFixed(1)} s and retrying ` +
          `${pair.pairId} (backpressure, NOT a failed attempt; ${tpmPauses}/${MAX_TPM_PAUSES})`);
        await sleep(backoff);
        continue;
      }
      break;
    }

    if (response) {
      const choice = response.choices[0];
      const u = response.usage || {};
      const verdict = parseVerdict(choice.message.content);
      if (verdict.parseFailed) tally.fail += 1;
      else tally[verdict.level] += 1;

      append({
        pairId: pair.pairId,
        key: pair.key,
        seedId: pair.seedId,
        quintile: pair.quintile,
        slot: pair.slot,
        itemIndex: pair.itemIndex,
        stratum: pair.stratum,
        condition: pair.condition,
        passageLabel: pair.passageLabel,
        citedLabel: pair.citedLabel,
        humanLabelled: pair.humanLabelled,
        ok: true,
        at: new Date().toISOString(),
        judgeModel: response.model,
        judgeModelRequested: JUDGE_MODEL,
        temperature: JUDGE_TEMPERATURE,
        maxTokens: JUDGE_MAX_TOKENS,
        reasoningEffort: JUDGE_REASONING_EFFORT,
        level: verdict.level,
        reason: verdict.reason,
        parseFailed: verdict.parseFailed,
        sawThinkBlock: verdict.sawThinkBlock,
        finishReason: choice.finish_reason,
        latencyMs: response.__latencyMs,
        promptTokens: u.prompt_tokens ?? null,
        completionTokens: u.completion_tokens ?? null,
        totalTokens: u.total_tokens ?? null,
        reservationTokens: reservation,
        rawText: String(choice.message.content || '').slice(0, 800)
      });

      if (attempts % 25 === 0 || attempts <= 5) {
        process.stdout.write(
          `  ${String(attempts).padStart(4)}/${todo.length}  ${pair.stratum.padEnd(14)} ` +
          `${pair.condition.padEnd(5)}  ${String(u.total_tokens ?? '?').padStart(4)} tok  ` +
          `${String(response.__latencyMs).padStart(5)} ms  -> ` +
          `${verdict.parseFailed ? 'PARSE-FAIL' : (showVerdicts ? verdict.level : 'ok')}\n`
        );
      }
    } else {
      append({ pairId: pair.pairId, key: pair.key, condition: pair.condition, ok: false, at: new Date().toISOString(), error: failure });
      console.log(`  ${String(attempts).padStart(4)}/${todo.length}  API FAILURE  ${failure.status || ''} ${failure.message}`);

      if (failure.status === 429 || /rate limit|rate_limit|429/i.test(failure.message || '')) {
        const daily = /tokens per day|TPD/i.test(failure.providerMessage || '');
        const known = daily || /tokens per minute|TPM|requests per minute|RPM/i.test(failure.providerMessage || '');
        console.log(`\n  429 on the ${daily ? 'DAILY (TPD)' : known ? 'per-minute' : 'UNCLASSIFIED'} limit — STOPPING` +
          `${daily ? '' : ` after ${tpmPauses} TPM pauses`}.`);
        if (failure.providerMessage) console.log(`  ${failure.providerMessage.slice(0, 300)}`);
        if (failure.retryAfterMs) {
          const mins = failure.retryAfterMs / 60000;
          console.log(`  frees in ~${mins >= 1 ? `${Math.round(mins)} min` : `${(failure.retryAfterMs / 1000).toFixed(1)} s`} for ONE call.`);
        }
        console.log('  Nothing completed is lost — re-run the same command to resume.');
        console.log('  The emission order makes what landed a PROPORTIONAL SAMPLE, not a prefix.\n');
        break;
      }
    }

    await sleep(DEFAULT_DELAY_MS);
  }

  stream.end();
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n  attempts ${attempts}   completed ${completed}   ` +
    `delivery ${attempts ? ((completed / attempts) * 100).toFixed(1) : '0.0'}%   ${mins} min`);
  if (showVerdicts) {
    console.log(`  verdicts   2:${tally[2]}  1:${tally[1]}  0:${tally[0]}  parse-fail:${tally.fail}`);
  } else {
    console.log(`  verdicts   WITHHELD until the hand labels are in — ${tally.fail} failed to parse.`);
  }
  console.log(`  ACTUAL ${actualTokens} tokens (~${completed ? Math.round(actualTokens / completed) : 0}/call)   ` +
    `RESERVED ${reservedTokens}   ratio ${reservedTokens ? (actualTokens / reservedTokens).toFixed(2) : 'n/a'}`);
  console.log('\n  Report it:   npm run eval:judge -- --write     (PURE — no key, no network)\n');
}

async function main() {
  const state = load();
  if (has('run')) await run(state);
  else plan(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
