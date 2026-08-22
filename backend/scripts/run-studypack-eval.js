#!/usr/bin/env node
'use strict';

/**
 * run-studypack-eval.js — Phase 5.4. The gen-v5 RUNNER.
 *
 *   npm run gen:v5                the plan. Prices the run and calls nothing.
 *   npm run gen:v5 -- --run       spends quota.
 *   npm run gen:v5 -- --run --take N     resume a prefix
 *   npm run gen:v7                the 5.7 arm — SAME code, different neighbours
 *
 * ---------------------------------------------------------------------------
 * 5.7 MAKES THIS VARIANT-AWARE, WHICH IS 5.5's MOVE ON A DIFFERENT RUNNER
 * ---------------------------------------------------------------------------
 *
 * `gen:v7` is this file with `--variant v7`: it reads
 * data/gen-eval/clusters.v7.jsonl (the SAME 30 seeds, neighbours retrieved by
 * v5-embeddings) and appends to results/gen-v7.calls.jsonl. Nothing else
 * differs — same prompts, same model, same temperature, same max_tokens, same
 * context budget, same k. §29.4 mechanised "same model" for the 5.5 comparison
 * because a sentence in a document cannot stop a run; the same argument is why
 * 5.7 varies the retriever by pointing at a different INPUT FILE rather than by
 * copying this script.
 *
 * A COPY WOULD BE THE DEFECT THIS PROJECT KEEPS FINDING. §33.9a: the same
 * `err.cause` line was right in this file and wrong in the judge runner, and
 * nothing distinguished them by reading. One runner, two inputs.
 *
 * THE LEDGER GUARD IS §29.4's AND IT NOW RUNS HERE. A run refuses to append to
 * a ledger whose completed rows disagree with it about variant, model,
 * max_tokens, temperature or retriever version. 5.3 recorded the model and
 * refused a mixed ledger; 5.5 found it had recorded neither max_tokens nor
 * temperature and would have averaged two systems one field short. 5.7 adds the
 * field that would do it here: the RETRIEVER, which is the only variable this
 * phase moves.
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT SPENDS QUOTA. `npm run eval:gen` DOES NOT, AND THAT IS THE SPLIT.
 * ---------------------------------------------------------------------------
 *
 * Every one of 5.4's four metrics is computable over a committed ledger with no
 * new API call, so the RUNNER and the REPORTER are two commands rather than two
 * flags on one. `eval-gen.js` is pure — no key, no network, nothing under
 * data/ — and this file is the only half that needs a credential.
 *
 * §28.13 narrowed §17.1's "the Node eval path is dependency-free" to exclude the
 * whole generation eval path. 5.4 splits that narrowing in half: the generation
 * RUNNER needs groq-sdk, a network and a key; the generation REPORTER needs none
 * of them. That is a refinement, not a further narrowing.
 *
 * ---------------------------------------------------------------------------
 * IT MEASURES THE LIVE SERVICE. THERE IS NO FROZEN COPY AND NO SUBSTITUTED
 * VARIABLE.
 * ---------------------------------------------------------------------------
 *
 * `assembleContext`, `buildPrompt` and `generate` are imported from
 * services/studyPack.service.js — the code POST /api/study-pack/:noteId runs.
 * The alternative, issuing the Groq call from this script, would put a SECOND
 * hardcoded model string in the repository, which is §28.9's defect ("the model
 * is the one input with no checksum") reproduced deliberately, and would mean
 * `npm run gen:probe` no longer covered everything the project asks for.
 *
 * 5.5 reached the same position by a different route and §29.4 records why it is
 * the stronger one: gen-v2 measures the live function where gen-v1 measured a
 * copy. gen-v5 starts there.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT TOUCH MONGODB, AND THAT IS WHAT MAKES IT RUNNABLE AT ALL
 * ---------------------------------------------------------------------------
 *
 * `buildStudyPack()` starts from a note id and a user id and loads a corpus.
 * The golden set has neither: its 30 seeds are Stack Exchange documents with
 * neighbours already retrieved and STAMPED at 5.2 (`retriever`, `digest`, `k`).
 *
 * So this drives the layer beneath — the same `assembleContext` the service
 * calls, on the same cluster the service would have built. What is skipped is
 * `buildCluster`'s database read and its live `retrieval.index/search`, and the
 * cost is named rather than hidden: THE NEIGHBOURS ARE 5.2's DERIVED LISTS,
 * retrieved over all 27,325 corpus documents rather than over a <=500-note user
 * slice (§28.1, §12.2). tests/studypack.cluster.test.js is what covers the
 * database half, against a real mongo and no key.
 *
 * ---------------------------------------------------------------------------
 * THE LEDGER CARRIES THE CONTEXT THAT WAS SENT, AND THAT IS NOT DERIVED DATA
 * ---------------------------------------------------------------------------
 *
 * Each row stores the rendered text of every note admitted to the prompt.
 *
 * §8.5's rule is "do not commit derived data twice" and this is not that: it is
 * THE INPUT. §30.4's load-bearing argument for whole-note truncation is that a
 * citation-support metric must compare a claim against the text THE MODEL SAW —
 * so the row has to carry it, or the metric is scoring against a reconstruction.
 *
 * And reading it back out of data/gen-eval/clusters.jsonl instead would
 * reproduce the shape §30.3 rejected: a check that reads data/ passes in CI and
 * FAILS in the local reproduction of CI, which moves data/ aside entirely
 * (§29.11). Storing it costs ~180 KB on a ledger and buys a reporter that needs
 * nothing but results/.
 *
 * ---------------------------------------------------------------------------
 * n = 1, DECLARED HERE RATHER THAN SET BY THE QUOTA
 * ---------------------------------------------------------------------------
 *
 * One call per seed, 30 calls. 5.3 stopped at 234 of 330 cells and 5.5 at 78 of
 * 150, and both times what the run could afford chose n after the fact — §28.6's
 * "the quota set n, not the design".
 *
 * WHAT n=1 BUYS: the unit of a citation metric is the ITEM, not the call, so 30
 * seeds x 14 items is ~420 items and the between-seed sample is large.
 * WHAT IT DOES NOT: no within-cell variance. §28.8 measured 32.1% of examQs
 * cells flipping verdict on a re-draw at this temperature and NOTHING here
 * establishes the equivalent for a study pack. Every gen-v5 rate is therefore a
 * rate with no noise floor under it, and the report says so at every site.
 *
 * ---------------------------------------------------------------------------
 * PACING AND THE COST MODEL — §30.1's ↳, WHICH IS COUNTER-INTUITIVE TWICE
 * ---------------------------------------------------------------------------
 *
 * SERIAL, no concurrency, no retries. A 429 STOPS the run; the ledger is
 * appended as it goes, so re-invoking resumes. Backoff is 7.2's and a retried
 * call's latency is not the shipped call's latency.
 *
 * THE TWO LIMITS CHARGE DIFFERENTLY:
 *   per-minute  charged on the RESERVATION, prompt + max_tokens (§29.6, probe)
 *   daily       charged on ACTUAL usage      (§30.1, measured: 72 calls
 *               reserved 166,320 and were charged 65,881 — ratio 0.40)
 *
 * So pacing is against the reservation (that is the gate that stops a run
 * mid-flight) and the daily PRICE below is quoted in actual tokens, because
 * pricing a run on reservations overestimates by ~2.5x and is what deferred the
 * 5.5 completion by a day.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const studyPack = require('../services/studyPack.service');
const { MODEL, TEMPERATURE, MAX_TOKENS } = require('../services/llm.service');

const REPO = path.resolve(__dirname, '..', '..');

/**
 * The default arm is 5.4's and its paths are the committed ones. A variant
 * names its own cluster file and its own ledger, never sharing either.
 */
