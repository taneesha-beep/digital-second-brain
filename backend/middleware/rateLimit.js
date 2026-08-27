'use strict';

/**
 * rateLimit.js — the last item outstanding from Phase 0.3 (31 Jul 2026),
 * deferred to Phase 5 and built 25 Aug 2026, immediately before the redeploy.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 0.3's DONE CRITERION IS EXTENDED HERE, AND THE EXTENSION IS THE POINT.
 *
 * Verbatim, 0.3 asked for: "/api/llm/* returns 429 with Retry-After past the
 * limit." That sentence was written on 31 Jul 2026. Study Pack did not exist
 * until 5.1 on 19 Aug 2026, and services/studyPack.service.js constructs its
 * OWN `new Groq()` rather than going through services/llm.service.js — so
 * POST /api/study-pack/:noteId spends organisation quota on a code path
 * /api/llm/* does not cover.
 *
 * IT IS ALSO THE EXPENSIVE ONE. results/studypack-constants.txt §C:
 *
 *     reserved per study pack    5508 tokens   (prompt + max_tokens 4096)
 *     mean single-note prompt    290 tokens    (+ max_tokens 2048 = ~2338)
 *     study packs per day        36            against the 200000 cap
 *
 * So satisfying 0.3 as written would have left the costliest endpoint open
 * while the checkbox read done — a criterion that is true and no longer
 * sufficient, which is the same shape as every other stale sentence this
 * repository keeps finding. Both routes are covered.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND IT IS NOT A BILLING RISK.
 *
 * Groq's free tier bills $0.00 and the real invoice is $0.00 — PRIMER §8.3 and
 * results/studypack-cost.txt both say so, at length. Nothing here protects
 * money.
 *
 * What it protects is a MEASUREMENT. The 200,000 tokens/day cap is charged per
 * ORGANISATION (§30.1, and the 429 body names the org id), and it is the same
 * budget every `gen:*` eval run draws on. An unlimited public LLM endpoint
 * therefore means a stranger's traffic can exhaust the quota an eval run needs,
 * and the run stops partway with a 429 that looks exactly like the five runs
 * this project has already lost to its own pacing. It would be diagnosed as a
 * quota bug rather than as abuse. That is a research-integrity problem.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NO BYPASS FOR THE EVAL HARNESS, AND NONE IS NEEDED.
 *
 * PRIMER §7.3 anticipated the awkward interaction — "your own harness hammering
 * your own API looks exactly like an attacker to your own limiter" — and named
 * two ways out: a bypass, or a harness that calls the generator directly rather
 * than over HTTP. It is already the second: no script under backend/scripts/
 * makes an HTTP request to this app; run-studypack-eval.js calls
 * services/studyPack.service.js and run-judge-eval.js calls the Groq SDK. So
 * every limiter here is invisible to every eval run, by construction rather
 * than by an exemption somebody has to remember to keep working.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THREE LIMITERS, AND ONLY ONE OF THE THREE NUMBERS IS DERIVED.
 *
 * PER-USER (llmLimiter, studyPackLimiter) — PICKED, NOT DERIVED, and this file
 * says which because §35 established that a document quoting a chosen constant
 * as if it were measured is worse than one that quotes nothing. A study pack's
 * p50 is 4,870 ms (ROADMAP 5.4 / §32), so six in fifteen minutes is far past
 * any human's pace through the UI and nowhere near a loop's. Nothing measured
 * these; they are blast-radius numbers.
 *
 * GLOBAL (quotaDailyLimiter) — DERIVED, and it is the only layer that actually
 * bounds the organisation cap. Per-user limits do not: registration is open, so
 * N accounts multiply any per-user number by N. The arithmetic, from
 * results/studypack-constants.txt §C:
 *
 *     18 requests x 5508 reserved tokens = 99144
 *     99144 / 200000 = 49.6% of the daily organisation cap
 *
 * — so even in the worst case, where every one of the 18 is a study pack rather
 * than a cheaper single-note call, over half the day's quota is still there for
 * an eval run. That is the guarantee; 18 is the largest integer that keeps it.
 *
 * THE GLOBAL LIMITER'S COST IS REAL AND IS TAKEN DELIBERATELY: a budget shared
 * across all users means one user can exhaust it for everybody, including a
 * recruiter opening the demo. That trade is accepted because the resource being
 * protected is ITSELF shared — a per-user bound on a per-organisation cap is
 * not a bound at all. Decided by the repository owner, 25 Aug 2026.
 *
 * ORDER: PER-USER FIRST, GLOBAL SECOND, and it is not cosmetic. A request the
 * per-user limiter rejects never reaches the global one, so an abuser burns
 * their own quota before touching the shared budget. Reversed, one looping
 * client would spend the day's global allowance in a minute and lock out
 * everybody while their own counter sat at 18.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE KEY IS THE AUTHENTICATED USER, WHICH IS WHY THESE MOUNT INSIDE THE
 * ROUTERS RATHER THAN IN server.js.
 *
 * Both routers call `router.use(protect)` on their first line, so mounting the
 * limiter after it puts req.user in scope. Two consequences:
 *
 *   1. An unauthenticated flood is NOT limited by this, and does not need to
 *      be: `protect` 401s before any handler runs, so it reaches no model and
 *      spends no quota.
 *   2. `req.ip` is not load-bearing. THAT IS WHY server.js DOES NOT SET
 *      `trust proxy`. Behind Railway's edge, `req.ip` is the proxy's address
 *      unless Express is told how many hops to trust, and getting that number
 *      wrong lets a client spoof X-Forwarded-For and forge its own key. Since
 *      the key here is a user id that came out of a verified JWT, the correct
 *      move is to leave a security-relevant setting alone rather than guess a
 *      hop count. The IP branch below is the fallback for a mount that has no
 *      `protect` in front of it; on these two routes it is unreachable.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO, STATED SO A 429 IS NOT READ AS MORE THAN IT IS.
 *
 *   - THE STORE IS IN-PROCESS MEMORY AND RESETS ON RESTART. Railway restarts on
 *     every deploy and on its own restart policy (railway.json:
 *     restartPolicyMaxRetries 3), so the 24-hour global window is a 24-hour
 *     window OF ONE PROCESS LIFETIME, not of a day. A redeploy hands back the
 *     full budget. Fixing that means a shared store, which means Redis, and
 *     PRIMER §11's argument against adding Redis for an unmeasured problem
 *     applies unchanged — the app has five users and has never been deployed
 *     with any limiter at all. Named, not fixed.
 *   - IT COUNTS REQUESTS, NOT TOKENS. A study pack and a one-line summarize
 *     cost the same against their own limiter, which is why the two per-route
 *     limits differ rather than sharing one. The global limiter prices its
 *     bound at the WORST case (all study packs) for exactly this reason.
 *   - IT IS NOT AN ABUSE DEFENCE. Open registration means an attacker willing
 *     to create accounts still gets the per-user limit N times. The global
 *     limiter is what stops that reaching the quota, and it stops it by
 *     refusing everybody — a denial of service is the failure mode this
 *     converts a quota exhaustion into. That is the better failure, not a
 *     fixed one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DEPENDENCY, MEASURED RATHER THAN ESTIMATED.
 *
 * `express-rate-limit@8.6.2`, pinned exactly. Backend `dependencies` goes
 * 11 -> 12, the first non-OpenTelemetry app dependency in many phases. Read
 * from the two lockfiles rather than from `npm view`: the PRODUCTION tree goes
 * 144 -> 146 packages, and the two are `express-rate-limit` and `ip-address`.
 * Its other two declared dependencies cost nothing new — `debug@4.4.3` was
 * already there via mongoose -> mquery, and `ms@2.1.3` via jsonwebtoken. All
 * four are MIT; `npm audit --omit=dev` reports 0 vulnerabilities, which is where
 * the 25 Aug post-build audit left the backend.
 *
 * Hand-rolling was the alternative and is rejected on two grounds. ROADMAP 0.3
 * names this library by name, so hand-rolling would be deviating from the plan
 * to save a dependency the plan already budgeted; and a hand-rolled fixed
 * window has to get IPv6 key normalisation, store eviction and the trust-proxy
 * footgun right, which is the part of this that is genuinely easy to get wrong.
 * §17.1 is untouched either way: it is a claim about the EVAL path, and no eval
 * script imports this file.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Every constant in one exported object so the tests and the writeups pin ONE
 * copy. A limit that is written down in three places is a limit that will
 * disagree with itself.
 */
