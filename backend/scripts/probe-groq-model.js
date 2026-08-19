#!/usr/bin/env node
'use strict';

/**
 * probe-groq-model.js — Phase 5.3.
 *
 *   npm run gen:probe                 print the probe
 *   npm run gen:probe -- --write      also write results/gen-model-retired.txt
 *
 * WRITTEN BECAUSE THE BASELINE RUN FAILED ON ITS FIRST CALL, and the failure
 * turned out to be the session's headline finding rather than a harness bug.
 *
 * `services/llm.service.js:17` hardcodes `llama-3.3-70b-versatile`. On 19 Aug
 * 2026 that string returns HTTP 404 `model_not_found` for every one of the five
 * shipped features. The key is fine — `models.list()` succeeds — so this is a
 * RETIREMENT, not an auth failure and not a rate limit.
 *
 * THE CONSEQUENCE IS NOT ABOUT THE EVAL. Every one of the five AI features
 * returns a 500 to any user, today, and has since Groq withdrew the model.
 * Nothing in this repository could have noticed: no test, no checker, no CI
 * step and no eval touches the model string, and `npm test` passes with the
 * feature completely dead.
 *
 * THIS PROBE IS THE ONE THING HERE THAT IS WORTH RE-RUNNING LATER. Its output
 * is a fact about a third party on a date, so it does not regenerate — the
 * model list will move again. It is committed as the evidence for a claim, in
 * the class of the `curl` transcript §27.1 used to establish that the Railway
 * backend serves nothing. §27.6's rule: A CLOSED QUESTION IS AN ASSERTION WITH
 * NO EXPIRY, and a hardcoded model id is exactly that shape.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Groq = require('groq-sdk');
const shipped = require('./lib/llm-v1-shipped');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'results', 'gen-model-retired.txt');

async function main() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('MISSING GROQ_API_KEY — it lives in backend/.env.');
    process.exit(1);
  }
  const groq = new Groq({ apiKey, maxRetries: 0 });
  const out = [];
  const w = (s = '') => out.push(s);

  w('THE SHIPPED MODEL STRING IS RETIRED — Phase 5.3, 19 Aug 2026');
  w('='.repeat(74));
  w('');
  w('  services/llm.service.js:17   const MODEL = \'llama-3.3-70b-versatile\';');
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
    finish(out);
    return;
  }

  w('');
  w('2. IS THE SHIPPED MODEL AMONG THEM?');
  w('');
  const present = models.includes(shipped.MODEL);
  w(`   ${shipped.MODEL}   ${present ? 'PRESENT' : 'ABSENT'}`);
  w('');
  for (const id of models) w(`     ${id}`);

  w('');
  w('3. WHAT DOES A REAL CALL DO?');
  w('');
  w('   One call, the shipped prompt for `summarize`, the shipped temperature and');
  w('   max_tokens, against the shipped model string.');
  w('');
  try {
    await shipped.callShipped(groq, 'How should I cook bacon in an oven?', 'summarize');
    w('   200 OK — the model answered. THIS PROBE IS STALE; re-read it.');
  } catch (err) {
    w(`   status                   ${err.status}`);
    w(`   message                  ${String(err.message).replace(/\s+/g, ' ').slice(0, 220)}`);
  }

  w('');
  w('4. WHAT THIS MEANS FOR THE APP, WHICH IS NOT AN EVAL QUESTION');
  w('');
  w('   POST /api/llm/:noteId/:feature returns 500 for all five features. The');
  w('   error mapping at llm.service.js:64-77 handles 401, 429 and 503 and has no');
  w('   branch for 404, so the user-visible string is the generic');
  w('   "AI processing failed: 404 ...".');
  w('');
  w('   NOTHING IN THIS REPOSITORY COULD HAVE CAUGHT IT. No test, no checker, no');
  w('   CI step and no eval reads the model string; `npm test` passes green with');
  w('   the feature entirely dead. check:blocks verifies that commands run and');
  w('   paths resolve — a retired third-party identifier is neither.');
  w('');
  w('   Fixing it is a PRODUCT decision (which model the app should ship) and is');
  w('   deliberately not taken by this measurement session. ROADMAP Phase 5.');
  w('');

  finish(out);
}

function finish(out) {
  const text = `${out.join('\n')}\n`;
  process.stdout.write(text);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUT, text);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