const ARMS = {
  v5: {
    clusters: path.join(REPO, 'data', 'gen-eval', 'clusters.jsonl'),
    ledger: path.join(REPO, 'results', 'gen-v5.calls.jsonl'),
    retriever: 'v4-bm25',
    phase: '5.4'
  },
  v7: {
    clusters: path.join(REPO, 'data', 'gen-eval', 'clusters.v7.jsonl'),
    ledger: path.join(REPO, 'results', 'gen-v7.calls.jsonl'),
    retriever: 'v5-embeddings',
    phase: '5.7'
  }
};

/** Per-minute token budget, from the x-ratelimit-limit-tokens header (§28.6). */
const TOKENS_PER_MIN = 8000;
const DEFAULT_DELAY_MS = 2500;

/**
 * A per-minute (TPM) 429 is BACKPRESSURE, NOT A FAILED ATTEMPT, and the two
 * must not be recorded as the same thing. `delivery = completed / attempted` is
 * a REPORTED metric, and PRIMER §5.3a is explicit about why an API failure is
 * an exclusion rather than a zero: "folding it in as a zero makes conformance a
 * function of the harness's pacing, which is a property of the operator rather
 * than of the system." A TPM refusal whose stated wait is 487 MILLISECONDS is
 * exactly that — the operator's pacing — so it is slept off and the seed is
 * retried, and no ledger row is written for it.
 *
 * THE DAILY (TPD) CAP STILL STOPS THE RUN. That one is a real budget boundary
 * measured in hours, its refusal IS the finding, and it is recorded.
 */
