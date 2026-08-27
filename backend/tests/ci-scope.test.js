'use strict';

/**
 * ci-scope.test.js — Phase 4.5. The guard that makes a green tick mean
 * something.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS EXISTS TO PREVENT.
 *
 * The integration suite skips itself when MONGO_TEST_URI is unset. That is
 * correct on a laptop with no Docker running. It is a DISASTER in CI: if the
 * mongo service container fails to start, the workflow's `env:` still points at
 * it, but had the suite chosen to skip on a failed probe instead, the run would
 * go green having deleted its most expensive assertions from itself. Nobody
 * reads a jest summary line closely enough to notice 30 tests became 0.
 *
 * So the workflow DECLARES what it satisfies, in one place, and this asserts the
 * declaration is true — in BOTH directions:
 *
 *   promised and absent   -> FAIL. The thing CI exists to run did not run.
 *   present and unpromised-> FAIL. The declaration is now false, and README.md's
 *                            badge scope sentence is derived from it. A checker
 *                            that only looks one way lets the claim rot.
 *
 * The second direction is the one that would be tempting to leave out, and it is
 * what keeps README's "does not cover" list honest: if data/ ever appears in CI,
 * this fails until somebody updates both the declaration and the sentence.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT. It handles ONE shape of §22.6's finding — a check that does
 * not run at all. It says nothing about a check that runs and cannot fail,
 * which is the other half and is still unbuilt (§25.7). Narrowing is not
 * closing, and the two were conflated in an earlier draft of this comment.
 */

const fs = require('fs');
const path = require('path');

const { PRECONDITIONS, status } = require('./helpers/preconditions');

const REPO = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'ci.yml');

/**
 * Parsed from the workflow rather than hardcoded here, so there is exactly one
 * place the claim lives. `CI_PRECONDITIONS` is a comma-separated list of
 * precondition names .github/workflows/ci.yml promises to satisfy.
 */
