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
 *      `trust proxy`. Behind a platform edge, `req.ip` is the proxy's address
 *      unless Express is told how many hops to trust, and getting that number
 *      wrong lets a client spoof X-Forwarded-For and forge its own key. Since
 *      the key here is a user id that came out of a verified JWT, the correct
 *      move is to leave a security-relevant setting alone rather than guess a
 *      hop count. The IP branch below is the fallback for a mount that has no
 *      `protect` in front of it; on these two routes it is unreachable.
 *
 *      HOST CHANGED 26 Aug 2026: RAILWAY -> RENDER, AND THE ARGUMENT GOT
 *      STRONGER RATHER THAN STALE. This paragraph used to name Railway's edge.
 *      The reasoning is unchanged — it was never about which vendor — but the
 *      hop count is now measurably worse to guess at. Response headers from
 *      https://digital-second-brain.onrender.com carry BOTH
 *      `x-render-origin-server: Render` and `server: cloudflare`, so there are
 *      at least two proxies in front of Express, not one. A `trust proxy` of 1
 *      would be wrong and a guess of 2 is still a guess. Unchanged conclusion:
 *      do not set it. See the registration limiter at the bottom of this file,
 *      which needed an IP key, could not have one for exactly this reason, and
 *      is keyed globally instead.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO, STATED SO A 429 IS NOT READ AS MORE THAN IT IS.
 *
 *   - THE STORE IS IN-PROCESS MEMORY AND RESETS ON RESTART. Render restarts the
 *     process on every deploy, exactly as Railway did, so the 24-hour global
 *     window is a 24-hour window OF ONE PROCESS LIFETIME, not of a day. A
 *     redeploy hands back the full budget.
 *
 *     AND ON RENDER THAT IS SHARPER THAN IT WAS, BECAUSE AUTO-DEPLOY IS ON.
 *     The service redeploys on every commit to `main`, so **any push to main
 *     resets every counter in this file** — including the 24-hour global
 *     budget. The reset is no longer an operator action somebody would
 *     remember doing; it is a side effect of merging a README typo. Whoever
 *     reads a 429 in production should check the last deploy time before
 *     concluding the budget was genuinely spent.
 *
 *     Fixing that means a shared store, which means Redis, and PRIMER §11's
 *     argument against adding Redis for an unmeasured problem applies
 *     unchanged. The clause that used to sit here — "the app has five users
 *     and has never been deployed with any limiter at all" — is FALSE as of
 *     26 Aug 2026: it is deployed, with these limiters, and this is the first
 *     production traffic they have ever seen. Named, not fixed, and the reason
 *     is now that no measurement of the restart's effect exists rather than
 *     that no deployment did.
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
 * A FOURTH LIMITER, ADDED 27 Aug 2026, ON A SURFACE THAT DID NOT MATTER UNTIL
 * THE APP WAS PUBLIC.
 *
 * POST /api/auth/register had no limit. On an undeployed app that was a
 * non-issue; on a public one it is the mechanism this header already names as
 * a residual it does not close — "open registration means an attacker willing
 * to create accounts still gets the per-user limit N times".
 *
 * WHAT IT IS NOT: a quota fix. quotaDailyLimiter already bounds the Groq
 * organisation cap absolutely, and it does so with a key that does not care how
 * many accounts exist. Registration was never a hole in that bound and closing
 * it does not tighten one. Anyone reading this as the quota defence has the
 * wrong limiter.
 *
 * WHAT AN ACCOUNT ACTUALLY COSTS, so the limit is not sized against a fear:
 *
 *     user document, BSON       193 bytes minimum, 270 typical
 *     password hash             60 of those bytes, fixed, whatever the password
 *     CPU per registration      65.5 ms  (bcryptjs 2.4.3 genSalt(10) + hash,
 *                               mean of 10, laptop: Darwin 25.6.0 arm64,
 *                               Node v25.8.1 — a smaller instance is slower)
 *
 * The 193 comes from serializing the smallest document models/User.js will
 * accept; both figures are reproducible with one `BSON.serialize()` call and
 * neither includes index entries. At that size, filling a free-tier Atlas
 * cluster takes accounts by the million, so STORAGE IS NOT THE BINDING
 * CONSTRAINT and a limit sized to protect it would be theatre. bcryptjs 2.4.3
 * is pure JS but its async path yields through setImmediate — measured
 * event-loop lag during one hash was 0.0 ms — so a flood is CPU pressure on a
 * shared instance, NOT the event-loop stall it would be with the sync API.
 *
 * SO THE LIMIT IS PICKED, AND UNLIKE llm AND studyPack IT COULD NOT HAVE BEEN
 * DERIVED. quotaDaily is derived because there is a hard external cap to divide
 * by. Here there is none: storage does not bind, quota is already bound
 * elsewhere, and CPU has no published ceiling on this plan. 20 per hour is a
 * blast-radius number chosen so the consequences above stay negligible — 480
 * accounts a day is ~93 KB of documents and ~1.3 s of CPU per hour — and a
 * WINDOW OF ONE HOUR rather than a day is the deliberate half of it. A 24-hour
 * shared window on the front door would let one attacker close signup until
 * tomorrow.
 *
 * THE KEY IS CONSTANT, AND THAT IS FORCED RATHER THAN CHOSEN.
 * /api/auth/register runs BEFORE `protect` — it is the route that creates the
 * user — so req.user.id does not exist and identityKey() would fall through to
 * its IP branch. An IP key needs `trust proxy`, which is the question the
 * mounting section above declines to answer. RE-OPENED HERE ON PURPOSE AND
 * DECLINED AGAIN, with the reason now measured rather than assumed: the
 * deployed host returns both `x-render-origin-server: Render` and
 * `server: cloudflare`, so Express sits behind AT LEAST TWO proxies. A hop
 * count of 1 is wrong and 2 is a guess, and a WRONG guess is worse than no
 * limiter at all — it is bypassed by setting one header, while a real visitor
 * sharing a NAT with the attacker is locked out. TRIGGER TO REVISIT: an
 * endpoint on the deployed host that echoes the resolved req.ip, so the hop
 * count is read rather than guessed. Until that exists, constant key.
 *
 * /api/auth/login IS DELIBERATELY NOT LIMITED, AND IT IS NOT AN OVERSIGHT.
 * A constant key is tolerable on register because registration is a
 * once-per-lifetime action: a shared budget costs a new visitor a wait. Login
 * is per-session, so the SAME limiter would convert one credential-stuffing
 * attempt into a full outage for every existing user — a strictly worse failure
 * than the one it prevents. What login actually wants is a per-identity bound,
 * and its only honest keys are the IP (declined above) or the submitted email
 * (attacker-controlled and free to rotate, so it bounds nothing). Declined with
 * the same trigger: settle `trust proxy` by measurement and login gets an
 * IP-keyed limiter.
 *
 * IT IS OUTSIDE THE studyPack < llm < quotaDaily INVARIANT, ON PURPOSE. That
 * chain exists because those three limiters compete for one shared budget on
 * two routes, so an unreachable rung is dead configuration. register shares
 * nothing with them — different route, different key space, different resource
 * — so comparing its number to theirs is meaningless. Do not "restore" the
 * ordering by folding it in; tests/rate-limit.test.js pins that it is excluded.
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
  quotaDaily: { windowMs: 24 * 60 * 60 * 1000, max: 18 },
  /**
   * Shared by every visitor, on POST /api/auth/register only. PICKED, and see
   * the header for why it could not be derived: nothing it protects has a cap
   * tight enough to divide by. The ONE-HOUR window is the load-bearing half —
   * a shared budget on the front door has to give itself back quickly.
   *
   * NOT part of the studyPack < llm < quotaDaily invariant. Different route,
   * different key space, different resource.
   */
  register: { windowMs: 60 * 60 * 1000, max: 20 }
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