const MAX_TPM_PAUSES = 8;
const TPM_PAUSE_MARGIN_MS = 2000;
const DEFAULT_MAX_CALLS = 40;

/**
 * Mean ACTUAL tokens per study-pack call. Used only to PRICE the run, and it is
 * the actual figure rather than the 3,460 reservation on purpose — see the
 * header.
 *
 * RE-DERIVED 20 Aug 2026 FROM THE COMPLETE 30-SEED LEDGER: 97,073 tokens over
 * 30 calls = 3,236, replacing 2,195. The old value came from §30.8's ONE live
 * call, which was a FIVE-note cluster where a golden one is up to nine — 46%
 * low, and the run it priced stopped at 9 of 30 seeds because of it. §30.8
 * labelled that call "an existence proof, not a rate" about its CITATION
 * figures; the same call's TOKEN figures were carried into this constant
 * without the warning travelling with them. §32.2.
 *
 * IT WAS NOT RE-DERIVED FROM THE 9- OR 27-SEED PARTIALS, deliberately: fitting
 * a constant to a partial stratified set is the same mistake at a smaller
 * scale. The set is now 30 of 30, 6 per quintile.
 *
 * STILL AN ESTIMATE, AND STILL A MEAN OF ONE DRAW PER SEED. sd is 328 and the
 * range is 2,588-3,828, so a 30-call run is priced to roughly +/-10%.
 */
const ACTUAL_TOKENS_PER_CALL = 3236;
const DAILY_CAP = 200000;

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

/** Which arm this invocation is. Unknown names fail loudly rather than default. */
function resolveArm() {
  const name = arg('variant', 'v5');
  if (!ARMS[name]) {
    console.error(`unknown --variant "${name}" — known: ${Object.keys(ARMS).join(', ')}`);
    process.exit(1);
  }
  return { name, ...ARMS[name] };
}

function loadClusters(arm) {
  if (!fs.existsSync(arm.clusters)) {
    console.error(`MISSING ${path.relative(REPO, arm.clusters)} — build it with:`);
    console.error(arm.name === 'v5'
      ? '  npm run gen:clusters -- --write'
      : `  npm run gen:clusters -- --retriever ${arm.retriever} --variant ${arm.name} --write`);
    console.error('It needs the gitignored corpus at data/corpus/cooking.jsonl.');
    process.exit(1);
  }
  const clusters = readJsonl(arm.clusters);

  // THE CLUSTER FILE MUST CARRY THE RETRIEVER THE ARM CLAIMS. The retriever is
  // the one variable 5.7 moves, so it is checked against the DATA rather than
  // against the flag that asked for it — §33.2's rule, which checks the judge
  // separation against the ledger instead of a constant somebody can edit in
  // the same commit.
  const stamped = new Set(clusters.map((c) => c.retriever));
  if (stamped.size !== 1 || !stamped.has(arm.retriever)) {
    console.error(
      `REFUSING: arm "${arm.name}" expects neighbours retrieved by ${arm.retriever}, but\n` +
      `  ${path.relative(REPO, arm.clusters)} is stamped ${[...stamped].join(', ') || '(nothing)'}.`
    );
    process.exit(1);
  }
  return clusters;
}