function promised() {
  return String(process.env.CI_PRECONDITIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const inCI = Boolean(process.env.CI);

describe('the precondition declaration itself', () => {
  test('every promised name is a precondition that exists', () => {
    const known = new Set(Object.keys(PRECONDITIONS));
    for (const name of promised()) {
      expect(known.has(name)).toBe(true);
    }
  });

  test('every precondition carries a reason that names how to satisfy it', () => {
    for (const entry of status()) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});

/**
 * A DECLARATION THAT TURNS OUT TO BE FALSE — the pre-Phase-8 sweep, 27 Aug 2026.
 *
 * The suite above checks that a promise is KEPT. This checks what happens when
 * it is BROKEN: MONGO_TEST_URI exported at a host that does not answer, which
 * is what Docker stopping overnight looks like. The 5.6 session met it as
 * `64 failed` and read it as a code regression, because the first thing on the
 * screen was a driver stack trace.
 *
 * ⚠️ WHAT THIS DOES AND DOES NOT FIX, MEASURED RATHER THAN ASSUMED. The 5.6
 * noticed list asked to "fail with 'you promised mongo and it is not there'
 * rather than 63 stack traces". Only the first half is delivered. Measured on
 * this laptop against a dead port, before and after: **63 failed either way** —
 * jest runs every test in a suite whose beforeAll threw, and a suite cannot
 * stop itself. What changed is that all 63 now LEAD with the sentence and the
 * command that fixes it, where before they led with
 * `MongooseServerSelectionError: connect ECONNREFUSED`.
 *
 * That is a smaller win than the noticed list imagined and it is the whole win.
 * Saying so is cheaper than someone re-reading the entry in a year and
 * wondering why the count did not move.
 */
describe('connectOrExplain — a broken environment must not read as broken code', () => {
  const { connectOrExplain } = require('./helpers/preconditions');

  const withUri = async (uri, fn) => {
    const before = process.env.MONGO_TEST_URI;
    process.env.MONGO_TEST_URI = uri;
    try { return await fn(); } finally {
      if (before === undefined) delete process.env.MONGO_TEST_URI;
      else process.env.MONGO_TEST_URI = before;
    }
  };

  // A connect that rejects, without needing a real (absent) database. The real
  // path is proved end to end by pointing the suites at a dead port; this pins
  // the CONTRACT so a rewording cannot quietly drop the diagnosis.
  const deadMongoose = { connect: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:27099'); } };

  test('it names the unkept promise, the target, and the command that fixes it', async () => {
    await withUri('mongodb://127.0.0.1:27099/dsb_dead', async () => {
      await expect(connectOrExplain(deadMongoose)).rejects.toThrow(/YOU PROMISED MONGO AND IT IS NOT THERE/);
      const err = await connectOrExplain(deadMongoose).catch((e) => e);
      expect(err.message).toContain('127.0.0.1:27099');
      expect(err.message).toContain('ECONNREFUSED');
      expect(err.message).toContain('docker run');
      expect(err.message).toContain('NOT A CODE REGRESSION');
    });
  });

  test('it STILL THROWS rather than skipping, which is the deliberate half', async () => {
    // Swallowing this and skipping would turn a broken environment into a
    // silent absence — the exact trade preconditions.js exists to refuse, and
    // worse than the stack traces, because a green run would then be reporting
    // on a suite that never executed.
    await withUri('mongodb://127.0.0.1:27099/dsb_dead', async () => {
      await expect(connectOrExplain(deadMongoose)).rejects.toThrow();
    });
  });

  test('credentials in the URI are redacted from the message', async () => {
    // The message is printed 63 times into a terminal and, in CI, into a public
    // log. MONGO_TEST_URI is localhost-only by rule, but the redaction is not
    // conditional on anybody having obeyed the rule.
    await withUri('mongodb://user:hunter2@127.0.0.1:27099/dsb_dead', async () => {
      const err = await connectOrExplain(deadMongoose).catch((e) => e);
      expect(err.message).not.toContain('hunter2');
      expect(err.message).toContain('<credentials>');
    });
  });

  test('a successful connect passes the options through and says nothing', async () => {
    // The positive control. Without it, a connectOrExplain that ALWAYS threw
    // would satisfy every assertion above.
    const seen = [];
    const okMongoose = { connect: async (uri, opts) => { seen.push({ uri, opts }); } };
    await withUri('mongodb://127.0.0.1:27017/dsb_ok', async () => {
      await connectOrExplain(okMongoose, { dbName: 'dsb_studypack_suite' });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].opts.dbName).toBe('dsb_studypack_suite');
    expect(seen[0].opts.serverSelectionTimeoutMS).toBe(15000);
  });

  test('it refuses a non-localhost host BEFORE trying to connect', async () => {
    // mongoUri()'s localhost rule has no override — this suite drops databases.
    // Reached through connectOrExplain, it must still bite, and it must bite
    // before any network call rather than after a 15-second timeout.
    const seen = [];
    const spy = { connect: async () => { seen.push(1); } };
    await withUri('mongodb+srv://cluster0.example.mongodb.net/test', async () => {
      await expect(connectOrExplain(spy)).rejects.toThrow(/refusing MONGO_TEST_URI/);
    });
    expect(seen).toEqual([]);
  });
});

/**
 * THE WORKFLOW ITSELF, CHECKED FROM THE SUITE IT RUNS.
 *
 * These fail on a laptop, not only in CI, and that is the point: a workflow step
 * naming a script that has been renamed is a break nobody sees until a push, and
 * the push is usually the one where you wanted CI to work. Parsed with a regex
 * rather than a YAML library because adding a dependency to check a file this
 * size is a worse trade than a regex whose failure mode is the first assertion
 * below.
 */
describe('the CI workflow', () => {
  const source = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : null;
  const scripts = source ? [...source.matchAll(/npm run ([\w:-]+)/g)].map(([, name]) => name) : [];

  test('the workflow file exists', () => {
    // README.md's badge points at this path. If it is deleted or renamed the
    // badge renders "no status" forever, which looks like a build that has never
    // run rather than a file that is missing.
    expect(source).not.toBeNull();
  });

  test('it invokes a plausible number of npm scripts — the regex still matches', () => {
    // Without this the next assertion passes vacuously if the `run:` syntax
    // changes. §22.6's shape, guarded at the one place this file could hit it.
    expect(scripts.length).toBeGreaterThanOrEqual(5);
  });

  test('every npm script the workflow runs is defined in backend/package.json', () => {
    const defined = new Set(Object.keys(require('../package.json').scripts));
    expect(scripts.filter((name) => !defined.has(name))).toEqual([]);
  });

  test('it declares CI_PRECONDITIONS, which is what ci-scope asserts against', () => {
    const declared = /CI_PRECONDITIONS:\s*([\w,\s]+)/.exec(source || '');
    expect(declared).not.toBeNull();
    const names = declared[1].trim().split(',').map((s) => s.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(Object.keys(PRECONDITIONS)).toContain(name);
  });

  test('the mongo image is pinned BY DIGEST and matches docker-compose.yml', () => {
    // A tag would make "the same MongoDB the migrations were verified against"
    // false the next time the tag moved, silently. Phase 1.6's pin, reused.
    const digest = /image:\s*mongo:7@(sha256:[0-9a-f]{64})/.exec(source || '');
    expect(digest).not.toBeNull();
    const compose = fs.readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain(digest[1]);
  });

  test('no step needs a real API key', () => {
    /**
     * CLAUDE.md's rule about secrets, asserted rather than remembered. If a
     * future step needs GROQ_API_KEY it does not belong in CI, and this is where
     * that decision gets made rather than in a code review.
     *
     * COMMENTS ARE STRIPPED FIRST, and the first draft did not strip them: it
     * failed against a workflow comment whose entire content is that nothing
     * here needs a key. A checker that cannot tell configuration from prose
     * about configuration punishes the documentation, which is the shape 4.1
     * established is the worst output these tools produce (check-blocks.js:209).
     */
    const configuration = (source || '')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(configuration).not.toMatch(/GROQ_API_KEY/);
    expect(configuration).not.toMatch(/secrets\./);
  });
});

/**
 * Outside CI these are informational: a laptop may or may not have Docker up,
 * and failing there would make `npm test` depend on the operator's mood.
 */
const ciOnly = inCI ? describe : describe.skip;

ciOnly('under CI, the declaration must be exactly true', () => {
  test('CI_PRECONDITIONS is set — an empty declaration is not a valid one', () => {
    // An unset variable and "we promise nothing" are indistinguishable, and the
    // second is never what the workflow means. Requiring it to be non-empty is
    // what stops a deleted `env:` line from silently disabling this whole file.
    expect(promised().length).toBeGreaterThan(0);
  });

  test('every PROMISED precondition is actually available', () => {
    const missing = status().filter((p) => promised().includes(p.name) && !p.available);
    expect(missing.map((p) => `${p.name}: ${p.reason}`)).toEqual([]);
  });

  test('every UNPROMISED precondition is actually absent', () => {
    // Drift the other way. If this fails, CI gained a capability and the
    // declaration — and README.md's badge scope sentence with it — is stale.
    const unexpected = status().filter((p) => !promised().includes(p.name) && p.available);
    expect(unexpected.map((p) => p.name)).toEqual([]);
  });

  test('the promised mongo is REACHABLE, not merely declared', async () => {
    if (!promised().includes('mongo')) return;
    // The declaration is a string. This is the only assertion in the file that
    // touches the thing the string is about, and it is the one that catches a
    // service container that came up and then died.
    const mongoose = require('mongoose');
    const { mongoUri } = require('./helpers/preconditions');
    const connection = await mongoose.createConnection(mongoUri(), { serverSelectionTimeoutMS: 10000 }).asPromise();
    try {
      const ping = await connection.db.admin().command({ ping: 1 });
      expect(ping.ok).toBe(1);
    } finally {
      await connection.close();
    }
  }, 30000);
});
