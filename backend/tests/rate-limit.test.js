'use strict';

/**
 * rate-limit.test.js — Phase 0.3's last item, built 25 Aug 2026.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * PURE. No database, no API key, no network beyond a loopback socket, no
 * gitignored data/. It therefore needs no precondition and does not move the
 * skip ledger, which has stood at 69 / 6 / 3 since 4.5.
 *
 * IT SPENDS NO GROQ QUOTA AND CANNOT. The limiters run BEFORE the handlers, so
 * nothing here reaches services/llm.service.js or services/studyPack.service.js
 * at all — the app assembled below mounts a stub handler, and the route files
 * are only ever READ.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT DRIVES THE REAL LIMITER OBJECTS, NOT COPIES OF THE CONFIG.
 *
 * §38.6's lesson from 6.2: a test that rebuilds the thing it is testing proves
 * the rebuild works. So the behavioural half imports the exact instances
 * routes/llm.js and routes/studyPack.js mount, drives them over a real socket
 * with Node's built-in fetch — the supertest-free idiom
 * tests/integration.app.test.js established — and resets their stores between
 * tests rather than constructing fresh ones.
 *
 * WHICH MEANS RESET DISCIPLINE IS PART OF THE SUITE. A limiter is stateful and
 * process-wide; a test that exhausts one and does not reset it poisons every
 * test after it. Every block that spends budget resets what it spent, and the
 * first assertion of the file proves the reset mechanism itself works — an
 * unproven reset would make later passes vacuous in the direction that looks
 * green.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE STRUCTURAL HALF READS SOURCE, AND STRIPS COMMENTS FIRST.
 *
 * 6.3 found that these files' comments name the identifiers the assertions look
 * for — `fireDetached(` appeared three times in routes/notes.js and only one was
 * a call. The same trap is live here and worse: middleware/rateLimit.js's header
 * and both routers' comments say `llmLimiter`, `studyPackLimiter` and
 * `quotaDailyLimiter` many times in prose. A raw substring search would pass on
 * a file where every mount had been deleted and only the explanation left.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const {
  LIMITS,
  identityKey,
  llmLimiter,
  studyPackLimiter,
  quotaDailyLimiter,
  registerLimiter
} = require('../middleware/rateLimit');

const BACKEND = path.resolve(__dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

/**
 * An app that mounts the given limiters behind a stub that plays the part of
 * `protect`: it sets req.user from a header so a test can be several different
 * users without a database, a JWT or a User model.
 *
 * The stub is deliberately NOT the real `protect` — that one needs mongoose —
 * and the structural half below is what closes the resulting gap by asserting
 * the real routers put the real `protect` in front of the real limiters.
 */