/**
 * §29.4's guard, with the field 5.7 needs added.
 *
 * A ledger holding two configurations averages two systems, and the report
 * cannot see it because both rows look complete. 5.3 refused a ledger mixing
 * MODELS; 5.5 found max_tokens and temperature unrecorded and would have mixed
 * ceilings one field short. The field that would do it here is the RETRIEVER,
 * because that is the only thing 5.7 changes — a v7 run appending to the v5
 * ledger would produce a single file whose 60 rows are two experiments.
 */
function assertLedgerHomogeneous(arm, expected) {
  const rows = readJsonl(arm.ledger).filter((r) => r.ok);
  if (rows.length === 0) return;
  const fields = [
    ['variant', (r) => r.variant, expected.variant],
    ['model', (r) => r.modelRequested, expected.model],
    ['maxTokens', (r) => r.maxTokens, expected.maxTokens],
    ['temperature', (r) => r.temperature, expected.temperature],
    ['retriever', (r) => (r.retrieval || {}).version, expected.retriever]
  ];
  for (const [name, read, want] of fields) {
    const seen = new Set(rows.map(read));
    if (seen.size > 1 || !seen.has(want)) {
      console.error(
        `REFUSING to append to ${path.relative(REPO, arm.ledger)}: it disagrees about ${name}.\n` +
        `  ledger holds  ${[...seen].map(String).join(', ')}\n` +
        `  this run is   ${String(want)}\n` +
        '  A ledger mixing two configurations silently averages two systems (§29.4).'
      );
      process.exit(1);
    }
  }
}

/**
 * One cluster, assembled exactly as the service would assemble it.
 *
 * The seed is the golden document; the neighbours are 5.2's stamped list in
 * rank order. `assembleContext` is the service's own function, so the budget,
 * the labelling and the whole-note truncation are not reimplemented here.
 */
function buildContext(cluster) {
  const seedDoc = { id: String(cluster.seedId), title: cluster.title, body: cluster.body };
  const docsById = new Map([[seedDoc.id, seedDoc]]);
  const hits = cluster.neighbours.map((n) => {
    docsById.set(String(n.id), { id: String(n.id), title: n.title, body: n.body });
    return { docId: String(n.id), rank: n.rank, score: n.score };
  });
  return studyPack.assembleContext(seedDoc, hits, docsById);
}

