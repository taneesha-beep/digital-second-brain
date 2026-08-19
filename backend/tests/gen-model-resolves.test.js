'use strict';

/**
 * gen-model-resolves.test.js — Phase 5.0.
 *
 * THE ONE CHECK IN THIS REPOSITORY THAT RE-MEASURES AN EXTERNAL DEPENDENCY.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS, WHICH IS A CLASS §27 DID NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * `services/llm.service.js` hardcoded `llama-3.3-70b-versatile`. Groq retired
 * it. All five AI features returned a 500 to every user for an unknown number
 * of days, and NOTHING NOTICED: no test, no checker and no CI step read the
 * model string, so `npm test` passed green with the feature entirely dead
 * (`results/gen-model-retired.txt`, §28).
 *
 * §27 diagnosed documentation staleness as attention going where changes are,
 * and prescribed a change-triggered habit. §28.11 recorded why that is not
 * enough here: THESE FACTS WERE TRUE WHEN WRITTEN AND BECAME FALSE WITH THE
 * REPOSITORY UNTOUCHED. There is no change to trigger on. The only instrument
 * that catches it is one that goes and asks, which is this file.
 *
 * ---------------------------------------------------------------------------
 * IT COSTS NO QUOTA, AND THAT IS WHY IT CAN BE A TEST AT ALL
 * ---------------------------------------------------------------------------
 *
 * Groq's free tier is 200,000 tokens per DAY (§28.6), so a check that burned a
 * completion on every `npm test` would be a check nobody could afford to keep.
 * `models.list()` consumes NO completion tokens — and it is also the
 * discriminating signal, because it is exactly how 5.3 separated a retirement
 * (key works, model absent) from an auth failure (key does not work). The
 * cheap call and the correct call are the same call.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT RUNS, AND THE GAP THAT REMAINS
 * ---------------------------------------------------------------------------
 *
 * Locally, whenever GROQ_API_KEY is exported. It SKIPS LOUDLY otherwise —
 * helpers/preconditions.js prints what it skipped and why, because a skipped
 * test looks exactly like a passing one.
 *
 * NOT IN CI. It needs a network and a key; .github/workflows/ci.yml sets no
 * GROQ_API_KEY and does not promise this precondition, so ci-scope.test.js's
 * unpromised-must-be-absent direction passes and the promised-skip ledger does
 * not move.
 *
 * THE GAP, STATED RATHER THAN PAPERED OVER: this check is not automatic.
 * Nobody is forced to run it, so a future retirement is caught the next time a
 * person exports a key — not the day it happens. Closing that means a
 * scheduled workflow holding GROQ_API_KEY as a repository secret, which is a
 * decision about putting a live credential in CI on a public repository and
 * belongs to the repository owner. §29.3.
 */

const { describeWith } = require('./helpers/preconditions');
const live = require('../services/llm.service');

// Pure, keyless, network-free: these hold on every run including CI.
describe('the shipped model string is readable without a network', () => {
  test('llm.service.js exports the model it asks for', () => {
    // Before 5.0 this constant was module-local and exported by nothing, which
    // is the mechanical reason no check could read it. ROADMAP's 5.2/5.3
    // noticed list asked for the export; this is what wanted it.
    expect(typeof live.MODEL).toBe('string');
    expect(live.MODEL.length).toBeGreaterThan(0);
  });

  test('it is not the retired string', () => {
    // A regression guard on Phase 5.0 itself. This one costs nothing and runs
    // everywhere, but note what it CANNOT do: it knows one dead model by name.
    // It would not notice gpt-oss-120b being retired tomorrow. Only the
    // network check below can, and only when someone runs it.
    expect(live.MODEL).not.toBe('llama-3.3-70b-versatile');
  });
});

describeWith('groq', 'the shipped model still resolves at Groq', () => {
  const Groq = require('groq-sdk');

  let reachable = null;
  let listError = null;

  beforeAll(async () => {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0 });
    try {
      const list = await groq.models.list();
      reachable = list.data.map((m) => m.id).sort();
    } catch (err) {
      listError = err;
    }
  }, 30000);

  test('the key authenticates', () => {
    // Asserted separately from the model check so a failure says WHICH thing
    // broke. 5.3's whole finding rested on this distinction: a 404 on the
    // completion plus a 200 on models.list() means retirement, and a 401 on
    // both means somebody rotated a key.
    expect(listError).toBeNull();
    expect(Array.isArray(reachable)).toBe(true);
    expect(reachable.length).toBeGreaterThan(0);
  });

  test('the model llm.service.js asks for is one the key can reach', () => {
    if (listError) throw listError;
    // The failure message carries the whole list, because "not found" without
    // the alternatives sends the reader to a dashboard to do it by hand.
    expect(reachable).toContain(live.MODEL);
  });
});