function appWith(...limiters) {
  const app = express();
  app.use((req, res, next) => {
    const id = req.get('x-test-user');
    if (id) req.user = { id };
    next();
  });
  for (const limiter of limiters) app.use(limiter);
  app.use((req, res) => res.status(200).json({ ok: true }));
  return app;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function hit(base, user) {
  const response = await fetch(`${base}/anything`, {
    method: 'POST',
    headers: user ? { 'x-test-user': user } : {}
  });
  let body = null;
  const text = await response.text();
  try { body = JSON.parse(text); } catch { /* the default handler sends text */ }
  return {
    status: response.status,
    body,
    text,
    retryAfter: response.headers.get('retry-after'),
    standard: response.headers.get('ratelimit')
  };
}

/**
 * Every key any test in this file spends, so afterEach can hand it all back.
 * Listed rather than derived: a limiter has no API for "which keys have you
 * seen", and an untracked key is a leak into the next test.
 */
const SPENT = [];
function spend(limiter, key) {
  SPENT.push([limiter, key]);
  return key;
}

afterEach(() => {
  while (SPENT.length) {
    const [limiter, key] = SPENT.pop();
    limiter.resetKey(key);
  }
});

// ───────────────────────────────────────────────────────────────────────────

describe('the harness itself, before anything rests on it', () => {
  test('resetKey really returns budget — otherwise every later pass is suspect', async () => {
    const key = spend(studyPackLimiter, 'user:reset-probe');
    const { server, base } = await listen(appWith(studyPackLimiter));
    try {
      for (let i = 0; i < LIMITS.studyPack.max; i += 1) {
        expect((await hit(base, 'reset-probe')).status).toBe(200);
      }
      expect((await hit(base, 'reset-probe')).status).toBe(429);

      studyPackLimiter.resetKey(key);

      // If resetKey did nothing this stays 429, and every "N requests pass"
      // assertion in this file would be measuring leftover state instead.
      expect((await hit(base, 'reset-probe')).status).toBe(200);
    } finally {
      server.close();
    }
  });

  test('the stub sets req.user, so identityKey has something to key on', () => {
    expect(identityKey({ user: { id: 'abc' } })).toBe('user:abc');
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe("0.3's criterion, on /api/llm/* — 429 with Retry-After past the limit", () => {
  test(`${LIMITS.llm.max} pass, the next is 429, and it carries Retry-After`, async () => {
    spend(llmLimiter, 'user:llm-criterion');
    spend(quotaDailyLimiter, 'quota:global');
    const { server, base } = await listen(appWith(llmLimiter, quotaDailyLimiter));
    try {
      for (let i = 0; i < LIMITS.llm.max; i += 1) {
        const ok = await hit(base, 'llm-criterion');
        expect(ok.status).toBe(200);
      }

      const refused = await hit(base, 'llm-criterion');

      expect(refused.status).toBe(429);
      // THE HEADER IS THE CRITERION, so it is asserted rather than assumed from
      // the library's defaults. express-rate-limit sets Retry-After only when
      // legacyHeaders or standardHeaders is on, and standardHeaders defaults to
      // false — so this fails if somebody "tidies away" the option.
      expect(refused.retryAfter).not.toBeNull();
      expect(Number(refused.retryAfter)).toBeGreaterThan(0);
      expect(Number(refused.retryAfter)).toBeLessThanOrEqual(LIMITS.llm.windowMs / 1000);
    } finally {
      server.close();
    }
  });

  test('the body is JSON with a `message`, which is the shape AIPanel renders', async () => {
    spend(llmLimiter, 'user:llm-shape');
    spend(quotaDailyLimiter, 'quota:global');
    const { server, base } = await listen(appWith(llmLimiter, quotaDailyLimiter));
    try {
      for (let i = 0; i < LIMITS.llm.max; i += 1) await hit(base, 'llm-shape');
      const refused = await hit(base, 'llm-shape');

      // frontend/src/components/llm/AIPanel.jsx:104 reads
      // err?.response?.data?.message. The library's DEFAULT body is the plain
      // string 'Too many requests, please try again later.', which that
      // expression reads as undefined — the user would see a generic axios
      // message and learn nothing.
      expect(refused.body).not.toBeNull();
      expect(typeof refused.body.message).toBe('string');
      expect(refused.body.message.length).toBeGreaterThan(20);
      expect(refused.body.retryAfterSeconds).toBe(Number(refused.retryAfter));
    } finally {
      server.close();
    }
  });

  test('a draft-8 RateLimit header is present before the limit is reached', async () => {
    spend(llmLimiter, 'user:llm-headers');
    const { server, base } = await listen(appWith(llmLimiter));
    try {
      const first = await hit(base, 'llm-headers');
      expect(first.status).toBe(200);
      expect(first.standard).not.toBeNull();
    } finally {
      server.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the extension: /api/study-pack is covered too, and more tightly', () => {
  test(`${LIMITS.studyPack.max} pass, the next is 429 with Retry-After`, async () => {
    spend(studyPackLimiter, 'user:pack-criterion');
    spend(quotaDailyLimiter, 'quota:global');
    const { server, base } = await listen(appWith(studyPackLimiter, quotaDailyLimiter));
    try {
      for (let i = 0; i < LIMITS.studyPack.max; i += 1) {
        expect((await hit(base, 'pack-criterion')).status).toBe(200);
      }
      const refused = await hit(base, 'pack-criterion');
      expect(refused.status).toBe(429);
      expect(refused.retryAfter).not.toBeNull();
      expect(typeof refused.body.message).toBe('string');
    } finally {
      server.close();
    }
  });

  test('the study-pack limit is STRICTLY tighter than the llm one', () => {
    // Not decoration. results/studypack-constants.txt §C prices a pack at 5508
    // reserved tokens against ~2338 for a single-note feature, so equal limits
    // would mean the expensive route is the one with the loose bound. If a
    // future edit raises studyPack.max to match llm.max, this is what says no.
    expect(LIMITS.studyPack.max).toBeLessThan(LIMITS.llm.max);
    expect(LIMITS.studyPack.windowMs).toBe(LIMITS.llm.windowMs);
  });

  test('EVERY per-user limit is strictly below the global one, or it can never fire', () => {
    // THIS TEST FOUND A REAL DEFECT AND IS NOT HYPOTHETICAL. The first draft set
    // llm.max to 20 against a global max of 18, so the shared limiter always
    // refused first and the per-user llm limiter could not fire under any
    // traffic at all — configuration that reads like a control and is dead.
    // Strictly below, not equal: at equality one account can take the entire
    // shared daily budget in a single fifteen-minute burst.
    for (const name of ['llm', 'studyPack']) {
      expect(LIMITS[name].max).toBeLessThan(LIMITS.quotaDaily.max);
      expect(LIMITS[name].windowMs).toBeLessThan(LIMITS.quotaDaily.windowMs);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the key is the user, so one account cannot refuse another', () => {
  test('exhausting one user leaves a second user untouched', async () => {
    spend(llmLimiter, 'user:noisy');
    spend(llmLimiter, 'user:quiet');
    const { server, base } = await listen(appWith(llmLimiter));
    try {
      for (let i = 0; i < LIMITS.llm.max; i += 1) await hit(base, 'noisy');
      expect((await hit(base, 'noisy')).status).toBe(429);

      // Without a keyGenerator this is 429 too — the default keys on req.ip and
      // both users are 127.0.0.1 here. So this is the assertion that proves the
      // key generator is wired, rather than that a counter exists.
      expect((await hit(base, 'quiet')).status).toBe(200);
    } finally {
      server.close();
    }
  });

  test('identityKey prefers the user and falls back to the address', () => {
    expect(identityKey({ user: { id: '65f0c0ffee' } })).toBe('user:65f0c0ffee');
    expect(identityKey({ ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
    // An IPv6 client draws a fresh address per request out of a /64 it owns, so
    // a raw-address key is a limiter that never fires. ipKeyGenerator collapses
    // the subnet; this asserts the collapse happens rather than trusting it.
    expect(identityKey({ ip: '2001:db8:1:2:3:4:5:6' })).not.toBe('ip:2001:db8:1:2:3:4:5:6');
    expect(identityKey({ ip: '2001:db8:1:2:3:4:5:6' })).toBe(identityKey({ ip: '2001:db8:1:2:ffff:ffff:ffff:ffff' }));
  });

  test('an unauthenticated request keys on the address rather than throwing', () => {
    // Unreachable on both mounted routes, because protect 401s first. It exists
    // so the module is safe if it is ever mounted somewhere without protect,
    // and it is tested because "unreachable" is a claim about today's callers.
    expect(identityKey({})).toMatch(/^ip:/);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the global daily limiter, which is the only DERIVED number here', () => {
  test('it collapses every identity into ONE budget', async () => {
    spend(quotaDailyLimiter, 'quota:global');
    const { server, base } = await listen(appWith(quotaDailyLimiter));
    try {
      // Spend the whole day's budget across as many distinct users as there is
      // budget, one request each. A per-user limiter passes all of them.
      for (let i = 0; i < LIMITS.quotaDaily.max; i += 1) {
        expect((await hit(base, `spender-${i}`)).status).toBe(200);
      }
      // A brand-new user, who has spent nothing, is refused. That is the whole
      // design: the cap being protected is per ORGANISATION, so the limiter
      // bounding it has to be too.
      const stranger = await hit(base, 'never-seen-before');
      expect(stranger.status).toBe(429);
      expect(stranger.retryAfter).not.toBeNull();
      expect(stranger.body.message).toMatch(/daily/i);
    } finally {
      server.close();
    }
  });

  test('its window is a day and its max is 18 — the arithmetic behind the number', () => {
    // 18 x 5508 reserved tokens = 99144, which is 49.6% of the 200000/day
    // organisation cap (results/studypack-constants.txt §C). Changing max here
    // changes that guarantee, so the number is pinned and the writeups quote
    // this same constant.
    expect(LIMITS.quotaDaily.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(LIMITS.quotaDaily.max).toBe(18);
    expect(LIMITS.quotaDaily.max * 5508).toBeLessThan(200000 / 2);
  });

  test('the per-user limiter runs FIRST, so a refused request costs no shared budget', async () => {
    spend(studyPackLimiter, 'user:greedy');
    spend(quotaDailyLimiter, 'quota:global');
    const { server, base } = await listen(appWith(studyPackLimiter, quotaDailyLimiter));
    try {
      // Six get through and spend six of the global budget. The next twenty are
      // refused by the PER-USER limiter and must not touch the global one.
      for (let i = 0; i < LIMITS.studyPack.max + 20; i += 1) await hit(base, 'greedy');

      // If the order were reversed, the global budget would now be gone and a
      // second user would be refused. It is not: 18 - 6 = 12 remain.
      for (let i = 0; i < LIMITS.quotaDaily.max - LIMITS.studyPack.max; i += 1) {
        expect((await hit(base, `other-${i}`)).status).toBe(200);
      }
      expect((await hit(base, 'one-too-many')).status).toBe(429);
    } finally {
      server.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the registration limiter, added 27 Aug 2026 because the app went public', () => {
  const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');
  const codeOnly = (text) => text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const auth = codeOnly(read('routes/auth.js'));

  test('the stripper works on routes/auth.js too, or the structural half is vacuous', () => {
    // Same positive control the router block runs, re-run on this file because
    // its comments name registerLimiter several times in prose.
    expect(read('routes/auth.js')).toMatch(/^\s*\/\/.*registerLimiter/mi);
    expect(auth).not.toMatch(/^\s*\/\//m);
  });

  test(`${LIMITS.register.max} pass, the next is 429, and it carries Retry-After`, async () => {
    spend(registerLimiter, 'register:global');
    const { server, base } = await listen(appWith(registerLimiter));
    try {
      for (let i = 0; i < LIMITS.register.max; i += 1) {
        expect((await hit(base, null)).status).toBe(200);
      }
      const refused = await hit(base, null);
      expect(refused.status).toBe(429);
      expect(refused.retryAfter).not.toBeNull();
      expect(Number(refused.retryAfter)).toBeGreaterThan(0);
      expect(Number(refused.retryAfter)).toBeLessThanOrEqual(LIMITS.register.windowMs / 1000);
    } finally {
      server.close();
    }
  });

  test('it counts requests that carry NO user at all, which is the whole point', async () => {
    // /api/auth/register runs before `protect` — it is the route that CREATES
    // the user — so every real request to it is unauthenticated. A limiter that
    // only counted authenticated requests would count nothing here. The harness
    // sends no x-test-user below for exactly that reason.
    spend(registerLimiter, 'register:global');
    const { server, base } = await listen(appWith(registerLimiter));
    try {
      for (let i = 0; i < LIMITS.register.max; i += 1) await hit(base, null);
      expect((await hit(base, null)).status).toBe(429);
    } finally {
      server.close();
    }
  });

  test('the key is constant, so distinct identities cannot each get their own budget', async () => {
    // The forced design: this route has no req.user.id and its IP cannot be
    // trusted behind two proxies, so every visitor shares one bucket. If the
    // key were ever "fixed" to identityKey, these distinct users would each get
    // their own allowance and the limiter would bound nothing.
    spend(registerLimiter, 'register:global');
    const { server, base } = await listen(appWith(registerLimiter));
    try {
      for (let i = 0; i < LIMITS.register.max; i += 1) {
        expect((await hit(base, `visitor-${i}`)).status).toBe(200);
      }
      expect((await hit(base, 'a-completely-new-visitor')).status).toBe(429);
    } finally {
      server.close();
    }
  });

  test('the body is JSON with a `message`, which is the shape RegisterPage renders', async () => {
    // frontend/src/pages/RegisterPage.jsx:26 reads err?.response?.data?.message,
    // the same expression AIPanel uses. The library's default body is a plain
    // string, which that expression reads as undefined.
    spend(registerLimiter, 'register:global');
    const { server, base } = await listen(appWith(registerLimiter));
    try {
      for (let i = 0; i < LIMITS.register.max; i += 1) await hit(base, null);
      const refused = await hit(base, null);
      expect(refused.body).not.toBeNull();
      expect(typeof refused.body.message).toBe('string');
      expect(refused.body.message.length).toBeGreaterThan(20);
      expect(refused.body.retryAfterSeconds).toBe(Number(refused.retryAfter));
      // It must tell an EXISTING user that signing in still works, because it
      // does — /login is deliberately unlimited — and a refusal that reads as
      // "the app is down" would be false.
      expect(refused.body.message).toMatch(/sign(ing)? in/i);
    } finally {
      server.close();
    }
  });

  test('its window is an HOUR, not a day — the blast-radius half of the choice', () => {
    // A 24-hour shared window on the front door lets one attacker close signup
    // until tomorrow. An hour bounds that. The max is PICKED and could not be
    // derived (middleware/rateLimit.js's header says why); the WINDOW is the
    // part that carries the argument, so it is pinned here.
    expect(LIMITS.register.windowMs).toBe(60 * 60 * 1000);
    expect(LIMITS.register.max).toBe(20);
    expect(LIMITS.register.windowMs).toBeLessThan(LIMITS.quotaDaily.windowMs);
  });

  test('it shares no budget with the AI quota limiter, though both are globally keyed', async () => {
    // Two constant-keyed limiters is the shape most likely to be "simplified"
    // into one. They protect different resources on disjoint routes, and this
    // proves the key spaces really are disjoint rather than trusting the
    // string literals to differ.
    spend(registerLimiter, 'register:global');
    spend(quotaDailyLimiter, 'quota:global');
    const a = await listen(appWith(registerLimiter));
    try {
      for (let i = 0; i < LIMITS.register.max; i += 1) await hit(a.base, null);
      expect((await hit(a.base, null)).status).toBe(429);
    } finally {
      a.server.close();
    }
    const b = await listen(appWith(quotaDailyLimiter));
    try {
      // Registration is exhausted. The AI budget must be untouched.
      expect((await hit(b.base, 'unrelated-user')).status).toBe(200);
    } finally {
      b.server.close();
    }
  });

  test('it is NOT part of the studyPack < llm < quotaDaily invariant', () => {
    // That chain exists because those three compete for ONE budget on two
    // routes, so an unreachable rung is dead config. register shares nothing
    // with them. Pinned so nobody "restores" the ordering by folding it in —
    // its max is deliberately above quotaDaily.max, which inside the chain
    // would be the exact defect the chain was written to catch.
    expect(LIMITS.studyPack.max).toBeLessThan(LIMITS.llm.max);
    expect(LIMITS.llm.max).toBeLessThan(LIMITS.quotaDaily.max);
    expect(LIMITS.register.max).toBeGreaterThan(LIMITS.quotaDaily.max);
  });

  test('routes/auth.js mounts it on /register at ROUTE level, not router level', () => {
    expect(auth).toMatch(/router\.post\(\s*'\/register',\s*registerLimiter\s*,/);
    // router.use() here would catch /login as well, which is the trade the
    // header rejects: register is once-per-lifetime and can take a shared
    // budget, login is per-session and a shared budget there is an outage.
    expect(auth).not.toContain('router.use(registerLimiter)');
  });

  test('/login carries NO limiter, and that is asserted rather than assumed', () => {
    const loginAt = auth.indexOf("router.post('/login'");
    expect(loginAt).toBeGreaterThan(-1);
    // Everything from the /login route to the end of the file must be free of
    // any limiter. A substring search over the whole file would pass while
    // login was limited, because /register's mount is in the same file.
    expect(auth.slice(loginAt)).not.toMatch(/Limiter/);
  });

  test('the limiter runs BEFORE the handler, so a flood pays no bcrypt', () => {
    // The register handler does a User.findOne() and a bcrypt hash measured at
    // 65.5 ms. Route-level middleware ordering is what keeps a refused request
    // from paying either. If registerLimiter moved after the handler function
    // this match fails.
    const registerAt = auth.indexOf("router.post('/register'");
    const limiterAt = auth.indexOf('registerLimiter', registerAt);
    const handlerAt = auth.indexOf('async (req, res)', registerAt);
    expect(limiterAt).toBeGreaterThan(registerAt);
    expect(limiterAt).toBeLessThan(handlerAt);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the routers are wired, and prose about the wiring cannot stand in for it', () => {
  const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

  /**
   * CODE ONLY — 6.3's rule, and this file needs it more than 6.3 did. Every
   * identifier asserted below appears repeatedly in these files' comments, so a
   * raw substring search would pass against a router whose mounts had all been
   * deleted and only the explanation left behind.
   *
   * ⚠️ LINE COMMENTS ARE STRIPPED FIRST, AND THE ORDER IS THE WHOLE FIX.
   * 6.3's version of this helper (tests/observability.background.test.js:461)
   * strips BLOCK comments first, and that is wrong on this input:
   * routes/studyPack.js writes the route family as `/api/llm/*` inside a `//`
   * comment, and `/*` opens a block comment as far as a regex is concerned. The
   * stripper then deleted everything from there to the next `*​/` — the JSDoc
   * above router.post — taking BOTH `router.use(...Limiter)` lines with it, and
   * the assertions below went red against a file that was entirely correct.
   *
   * Rewording the comment to dodge the stripper was the cheap fix and is
   * exactly what §24's `expandBraces` note forbids: it would leave the tool
   * wrong about every future comment containing a glob. Fixed here; 6.3's copy
   * is untouched and listed as noticed-out-of-scope.
   *
   * Still deliberately NOT a tokenizer: a `//` or a `/*` inside a string
   * literal is left alone, which is safe on these four files and honest about
   * what this is.
   */
  const codeOnly = (text) => text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const llm = codeOnly(read('routes/llm.js'));
  const pack = codeOnly(read('routes/studyPack.js'));
  const notes = codeOnly(read('routes/notes.js'));

  test('the comment stripper actually strips — otherwise everything below is vacuous', () => {
    // routes/llm.js's comment block names llmLimiter and quotaDailyLimiter. If
    // codeOnly stopped working, these mentions would survive and the assertions
    // below would pass on prose. Positive control for §22.6's shape.
    const raw = read('routes/llm.js');
    expect(raw).toMatch(/^\s*\/\/.*limiter/mi);
    expect(codeOnly(raw)).not.toMatch(/^\s*\/\//m);
  });

  test('a line comment containing a glob does not swallow the code after it', () => {
    // The regression that made this suite go red against correct source. Pinned
    // as its own case so the ordering inside codeOnly cannot be "simplified"
    // back to 6.3's, which fails this.
    const source = [
      '// names /api/llm/* only',
      'router.use(studyPackLimiter);',
      '/** a real block comment */',
      'router.use(quotaDailyLimiter);'
    ].join('\n');
    expect(codeOnly(source)).toContain('router.use(studyPackLimiter)');
    expect(codeOnly(source)).toContain('router.use(quotaDailyLimiter)');
    expect(codeOnly(source)).not.toContain('a real block comment');
  });

  test('routes/llm.js applies BOTH limiters', () => {
    expect(llm).toContain('router.use(llmLimiter)');
    expect(llm).toContain('router.use(quotaDailyLimiter)');
  });

  test('routes/studyPack.js applies BOTH limiters — the criterion extended', () => {
    expect(pack).toContain('router.use(studyPackLimiter)');
    expect(pack).toContain('router.use(quotaDailyLimiter)');
  });

  test('protect comes BEFORE the limiters in both routers', () => {
    // The key is req.user.id, which does not exist until protect has run. A
    // limiter mounted above it would silently key every authenticated user onto
    // one shared IP bucket — a limit that still returns 429 and is wrong about
    // who it is limiting, which is the failure mode a passing test hides.
    for (const source of [llm, pack]) {
      const protectAt = source.indexOf('router.use(protect)');
      expect(protectAt).toBeGreaterThan(-1);
      expect(source.indexOf('Limiter)')).toBeGreaterThan(protectAt);
    }
  });

  test('the per-user limiter precedes the global one in both routers', () => {
    expect(llm.indexOf('router.use(llmLimiter)')).toBeLessThan(llm.indexOf('router.use(quotaDailyLimiter)'));
    expect(pack.indexOf('router.use(studyPackLimiter)')).toBeLessThan(pack.indexOf('router.use(quotaDailyLimiter)'));
  });

  test('a route that spends NO quota has no limiter — the negative control', () => {
    // Without this, every assertion above would pass against a grep that
    // matched anything at all. routes/notes.js is the busiest router in the app
    // and spends no Groq quota, so it is the right control.
    expect(notes).not.toContain('quotaDailyLimiter');
    expect(notes).not.toContain('middleware/rateLimit');
  });

  test('server.js mounts both routers with ONE argument, as the mount scraper expects', () => {
    // tests/integration.app.test.js:83 scrapes server.js with a single-argument
    // regex and asserts mounts.length >= 7. Passing a limiter there as a second
    // argument would drop these two routes out of that suite's mount list — so
    // the limiters live in the routers, and this pins the reason.
    const server = codeOnly(read('server.js'));
    expect(server).toContain("app.use('/api/llm', llmRoutes)");
    expect(server).toContain("app.use('/api/study-pack', studyPackRoutes)");
    expect(server).not.toContain('rateLimit');
  });

  test('server.js does not enable trust proxy', () => {
    // Deliberate, and worth an assertion because it is the kind of line someone
    // adds while "fixing" rate limiting behind a proxy. The key here is a user
    // id out of a verified JWT, so req.ip is not load-bearing; guessing the
    // edge's hop count wrong would let a client spoof X-Forwarded-For.
    //
    // HOST CHANGED 26 Aug 2026: this line named Railway, and the app now runs
    // on Render. The assertion is unchanged and the reason is stronger, not
    // weaker: the deployed host answers with both an x-render-origin-server
    // header and a cloudflare server header, so there are at least TWO proxies
    // in front of Express and any hop count written here would be a guess.
    expect(codeOnly(read('server.js'))).not.toContain('trust proxy');
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the eval harness is not affected, and that is structural', () => {
  /** The same stripper the router assertions use, for the same reason. */
  const codeOnly = (text) => text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const scripts = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.js')) scripts.push([entry.name, codeOnly(fs.readFileSync(full, 'utf8'))]);
    }
  })(path.join(BACKEND, 'scripts'));

  test('the script list is non-empty, so the two checks below are not vacuous', () => {
    expect(scripts.length).toBeGreaterThan(25);
  });

  test('no script holds an HTTP client at all', () => {
    // PRIMER §7.3: "either the limiter needs a bypass for the harness, or the
    // harness calls the generator directly rather than over HTTP." It is
    // already the second, so there is no bypass to keep working — but that is a
    // property of the scripts, and a script that started using fetch would
    // silently acquire a rate limit and its delivery rate would become a
    // function of this middleware. This is what would notice.
    //
    // The FIRST version of this test grepped for `/api/llm` and reported three
    // offenders, all of them prose or a printed help string — the same
    // comments-are-not-code trap this file already hit once. Asserting on the
    // CLIENT rather than on a URL is both stricter and immune to it: a script
    // cannot make an HTTP request without one.
    const offenders = scripts
      .filter(([, code]) => /\bfetch\s*\(|require\(['"]https?['"]\)|\baxios\b|node-fetch|\bundici\b/.test(code))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test('no script points at a locally running instance of this app', () => {
    const offenders = scripts
      .filter(([, code]) => /https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(code))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