function plan(arm, clusters) {
  const rows = readJsonl(arm.ledger).filter((r) => r.ok);
  const done = new Set(rows.map((r) => String(r.seedId)));
  const todo = clusters.filter((c) => !done.has(String(c.seedId)));

  // §32.8's rule, pointed at the number that decides whether a run fits: a
  // hardcoded sentence beside a recomputed number can only rot. The constant
  // was fitted on the v5 arm's 30 calls; a v7 call is a different population
  // for §32.2's exact reason, so the ledger's own mean is printed beside it and
  // the divergence is flagged at the moment somebody types --run.
  const charged = rows.map((r) => r.totalTokens).filter(Number.isFinite);
  const measured = charged.length ? Math.round(charged.reduce((a, b) => a + b, 0) / charged.length) : null;

  const contexts = clusters.map(buildContext);
  const estPrompt = Math.round(contexts.reduce((a, c) => a + c.estimatedTokens, 0) / contexts.length);
  const reserved = todo.length * (estPrompt + MAX_TOKENS);
  const perCall = measured !== null && charged.length >= 5 ? measured : ACTUAL_TOKENS_PER_CALL;
  const actual = todo.length * perCall;
  const bound = contexts.filter((c) => c.dropped.length > 0).length;

  console.log(`PHASE ${arm.phase} — gen-${arm.name} PLAN. Nothing is called.\n`);
  console.log(`  arm                ${arm.name}   neighbours by ${arm.retriever}`);
  console.log(`  clusters           ${path.relative(REPO, arm.clusters)}`);
  console.log(`  ledger             ${path.relative(REPO, arm.ledger)}`);
  console.log(`  model              ${MODEL}   from llm.service.js, imported`);
  console.log(`  max_tokens         ${MAX_TOKENS}   INHERITED, not derived (§30.9)`);
  console.log(`  temperature        ${TEMPERATURE}`);
  console.log(`  budget             ${studyPack.CONTEXT_TOKEN_BUDGET} context tokens`);
  console.log('');
  console.log(`  seeds              ${clusters.length}   n = 1, declared, NOT set by the quota`);
  console.log(`  already complete   ${done.size}`);
  console.log(`  to call now        ${todo.length}`);
  console.log(`  mean prompt        ~${estPrompt} tokens (estimator, over all ${clusters.length} clusters)`);
  console.log(`  budget binds on    ${bound} of ${clusters.length} clusters`);
  console.log('');
  console.log('  COST — TWO FIGURES, BECAUSE THE TWO LIMITS CHARGE DIFFERENTLY (§30.1):');
  console.log('');
  console.log(`    RESERVED  ${String(reserved).padStart(7)} tokens   prompt + max_tokens per call.`);
  console.log('                               This is what the PER-MINUTE gate charges and');
  console.log('                               what stops a run mid-flight.');
  console.log(`    ACTUAL    ${String(actual).padStart(7)} tokens   ~${perCall}/call.`);
  console.log('                               This is what the DAILY cap charges.');
  console.log('');
  console.log(`    daily cap ${DAILY_CAP} per ORGANISATION, refilling at 2.3148 tokens/s.`);
  console.log(`    the actual figure is ${((actual / DAILY_CAP) * 100).toFixed(0)}% of a day; the reserved one is ` +
    `${((reserved / DAILY_CAP) * 100).toFixed(0)}%.`);
  if (actual > DAILY_CAP) {
    console.log('\n    THIS RUN CANNOT FIT IN ONE DAY even priced on actual tokens.');
  }
  console.log('');
  if (measured === null) {
    console.log(`    ACTUAL_TOKENS_PER_CALL = ${ACTUAL_TOKENS_PER_CALL}, fitted on the v5 arm's complete`);
    console.log('    30-call ledger. THIS ledger has no rows yet, so nothing corroborates it');
    console.log('    for this arm — §32.2: a constant from a different population was 46% low');
    console.log('    and stopped a run at 9 of 30. Treat the reserved figure as the safe side.');
  } else {
    const drift = ((measured - ACTUAL_TOKENS_PER_CALL) / ACTUAL_TOKENS_PER_CALL) * 100;
    console.log(`    constant ${ACTUAL_TOKENS_PER_CALL}   THIS LEDGER'S OWN MEAN ${measured} over ${charged.length} calls  ` +
      `(${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%)`);
    console.log(charged.length >= 5
      ? '    The ledger figure is the one priced above. §32.2.'
      : '    Fewer than 5 rows — the CONSTANT is priced above, because fitting to a');
    if (charged.length < 5) console.log('    partial stratified set is the same mistake at a smaller scale.');
  }
  console.log('');
  console.log(`  pacing             serial, ${DEFAULT_DELAY_MS} ms apart, throttled BEFORE each`);
  console.log(`                     call against its own reservation, under ${TOKENS_PER_MIN}/min`);
  console.log(`  retries            per-minute (TPM) 429 only — slept off and retried, up to`);
  console.log(`                     ${MAX_TPM_PAUSES} times, and NOT counted as an attempt. A DAILY (TPD)`);
  console.log('                     429 still STOPS the run; the ledger resumes it');
  console.log('');
  console.log(`  Run it:   npm run gen:${arm.name} -- --run`);
  console.log('  Check the balance first:   npm run gen:quota\n');
}