const LIMITS = {
  /**
   * Per user, /api/llm. PICKED — but BOUNDED, and the bound was found by a test
   * rather than by thinking about it. The first draft set this to 20, which is
   * ABOVE quotaDaily.max, so the shared limiter always refused first and this
   * limiter could never fire at all: twenty lines of dead configuration that
   * looked like a control. The invariant is
   *
   *     studyPack.max  <  llm.max  <  quotaDaily.max
   *
   * — a per-user limit at or above the global one is unreachable, and a
   * per-user limit equal to the global one lets a single account take the whole
   * shared budget in one burst. tests/rate-limit.test.js asserts both
   * inequalities, because neither is visible by reading a number.
   */
  llm: { windowMs: 15 * 60 * 1000, max: 10 },
  /** Per user, /api/study-pack. PICKED, lower because a pack costs ~2.4x. */
  studyPack: { windowMs: 15 * 60 * 1000, max: 6 },
  /**
   * Shared by EVERY user across BOTH routes. DERIVED — see the header:
   * 18 x 5508 reserved tokens = 99144, which is 49.6% of the 200000/day
   * organisation cap, so half the day survives for an eval run in the worst
   * case.
   */
  quotaDaily: { windowMs: 24 * 60 * 60 * 1000, max: 18 }
};