/**
 * THE LIMITER FACTORY, AND IT REFUSES AN OPTION IT WOULD NOT HONOUR.
 *
 * ⚠️ IT USED TO DROP THEM SILENTLY, AND A MUTATION FOUND THAT BY PASSING.
 * It destructures `{windowMs, max}` and `{key, message}` and constructs
 * rateLimit() explicitly, so a caller adding `skip`, `skipSuccessfulRequests`,
 * `store` or a misspelled `windowMS` got NO error and NO effect. At 8.0 a
 * deliberate mutation MATCHED ITS PATTERN AND CHANGED NO BEHAVIOUR for exactly
 * this reason — the mutation added an option, the option was discarded, and the
 * test correctly stayed green about a limiter that had not moved. The mutation
 * pass reported a catch it had not made.
 *
 * A NARROW FACTORY IS THE RIGHT DESIGN AND SILENCE IS NOT PART OF IT. The four
 * limiters here should differ in exactly two axes — the numbers and the key —
 * and forwarding arbitrary options would let a fifth quietly acquire a `store`
 * or a `skip` that nothing in the test suite knows to look for. So unknown
 * options are REFUSED rather than forwarded: the narrowness is kept and the
 * silence is removed.
 *
 * IT THROWS AT MODULE LOAD, WHICH IS THE POINT AND ALSO THE RISK. server.js
 * requires this file at boot, so a caller mistake is a dead process rather than
 * a quiet misconfiguration in production. That is the correct trade for a
 * limiter — a rate limiter that silently is not limiting is the failure this
 * whole file exists to prevent — and it is why this change went to a branch
 * rather than to `main`, which auto-deploys on commit.
 */
