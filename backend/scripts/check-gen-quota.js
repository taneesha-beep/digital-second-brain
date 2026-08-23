#!/usr/bin/env node
'use strict';

/**
 * check-gen-quota.js — Phase 5.5. How much Groq budget is left, before spending it.
 *
 *   npm run gen:quota
 *
 * WRITTEN BECAUSE TWO SESSIONS IN A ROW LOST A RUN TO A LIMIT THEY COULD NOT SEE.
 * 5.3 stopped at 234 of 330 cells and 5.5 at 78 of 150. Both times the answer was
 * knowable BEFORE the run and was discovered by walking into it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS ABOUT THIS CAP THAT ARE NOT WHAT YOU WOULD GUESS
 * ---------------------------------------------------------------------------
 *
 *   1. IT IS PER ORGANISATION, NOT PER KEY. Issuing a fresh key inherits the old
 *      key's spend. 5.5 lost a run this way — the key was replaced mid-session
 *      and the budget did not move.
 *   2. IT IS A ROLLING 24-HOUR WINDOW, NOT A DAILY RESET. It frees continuously
 *      as old spend ages out, at roughly one call per 7-14 minutes when full.
 *   3. THE PER-MINUTE LIMIT IS CHARGED ON WHAT A CALL RESERVES, NOT ON WHAT IT
 *      USES. max_tokens 64 with a 54-token completion decremented the remaining
 *      budget by exactly 64. So raising max_tokens lowers throughput even when
 *      output length does not move.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS COSTS A CALL, AND WHY IT CANNOT BE FREE
 * ---------------------------------------------------------------------------
 *
 * No `x-ratelimit-*` header exposes the daily budget (§28.6) — they describe the
 * per-minute window only. The daily figure appears in exactly one place: the
 * BODY of a 429. So the only way to read it is to ask for something and see what
 * comes back, and the only way to get an exact number is to be refused.
 *
 * Hence two outcomes, and both are useful:
 *
 *   ALLOWED  -> a call at the shipped ceiling fits right now. The exact
 *               remaining balance is NOT knowable; the floor is.
 *   REFUSED  -> the body carries `Limit`, `Used` and a retry hint, which is the
 *               precise answer. Being refused is the informative case.
 *
 * The probe reserves the shipped max_tokens but caps what it actually generates,
 * so it charges the per-minute window a realistic amount and the daily window
 * almost nothing.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Groq = require('groq-sdk');
const live = require('../services/llm.service');
// 5.9: the study pack reserves on its OWN ceiling, which is not llm.service's.
const studyPack = require('../services/studyPack.service');

const DAILY_LIMIT = 200000; // measured, free tier — see the 429 body

function parseRetry(text) {
  const m = /try again in ((?:(\d+)m)?([\d.]+)s)/i.exec(String(text || ''));
  if (!m) return null;
  return (Number(m[2] || 0) * 60 + Number(m[3])) * 1000;
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error('MISSING GROQ_API_KEY — it lives in backend/.env.');
    process.exit(1);
  }

  console.log('GROQ QUOTA — asked, not guessed\n');
  console.log(`  model         ${live.MODEL}`);
  console.log(`  max_tokens    ${live.MAX_TOKENS}   (what each single-note call RESERVES)`);
  console.log(`  study pack    ${studyPack.STUDY_PACK_MAX_TOKENS}   ITS OWN CEILING SINCE 5.9 — a study pack reserves ~${
    studyPack.CONTEXT_TOKEN_BUDGET + studyPack.STUDY_PACK_MAX_TOKENS}`);
  console.log(`  daily limit   ${DAILY_LIMIT} tokens, per ORGANISATION, rolling 24h\n`);

  const groq = new Groq({ apiKey, maxRetries: 0 });
  try {
    await groq.chat.completions.create({
      model: live.MODEL,
      // Reserve what a real call reserves, generate almost nothing.
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: live.MAX_TOKENS,
      temperature: 0
    });
    console.log('  ALLOWED — a call at the shipped ceiling fits right now.');
    console.log('');
    console.log('  The EXACT balance is not knowable while you are under the cap: no header');
    console.log('  carries it and the body only appears on a 429. What this establishes is a');
    console.log('  floor, not a figure. Start the run and let the ledger absorb a stop.');
    process.exitCode = 0;
  } catch (err) {
    const raw = String((err && err.cause && err.cause.message) || (err && err.message) || '');
    const m = /Limit (\d+), Used (\d+)/.exec(raw);
    const daily = /tokens per day|TPD/i.test(raw);
    const retryMs = parseRetry(raw);

    console.log(`  REFUSED — ${daily ? 'DAILY (TPD)' : 'per-minute'} limit reached.`);
    console.log('');
    if (m) {
      const limit = Number(m[1]);
      const used = Number(m[2]);
      console.log(`    limit       ${limit}`);
      console.log(`    used        ${used}`);
      console.log(`    remaining   ${limit - used}`);
    }
    if (retryMs) {
      console.log(`    frees in    ~${Math.round(retryMs / 60000)} min, for ONE call`);
    }
    console.log('');
    console.log('  A rolling window frees continuously, so a full run needs a BLOCK of the');
    console.log('  previous day\'s spend to age out — roughly 24h after it was spent, not at');
    console.log('  any clock boundary. A NEW API KEY WILL NOT HELP: the cap is per');
    console.log('  organisation and a fresh key inherits this balance.');
    process.exitCode = 1;
  }

  console.log('');
  console.log('  Resume a partial run with:  npm run gen:v2 -- --run --take N');
  console.log('  Nothing completed is ever lost; the ledger resumes.');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