/**
 * The authenticated user, falling back to the client address.
 *
 * ipKeyGenerator() rather than req.ip directly: an IPv6 client gets a fresh
 * address per request from a /64 it owns, so keying on the raw address is a
 * limiter that never fires. The library exports the subnet-collapsing helper
 * for exactly this, and validates that a custom key generator uses it.
 */
function identityKey(req) {
  const userId = req.user && req.user.id ? String(req.user.id) : null;
  if (userId) return `user:${userId}`;
  return `ip:${ipKeyGenerator(req.ip || '')}`;
}

/**
 * The 429 body, in the app's own shape.
 *
 * frontend/src/components/llm/AIPanel.jsx:104 reads
 * `err?.response?.data?.message`, so a plain-text body — which is
 * express-rate-limit's default — would render as the generic axios message and
 * tell the user nothing. Retry-After is set by the library itself whenever
 * either header mode is on; `standardHeaders: 'draft-8'` below is what turns it
 * on, and a test asserts the header rather than trusting this comment.
 */
function refuse(message) {
  return (req, res) => {
    const retryAfter = res.getHeader('Retry-After');
    res.status(429).json({
      message,
      retryAfterSeconds: retryAfter === undefined ? null : Number(retryAfter)
    });
  };
}

function build({ windowMs, max }, { key, message }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: key,
    handler: refuse(message)
  });
}

/** Per user, on POST /api/llm/:noteId/:feature. */
const llmLimiter = build(LIMITS.llm, {
  key: identityKey,
  message:
    'Too many AI requests. This app shares one Groq quota with its evaluation ' +
    'runs, so each account is limited to ' + LIMITS.llm.max + ' AI requests every 15 minutes. ' +
    'Try again shortly.'
});

/** Per user, on POST /api/study-pack/:noteId. */
const studyPackLimiter = build(LIMITS.studyPack, {
  key: identityKey,
  message:
    'Too many study packs. A study pack reserves about 5,500 tokens against a ' +
    'shared daily quota, so each account is limited to ' + LIMITS.studyPack.max + ' every 15 minutes. ' +
    'Try again shortly.'
});

/**
 * ONE budget for the whole application, across both routes and every user.
 *
 * The constant key is the entire mechanism: collapsing every identity into one
 * bucket is what makes this a bound on the ORGANISATION cap rather than a bound
 * per person. Do not "fix" it to identityKey — that silently turns the only
 * derived limit in this file into a third picked one.
 */
const quotaDailyLimiter = build(LIMITS.quotaDaily, {
  key: () => 'quota:global',
  message:
    'This demo has used its shared daily AI budget. The app runs on a free Groq ' +
    'tier whose quota is shared with the project\'s evaluation runs, so total AI ' +
    'requests are capped at ' + LIMITS.quotaDaily.max + ' per day across all users. Try again tomorrow.'
});

module.exports = {
  LIMITS,
  identityKey,
  llmLimiter,
  studyPackLimiter,
  quotaDailyLimiter
};