const LIMIT_KEYS = ['windowMs', 'max'];
const BEHAVIOUR_KEYS = ['key', 'message'];

function build(limits, behaviour) {
  // Checked BEFORE destructuring, so a typo cannot present as `undefined` and
  // sail into rateLimit() as a missing option.
  for (const [label, given, allowed] of [
    ['limits', limits, LIMIT_KEYS],
    ['behaviour', behaviour, BEHAVIOUR_KEYS]
  ]) {
    const unknown = Object.keys(given || {}).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      throw new TypeError(
        `rateLimit build(): unknown ${label} option(s) ${unknown.join(', ')}. ` +
        `This factory honours exactly ${allowed.join(', ')} and would have DISCARDED ` +
        'the rest silently. Add it here deliberately, or drop it.'
      );
    }
    for (const k of allowed) {
      if (given === null || given === undefined || given[k] === undefined) {
        throw new TypeError(`rateLimit build(): missing ${label} option ${k}.`);
      }
    }
  }

  const { windowMs, max } = limits;
  const { key, message } = behaviour;
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

/**
 * ONE budget for account creation, across every visitor.
 *
 * Mounted in routes/auth.js on the /register route SPECIFICALLY, not with
 * router.use() — that router has no `protect` on it and a router-level mount
 * would catch /login too, which the header explains is the wrong trade.
 *
 * The constant key is forced, not chosen: this route runs before any
 * authentication exists, and the alternative key is an IP that cannot be
 * trusted behind two proxies. Do not "fix" it to identityKey — on this route
 * identityKey falls through to its IP branch, which is exactly the thing the
 * header declines to rely on.
 */
const registerLimiter = build(LIMITS.register, {
  key: () => 'register:global',
  message:
    'This demo limits how many new accounts can be created each hour across ' +
    'all visitors, because it runs on a free tier and cannot safely rate-limit ' +
    'by address behind its proxy. Please try again shortly — if you already ' +
    'have an account, signing in is not affected.'
});

module.exports = {
  LIMITS,
  identityKey,
  // Exported ONLY so tests/rate-limit.test.js can drive the refusal directly.
  // The four limiters below are the real interface; nothing else calls this.
  build,
  llmLimiter,
  studyPackLimiter,
  quotaDailyLimiter,
  registerLimiter
};
