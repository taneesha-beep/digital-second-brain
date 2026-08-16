'use strict';

/**
 * preconditions.js — Phase 4.5. What a suite needs before it can mean anything,
 * declared rather than probed, and made LOUD when it is missing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: A SKIPPED TEST LOOKS EXACTLY LIKE A PASSING ONE.
 *
 * §22.6 recorded that two checks in this repo were too weak to distinguish the
 * states they existed to distinguish, and that "nothing in the repo
 * systematically looks for this". A suite that skips itself is the sharpest
 * instance of that shape: the run is green, the summary says nothing a reader
 * will notice, and the check that was supposed to run did not.
 *
 * tests/run-io.test.js:180 already skips correctly when data/ is absent, and
 * that is the right BEHAVIOUR — data/qrels/ is gitignored, so a fresh clone has
 * no key. What it lacks is any statement of what was skipped and any way for a
 * CI run to insist the skip must not happen there. Both are here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DECLARED, NOT PROBED, AND THAT IS THE DESIGN RATHER THAN A LIMITATION.
 *
 * `describe` runs synchronously, so a suite cannot await a TCP connect to
 * decide whether to define itself. That constraint pushed toward the better
 * answer anyway: availability is DECLARED by the operator setting
 * MONGO_TEST_URI, not discovered by the process. The difference matters because
 * a probe answers "was a database there", which is satisfied by accident, and a
 * declaration answers "was one meant to be there", which is what a CI run needs
 * to hold itself to. The probe still happens — connect() in the suite's
 * beforeAll — it just is not what decides whether the assertions exist.
 *
 * The counterpart is tests/ci-scope.test.js: under CI, every precondition the
 * workflow PROMISES to satisfy must actually be satisfied, so a Mongo service
 * container that failed to come up FAILS the run instead of quietly deleting an
 * entire suite from it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MONGO_TEST_URI IS A SEPARATE VARIABLE FROM MONGO_URI, DELIBERATELY, AND THE
 * REASON IS NOT TIDINESS.
 *
 * The integration suite drops collections. backend/.env holds a real Atlas
 * MONGO_URI, and any shell that has exported it — or any future test runner
 * that loads dotenv — would hand this suite production. So MONGO_URI is never
 * read here under any fallback, and the host is checked against the same
 * localhost allowlist migrations/001-canonical-edges.js enforces, with the same
 * absence of an override that scripts/verify-migration.js has: there is no
 * legitimate reason to point a suite that destroys data at a remote host.
 */

const fs = require('fs');
const path = require('path');

const { describeTarget } = require('../../migrations/001-canonical-edges');

const REPO = path.resolve(__dirname, '..', '..', '..');

/**
 * A precondition is a NAME, a REASON it can legitimately be absent, and a
 * predicate. The reason is not decoration: it is printed on every skip, so the
 * operator reading a short run never has to work out whether an absence was
 * expected.
 */
const PRECONDITIONS = {
  /**
   * A throwaway MongoDB. Declared by MONGO_TEST_URI; see the header for why it
   * is not MONGO_URI.
   */
  mongo: {
    name: 'mongo',
    env: 'MONGO_TEST_URI',
    reason:
      'MONGO_TEST_URI is not set. Start a throwaway server and export it — see ' +
      'the header of tests/integration.app.test.js for the exact command.',
    available: () => Boolean(process.env.MONGO_TEST_URI)
  },

  /**
   * The Stack Exchange qrels. Gitignored for size, so absent on any fresh
   * clone and absent in CI by design — CI has no data/ at all, 0 tracked files
   * under it.
   */
  qrels: {
    name: 'qrels',
    env: null,
    reason:
      'data/qrels/cooking.qrels is absent. data/ is gitignored for size, so a fresh ' +
      'clone has no key until `npm run qrels:build` runs against a raw dump.',
    available: () => fs.existsSync(path.join(REPO, 'data', 'qrels', 'cooking.qrels'))
  }
};

/**
 * The URI, validated. Throws rather than returning something unusable, because
 * a suite that reaches here has already decided it is running.
 *
 * THE LOCALHOST CHECK HAS NO OVERRIDE. scripts/verify-migration.js:49 states
 * the rule for a script that drops a collection; this suite does the same thing
 * and inherits it verbatim rather than restating it more weakly.
 */
function mongoUri() {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) throw new Error('preconditions: MONGO_TEST_URI is not set');
  const target = describeTarget(uri);
  if (!target.local) {
    throw new Error(
      `preconditions: refusing MONGO_TEST_URI pointing at ${target.host}. This suite drops ` +
      'collections; it runs against localhost only and there is no override.'
    );
  }
  return uri;
}

/**
 * Every skip that happens is recorded here and printed once, by the reporter
 * below, rather than N times inline. One line per skipped block keeps a short
 * run readable while still making the absence impossible to miss.
 */
const skipped = [];

/**
 * `describe` when the precondition holds, `describe.skip` when it does not —
 * and a recorded, printed reason either way.
 *
 * The block is still DEFINED when skipped, so jest reports its tests as skipped
 * rather than as absent. A test that vanishes from the count entirely is the
 * failure mode this module exists to prevent, and silently shrinking the
 * denominator is how it would happen.
 */
function describeWith(preconditionName, blockName, body) {
  const precondition = PRECONDITIONS[preconditionName];
  if (!precondition) throw new Error(`preconditions: no precondition named ${preconditionName}`);

  if (precondition.available()) return describe(blockName, body);

  const entry = { precondition: precondition.name, block: blockName, reason: precondition.reason };
  skipped.push(entry);
  announce(entry);
  return describe.skip(`${blockName}  [SKIPPED — ${precondition.name} unavailable]`, body);
}

/**
 * WRITTEN IMMEDIATELY, AND THE FIRST VERSION WAS NOT.
 *
 * The first draft deferred this to a process.on('exit') handler, to print one
 * grouped block rather than N lines. It printed NOTHING: jest runs each suite
 * in a worker whose teardown does not flush a handler registered that late, so
 * a mechanism built specifically to make skips visible was itself invisible —
 * §22.6's shape, in the code written to narrow §22.6. Caught by running the
 * suite with MONGO_TEST_URI unset and looking at the output, which is the only
 * check that could have caught it.
 *
 * stderr rather than stdout, because jest buffers and reorders console.* but
 * passes a direct stderr write through.
 */
function announce(entry) {
  process.stderr.write(
    `\n  SKIPPED  ${entry.block}\n` +
    `           ${entry.reason}\n\n`
  );
}

/** Which preconditions hold right now. Used by ci-scope.test.js. */
function status() {
  return Object.values(PRECONDITIONS).map((p) => ({
    name: p.name,
    env: p.env,
    available: p.available(),
    reason: p.reason
  }));
}

module.exports = { PRECONDITIONS, describeWith, mongoUri, status, skipped };
