'use strict';

/**
 * graph.characterization.test.js — Phase 4.4
 *
 * THE FREEZE ON scripts/lib/graph-builder-v1-shipped.js, CHECKED AT EVERY
 * COMMIT RATHER THAN ONLY WHEN THE SCRIPT IS RUN.
 *
 * `npm run characterize:graph` needs data/corpus/cooking.jsonl, which is
 * gitignored, so it cannot be the thing that keeps the freeze honest. These
 * tests need no corpus and no database: they check that the preserved copy is
 * still byte-identical to the file it claims to preserve, that it is still not
 * shipped code, and that the constant naming its hash has exactly one home.
 *
 * The pattern is tests/retrieval.v1-parity.test.js's first two tests, applied
 * to the second frozen implementation in scripts/lib/. Its lesson, which is
 * 4.1's: "a preserved copy nobody checks is how a parity proof quietly becomes
 * a comparison with itself."
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKEND = path.join(__dirname, '..');
const FROZEN_PATH = path.join(BACKEND, 'scripts', 'lib', 'graph-builder-v1-shipped.js');
const SCRIPT_PATH = path.join(BACKEND, 'scripts', 'characterize-graph.js');
const LIVE_PATH = path.join(BACKEND, 'services', 'graphBuilder.service.js');

/**
 * `git show 83689c6:backend/services/graphBuilder.service.js
 *    | tail -n +2 | shasum -a 256`
 *
 * Hashed rather than diffed against git, so the check needs no repository
 * history at run time — 4.5 will run this in CI, where a shallow checkout has
 * no tags and may have no parent commits.
 */
const VERBATIM_SHA = '711b6588dc6a72101d557000157e9df4dd3cbf112c0cdf475c5a79160d2f3fb2';

const source = fs.readFileSync(FROZEN_PATH, 'utf8');

/**
 * The extraction rule, and it is deliberately the SAME two lines
 * characterize-graph.js uses. `end` stops at the START of the END marker line,
 * so the region keeps the trailing newline that `tail -n +2` also keeps —
 * getting that boundary wrong hashes one byte too few and the check would fail
 * for a reason that has nothing to do with drift.
 */
function verbatimOf(text) {
  const begin = text.indexOf('BEGIN VERBATIM');
  const end = text.indexOf('// ─── END VERBATIM');
  if (begin === -1 || end === -1) return null;
  return text.slice(text.indexOf('\n', begin) + 1, end);
}

describe('the preserved pre-4.4 graph builder has not drifted', () => {
  test('the verbatim region is byte-identical to graphBuilder.service.js at 83689c6', () => {
    const verbatim = verbatimOf(source);
    expect(verbatim).not.toBeNull();
    expect(crypto.createHash('sha256').update(verbatim).digest('hex')).toBe(VERBATIM_SHA);
  });

  test('the extraction is not vacuous — it finds a region, and not the whole file', () => {
    // 4.3's lesson from expandBraces(): a check whose only protection is that
    // nobody has broken it can pass by matching nothing. If the markers were
    // ever removed, verbatimOf() returns null and the test above would fail on
    // a null rather than on a hash — so assert the region is real, is smaller
    // than the file, and still contains the function under preservation.
    const verbatim = verbatimOf(source);
    expect(verbatim.length).toBeGreaterThan(1000);
    expect(verbatim.length).toBeLessThan(source.length);
    expect(verbatim).toContain('async function buildGlobalGraph(userId)');
    expect(verbatim).not.toContain('BEGIN VERBATIM');
  });

  test('the header names the commit the hash comes from', () => {
    // The hash is worthless without the commit it names: "byte-identical to
    // something" is not a claim. If a future edit moves the freeze forward, the
    // header and the constant must move together.
    expect(source).toContain('83689c6');
    expect(source).toContain(VERBATIM_SHA);
  });

  test('only the first line differs from the file it preserves', () => {
    expect(source).toContain("const Note = require('../../models/Note');");
    expect(verbatimOf(source)).not.toContain("require('../models/Note')");
  });
});

describe('the preserved copy is NOT shipped code', () => {
  const APP_ROOTS = ['routes', 'services', 'models', 'middleware', 'utils'];

  test('nothing under the app requires it', () => {
    const offenders = [];
    for (const root of APP_ROOTS) {
      const dir = path.join(BACKEND, root);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        if (text.includes('graph-builder-v1-shipped')) offenders.push(`${root}/${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the routes still call the LIVE builder', () => {
    // The other half of the same claim, and the one that would catch a
    // well-meaning swap. If a route ever pointed at the frozen copy, the
    // characterization would be comparing the frozen builder against itself.
    const graphRoute = fs.readFileSync(path.join(BACKEND, 'routes', 'graph.js'), 'utf8');
    expect(graphRoute).toContain("require('../services/graphBuilder.service')");
    expect(graphRoute).not.toContain('graph-builder-v1-shipped');
  });

  test('it exports the function under characterization', () => {
    const frozen = require('../scripts/lib/graph-builder-v1-shipped');
    expect(typeof frozen.buildGlobalGraph).toBe('function');
  });
});

describe('the hash has exactly one home', () => {
  test('characterize-graph.js expects the same hash this suite does', () => {
    // Two readers of one value. Without this, the script and the suite can
    // disagree about what "unchanged" means and both keep passing — the script
    // against a stale constant, the suite against the real file.
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toContain(VERBATIM_SHA);
  });

  test('the live builder is hashed at run time, never pinned to a literal', () => {
    // The live file is the thing 4.4 CHANGES, so pinning its bytes anywhere
    // would make the suite fail on the change it exists to allow. The artifact
    // still records its hash — that is provenance, not a constraint — so the
    // property to check is that the script COMPUTES it rather than carrying it.
    //
    // The first draft of this test asserted the script does not contain the
    // live hash. That is true of almost any file and could not have failed:
    // §22.6's "checks too weak to fail", written by hand in the session that
    // deferred building a tool to find them.
    const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(script).toMatch(/sha256\(fs\.readFileSync\(LIVE, 'utf8'\)\)/);
    expect(fs.readFileSync(LIVE_PATH, 'utf8')).toContain('buildGlobalGraph');
  });
});