function tokensInWindow(spent) {
  const cutoff = Date.now() - 60000;
  return spent.filter((s) => s.at >= cutoff).reduce((a, s) => a + s.tokens, 0);
}

/**
 * How long to wait before issuing a call that will RESERVE `reservation` tokens.
 *
 * THE RESERVATION OF THE CALL ABOUT TO BE MADE IS AN ARGUMENT, and that is the
 * whole fix rather than a refinement of one. The provider's gate is
 * `used_in_window + requested <= TOKENS_PER_MIN` — §29.6 established by
 * controlled probe that the per-minute limit is charged on what a call
 * RESERVES, not on what it writes. A throttle that only asks whether the PAST
 * minute is under budget therefore lets exactly one breaching call through
 * every time the window is close to full, because it cannot see the request
 * that is about to be added to it.
 *
 * IT DID, ON 20 Aug 2026, AND IT MISSED BY 65 TOKENS: 4,432 in the window plus
 * a 3,633-token reservation is 8,065 against a limit of 8,000. The run stopped
 * at 14 of 30 seeds with the DAILY budget nowhere near binding (~58,700 free).
 *
 * The wait is the time for enough of the oldest reservations to age out of the
 * 60-second window that this one fits — not a flat minute, and not the age of
 * the single oldest entry, which under-waits whenever more than one has to go.
 */
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

