#!/usr/bin/env node
'use strict';

/**
 * probe-groq-model.js — Phase 5.3, TURNED INTO A CHECK AT 5.0.
 *
 *   npm run gen:probe                 check the LIVE model; exit 1 if it is gone
 *   npm run gen:probe -- --write      also write results/gen-model-resolves.txt
 *
 * WRITTEN BECAUSE THE BASELINE RUN FAILED ON ITS FIRST CALL, and the failure
 * turned out to be 5.3's headline finding rather than a harness bug:
 * `llama-3.3-70b-versatile` had been retired, so all five AI features returned
 * a 500 to every user, and nothing in this repository could have noticed — no
 * test, no checker, no CI step and no eval touched the model string, and
 * `npm test` passed with the feature completely dead.
 *
 * ---------------------------------------------------------------------------
 * WHAT 5.0 CHANGED, AND IT IS THE DIFFERENCE BETWEEN A PROBE AND A CHECK
 * ---------------------------------------------------------------------------
 *
 * 5.3's version hardcoded the retired string through `llm-v1-shipped.MODEL`, so
 * it could only ever re-report a finding that was already made. It now reads
 * the LIVE model from `services/llm.service.js` — which 5.0 exported for this
 * purpose — and EXITS NON-ZERO when that string is not reachable. That is
 * ROADMAP 5.0's Done criterion: "a check that fails when the model string stops
 * resolving".
 *
 * It cannot run in CI: it needs a network and a key. The companion that runs
 * under `npm test` when a key is exported is `tests/gen-model-resolves.test.js`,
 * and the residual gap — neither is automatic — is stated there and in §29.3.
 *
 * ---------------------------------------------------------------------------
 * IT WRITES A DIFFERENT FILE FROM THE ONE 5.3 WROTE, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * `results/gen-model-retired.txt` is the evidence that the shipped app was dead
 * on 19 Aug 2026. Now that the live model resolves, re-running with --write
 * would OVERWRITE that evidence with a success — deleting the record of the
 * defect by fixing it. So the retirement transcript is left frozen, in the
 * class of the `curl` transcript §27.1 used against the Railway host, and this
 * writes `results/gen-model-resolves.txt` instead.
 *
 * NEITHER FILE REGENERATES. Both are facts about a third party on a date, and
 * the model list will move again — which is the point of writing them down.
 * §27.6's rule: A CLOSED QUESTION IS AN ASSERTION WITH NO EXPIRY, and a
 * hardcoded model id is exactly that shape.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Groq = require('groq-sdk');
const shippedV1 = require('./lib/llm-v1-shipped');
const live = require('../services/llm.service');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'results', 'gen-model-resolves.txt');

async function main() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('MISSING GROQ_API_KEY — it lives in backend/.env.');
    process.exit(1);
  }
  const groq = new Groq({ apiKey, maxRetries: 0 });
  const out = [];
  const w = (s = '') => out.push(s);

  // Set false by any step that fails. THE EXIT CODE IS THE POINT of this
  // script existing at 5.0 rather than 5.3: a probe reports, a check fails.
  let ok = true;

  w('DOES THE MODEL THE APP ASKS FOR STILL RESOLVE? — Phase 5.0');
  w('='.repeat(74));
  w('');
  w(`  services/llm.service.js      const MODEL = '${live.MODEL}';`);
  w(`  retired at 5.3, kept frozen  '${shippedV1.MODEL}'  -> results/gen-model-retired.txt`);
  w('');
  w('  DOES NOT REGENERATE. This is a fact about a third party on a date, in the');
  w('  class of §27.1\'s curl transcript against the Railway host. The model list');
  w('  below will move again; that is the point of writing it down.');
  w('');

  // 1. Does the key authenticate at all? A 401 here would mean something else
  //    entirely, and the distinction is the whole finding.
  w('1. IS THE KEY VALID?');
  w('');
  let models = null;
  try {
    const list = await groq.models.list();
    models = list.data.map((m) => m.id).sort();
    w(`   models.list()            200 OK — the key authenticates`);
    w(`   models reachable         ${models.length}`);
  } catch (err) {
    w(`   models.list()            FAILED status=${err.status} ${String(err.message).slice(0, 160)}`);
    w('');
    w('   The key does not authenticate, so nothing below distinguishes a retired');
    w('   model from a bad key. Fix the key before reading any further.');
    finish(out, false);
    return;
  }

  w('');
  w('2. IS THE MODEL THE APP ASKS FOR AMONG THEM?');
  w('');
  const present = models.includes(live.MODEL);
  if (!present) ok = false;
  w(`   ${live.MODEL}   ${present ? 'PRESENT' : 'ABSENT'}`);
  w('');
  w(`   the string 5.3 found retired, for contrast:`);
  w(`   ${shippedV1.MODEL}   ${models.includes(shippedV1.MODEL) ? 'PRESENT — 5.3 IS STALE, re-read it' : 'ABSENT, as at 5.3'}`);
  w('');
  for (const id of models) w(`     ${id}`);

  w('');
  w('3. WHAT DOES A REAL CALL DO?');
  w('');
  w('   One call, the shipped prompt for `summarize`, against the LIVE model.');
  w('');
  w('   The frozen v1 copy issues it, with its `model` override pointed at the');
  w('   live string. Its max_tokens stays 1024 — the frozen copy exposes no');
  w('   override for it and must not gain one. That does not weaken this check:');
  w('   what is being tested is whether the MODEL resolves, and a ceiling of');
  w('   1024 answers that as well as 2048 does. A truncated summarize would');
  w('   still be a 200.');
  w('');
  try {
    const obs = await shippedV1.callShipped(
      groq, 'How should I cook bacon in an oven?', 'summarize',
      { model: live.MODEL }
    );
    w(`   200 OK — the model answered.`);
    w(`   finish_reason            ${obs.finishReason}`);
    w(`   completion tokens        ${obs.completionTokens}`);
    w(`   latency                  ${obs.latencyMs} ms`);
  } catch (err) {
    ok = false;
    w(`   status                   ${err.status}`);
    w(`   message                  ${String(err.message).replace(/\s+/g, ' ').slice(0, 220)}`);
  }

  w('');
  w('4. VERDICT');
  w('');
  if (ok) {
    w('   PASS — the model services/llm.service.js names is reachable and answers.');
    w('   POST /api/llm/:noteId/:feature can serve all five features.');
  } else {
    w('   FAIL — the app asks for a model it cannot reach, so all five AI features');
    w('   return 500 to every user RIGHT NOW. This is the exact state 5.3 found');
    w('   (results/gen-model-retired.txt) and it needs a product decision: pick a');
    w('   model from the list above, change llm.service.js, and re-measure §29 on');
    w('   the new one or the before/after means nothing.');
  }
  w('');
  w('   Nothing else in this repository checks this. `npm test` passes green with');
  w('   the feature entirely dead unless GROQ_API_KEY is exported, which is what');
  w('   tests/gen-model-resolves.test.js needs. check:blocks verifies that');
  w('   commands run and paths resolve — a retired third-party identifier is');
  w('   neither. §29.3.');
  w('');

  finish(out, ok);
}

/**
 * Print, optionally write, and SET THE EXIT CODE. The exit code is what makes
 * this a check rather than a probe — ROADMAP 5.0's Done criterion asks for
 * something that FAILS when the model string stops resolving, and a script that
 * prints "ABSENT" and exits 0 does not fail anything.
 */
function finish(out, ok) {
  const text = `${out.join('\n')}\n`;
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, text);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  }
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
