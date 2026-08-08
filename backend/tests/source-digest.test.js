'use strict';

/**
 * The retriever-source digest (Phase 3.2), closing the first item on 3.1's
 * noticed-list.
 *
 * The case that matters is the third describe() below: v2-jaccard imports
 * v1-overlap's buildIndex, so an edit to v1-overlap.js moves v2's numbers with
 * no change to v2's PARAM digest. If v1-overlap.js is not in v2's file list,
 * the field does not do the one job it was added for.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { retrieverSource } = require('../eval/source-digest');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const rel = (p) => path.relative(REPO_ROOT, path.join(__dirname, '..', 'retrieval', p));

describe('what the digest covers', () => {
  test('every run carries the interface, not only its own retriever', () => {
    // index.js owns self-retrieval exclusion, the sort and tie-break, and the
    // cap truncation. A change to any of them moves every run on the ladder.
    for (const version of ['v1-overlap', 'v2-jaccard']) {
      const paths = retrieverSource(version).files.map((f) => f.path);
      expect(paths).toContain(rel('index.js'));
      expect(paths).toContain(rel('types.js'));
      expect(paths).toContain(rel(`${version}.js`));
    }
  });

  test('an unknown version is a hard error, not an empty digest', () => {
    // An empty file list would still produce a plausible-looking SHA-256.
    expect(() => retrieverSource('v9-imaginary')).toThrow(/does not exist/);
  });
});

describe('the shared-code case this exists for', () => {
  test("v2's source list includes v1-overlap.js, because v2 imports it", () => {
    const paths = retrieverSource('v2-jaccard').files.map((f) => f.path);
    expect(paths).toContain(rel('v1-overlap.js'));
  });

  test("v1's source list does NOT include v2-jaccard.js", () => {
    // index.js registers every rung, so TRAVERSING it would pull all of them
    // into every digest and v1's would move when v4 lands. It is hashed as a
    // leaf instead. This is the test that pins that decision.
    const paths = retrieverSource('v1-overlap').files.map((f) => f.path);
    expect(paths).not.toContain(rel('v2-jaccard.js'));
  });

  test('two rungs that share code still get different digests', () => {
    expect(retrieverSource('v1-overlap').digest).not.toBe(retrieverSource('v2-jaccard').digest);
  });
});

describe('the digest is a function of file bytes and nothing else', () => {
  test('it is deterministic across calls', () => {
    expect(retrieverSource('v2-jaccard').digest).toBe(retrieverSource('v2-jaccard').digest);
  });

  test('each recorded hash is that file on disk, read independently', () => {
    for (const file of retrieverSource('v2-jaccard').files) {
      const actual = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(REPO_ROOT, file.path)))
        .digest('hex');
      expect(file.sha256).toBe(actual);
    }
  });

  test('the combined digest is the hash of the path:hash lines', () => {
    // Over path/hash PAIRS rather than concatenated bytes: renaming a file
    // without editing it is a real change to what produced a run.
    const source = retrieverSource('v1-overlap');
    const expected = crypto
      .createHash('sha256')
      .update(source.files.map((f) => `${f.path}:${f.sha256}`).join('\n'))
      .digest('hex');
    expect(source.digest).toBe(expected);
  });

  test('the file list is sorted, so the digest cannot depend on walk order', () => {
    const paths = retrieverSource('v2-jaccard').files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });
});