async function run(arm, clusters) {
  if (!process.env.GROQ_API_KEY) {
    console.error('MISSING GROQ_API_KEY. It lives in backend/.env — see CLAUDE.md.');
    process.exit(1);
  }

  const maxCalls = Number(arg('max-calls', DEFAULT_MAX_CALLS));
  assertLedgerHomogeneous(arm, {
    variant: arm.name, model: MODEL, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, retriever: arm.retriever
  });
  const done = new Set(readJsonl(arm.ledger).filter((r) => r.ok).map((r) => String(r.seedId)));
  let todo = clusters.filter((c) => !done.has(String(c.seedId)));

  // --take shortens deliberately; --max-calls REFUSES a long run rather than
  // truncating it. Two different jobs, and measure-gen-baseline.js records why
  // they must not be one flag: silently doing less than asked is how a partial
  // run gets mistaken for a complete one.
  const take = arg('take', null);
  if (take !== null) {
    const n = Number(take);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--take must be a positive integer; got "${take}"`);
      process.exit(1);
    }
    if (n < todo.length) {
      console.log(`  --take ${n}: running a PREFIX of ${todo.length} remaining seeds.`);
      todo = todo.slice(0, n);
    }
  }

  console.log(`PHASE ${arm.phase} — gen-${arm.name}: Study Pack over the 30 golden seeds, n = 1.\n`);
  console.log(`  arm              ${arm.name}   neighbours by ${arm.retriever}  — THE ONLY VARIABLE`);
  console.log(`  model            ${MODEL}   imported from llm.service.js`);
  console.log(`  max_tokens       ${MAX_TOKENS}   inherited (§30.9)`);
  console.log(`  issued by        services/studyPack.service.js — THE LIVE FUNCTION`);
  console.log(`  seeds to call    ${todo.length} of ${clusters.length}`);
  console.log(`  retries          TPM 429 retried (<=${MAX_TPM_PAUSES}, not an attempt); TPD 429 STOPS\n`);

  if (todo.length > maxCalls) {
    console.error(`REFUSING: ${todo.length} calls exceeds the --max-calls ceiling of ${maxCalls}.`);
    process.exit(1);
  }
  if (todo.length === 0) {
    console.log('  Nothing to do. Every seed has a completed call.\n');
    return;
  }

  const stream = fs.createWriteStream(arm.ledger, { flags: 'a' });
  const append = (row) => stream.write(`${JSON.stringify(row)}\n`);

  let attempts = 0;
  let completed = 0;
  let actualTokens = 0;
  const started = Date.now();
  const spent = [];

  for (const cluster of todo) {
    const context = buildContext(cluster);
    const noteCount = context.included.length;

    // The rendered text per note, taken from the same renderNote() the prompt
    // was built with, so the ledger holds exactly what the model saw.
    const notes = context.included.map((n) => {
      const doc = n.role === 'seed'
        ? { title: cluster.title, body: cluster.body }
        : cluster.neighbours.find((x) => String(x.id) === n.noteId);
      return {
        label: n.label,
        noteId: n.noteId,
        title: n.title,
        role: n.role,
        rank: n.rank,
        text: doc ? String(doc.body || '') : ''
      };
    });

    // ONE ATTEMPT PER SEED. A TPM pause below is not an attempt — see
    // MAX_TPM_PAUSES for why delivery must not count the operator's pacing.
    attempts += 1;
    let observation = null;
    let failure = null;
    let tpmPauses = 0;

    // Charged on the RESERVATION under the per-minute limit (§29.6), whatever
    // the model actually writes, so the estimate is what the gate sees.
    const reservation = context.estimatedTokens + MAX_TOKENS;

    for (;;) {
      // THE THROTTLE RUNS BEFORE THE CALL AND KNOWS THIS CALL'S RESERVATION.
      const waitMs = throttleFor(spent, reservation);
      if (waitMs > 0) {
        console.log(`  ...${tokensInWindow(spent)} reserved of ${TOKENS_PER_MIN}/min, ` +
          `next call reserves ${reservation} — pausing ${(waitMs / 1000).toFixed(1)} s`);
        await sleep(waitMs);
      }

      failure = null;
      try {
        observation = await studyPack.generate(context.text, noteCount);
        completed += 1;
        actualTokens += observation.totalTokens || 0;
        spent.push({
          at: Date.now(),
          tokens: (Number.isFinite(observation.promptTokens) ? observation.promptTokens : context.estimatedTokens) + MAX_TOKENS
        });
        break;
      } catch (err) {
        // THE PROVIDER'S OWN MESSAGE, NOT JUST THE MAPPED ONE. §29.6: the mapped
        // sentence cannot tell a per-minute limit from a daily one, and the daily
        // one carries "Limit 200000, Used ..., try again in ...". 5.5 threw that
        // body away twice before recording it.
        const raw = err && err.cause ? String(err.cause.message || '') : '';
        failure = {
          message: String(err && err.message).slice(0, 400),
          status: err && err.status ? err.status : null,
          providerMessage: raw ? raw.replace(/\s+/g, ' ').slice(0, 600) : null,
          retryAfterMs: parseRetryHint(raw || String((err && err.message) || ''))
        };
        observation = null;
      }

      const rateLimited = failure.status === 429 || /rate limit|rate_limit|429/i.test(failure.message || '');
      const daily = /tokens per day|TPD/i.test(failure.providerMessage || '');

      if (rateLimited && !daily && tpmPauses < MAX_TPM_PAUSES) {
        tpmPauses += 1;
        // The refusal executed nothing, but it PROVES the window is fuller than
        // this process believed — a resumed run starts with an empty window and
        // cannot know what the previous one spent. Record the reservation so the
        // throttle stops guessing.
        spent.push({ at: Date.now(), tokens: reservation });
        const backoff = (failure.retryAfterMs || 1000) + TPM_PAUSE_MARGIN_MS;
        console.log(`  ... per-minute (TPM) 429 — pausing ${(backoff / 1000).toFixed(1)} s and retrying ` +
          `seed ${cluster.seedId} (backpressure, NOT a failed attempt; ${tpmPauses}/${MAX_TPM_PAUSES})`);
        await sleep(backoff);
        continue;
      }
      break;
    }

    if (observation) {
      append({
        seedId: cluster.seedId,
        quintile: cluster.quintile,
        words: cluster.words,
        ok: true,
        at: new Date().toISOString(),
        variant: arm.name,
        model: observation.model,
        modelRequested: MODEL,
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        // --- the context THAT WAS SENT. The input, not derived data. ---------
        context: {
          notes,
          droppedCount: context.dropped.length,
          droppedIds: context.dropped.map((d) => d.noteId),
          budgetTokens: context.budgetTokens,
          estimatedPromptTokens: context.estimatedTokens,
          budgetExceededBySeed: context.budgetExceededBySeed,
          chars: context.text.length
        },
        retrieval: { version: cluster.retriever, digest: cluster.digest, k: cluster.k },
        // --- what came back --------------------------------------------------
        latencyMs: observation.latencyMs,
        finishReason: observation.finishReason,
        promptTokens: observation.promptTokens,
        completionTokens: observation.completionTokens,
        reasoningTokens: observation.reasoningTokens,
        totalTokens: observation.totalTokens,
        estimatorSlackTokens: Number.isFinite(observation.promptTokens)
          ? context.estimatedTokens - observation.promptTokens
          : null,
        rawText: observation.rawText
      });

      const v = require('./lib/studypack-metrics').classifyStudyPack(observation.rawText);
      const mark = v.shape ? (v.cardinality ? 'ok' : 'short') : (v.cause || 'fail');
      process.stdout.write(
        `  ${String(attempts).padStart(3)}/${todo.length}  seed ${String(cluster.seedId).padStart(6)}  ` +
        `${String(noteCount).padStart(2)} notes  ${String(observation.latencyMs).padStart(5)} ms  ` +
        `${String(observation.completionTokens ?? '?').padStart(4)} out  ` +
        `${String(observation.finishReason).padEnd(6)}  ${mark}\n`
      );
    } else {
      append({ seedId: cluster.seedId, quintile: cluster.quintile, ok: false, at: new Date().toISOString(), variant: arm.name, error: failure });
      console.log(`  ${String(attempts).padStart(3)}/${todo.length}  seed ${String(cluster.seedId).padStart(6)}  ` +
        `API FAILURE  ${failure.status || ''} ${failure.message}`);

      if (failure.status === 429 || /rate limit|rate_limit|429/i.test(failure.message || '')) {
        const daily = /tokens per day|TPD/i.test(failure.providerMessage || '');
        // A TPM refusal only reaches here having exhausted MAX_TPM_PAUSES, which
        // means the pauses are not working rather than that the budget is gone.
        console.log(`\n  429 on the ${daily ? 'DAILY (TPD)' : 'per-minute'} limit — STOPPING` +
          `${daily ? '' : ` after ${tpmPauses} TPM pauses`}.`);
        if (failure.providerMessage) console.log(`  ${failure.providerMessage.slice(0, 300)}`);
        if (failure.retryAfterMs) {
          const mins = failure.retryAfterMs / 60000;
          console.log(`  frees in ~${mins >= 1 ? `${Math.round(mins)} min` : `${(failure.retryAfterMs / 1000).toFixed(1)} s`} for ONE call.`);
        }
        console.log('  Nothing completed is lost — re-run the same command to resume.\n');
        break;
      }
    }

    await sleep(DEFAULT_DELAY_MS);
  }

  stream.end();
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n  attempts ${attempts}   completed ${completed}   ` +
    `delivery ${((completed / attempts) * 100).toFixed(1)}%   ${mins} min`);
  console.log(`  ACTUAL tokens charged  ${actualTokens}   (~${completed ? Math.round(actualTokens / completed) : 0}/call)`);
  console.log(arm.name === 'v5'
    ? '\n  Report it:   npm run eval:gen -- --write     (PURE — no key, no network)\n'
    : '\n  Then judge it:   npm run judge:set -- --variant v7 --write   then   npm run judge:v7\n');
}

async function main() {
  const arm = resolveArm();
  const clusters = loadClusters(arm);
  if (has('run')) await run(arm, clusters);
  else plan(arm, clusters);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
