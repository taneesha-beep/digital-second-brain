'use strict';

/**
 * source-digest.js — Phase 3.2, closing the first item on 3.1's noticed-list.
 *
 * THE GAP THIS CLOSES. A run file's provenance is `describe(handle).digest`,
 * a SHA-256 over {version, params}. That covers the CONFIGURATION and nothing
 * else. From 3.1 onward rungs share code — v2-jaccard imports v1-overlap's
 * buildIndex, v3-tfidf imports its tokeniser — so an edit to v1-overlap.js
 * moves v2's and v3's numbers with NO change to their param digests. The
 * comparison report would show two runs it believes are unchanged.
 *
 * Nothing is exposed today: tests/retrieval.v1-parity.test.js regenerates the
 * committed evidence and fails on drift. The gap is that the REPORT cannot show
 * what the test knows, and it grows with every rung that shares code, which is
 * why 3.1 recorded it as cheapest to fix before v3.
 *
 * WHAT IS HASHED, AND THE ONE ASYMMETRY IN IT.
 *
 *   traversed   retrieval/<version>.js and retrieval/types.js, plus the
 *               transitive closure of their RELATIVE requires
 *   leaf        retrieval/index.js — hashed, NOT traversed
 *
 * index.js is hashed because it owns the things no retriever can opt out of:
 * self-retrieval exclusion, the sort and tie-break, and the cap truncation. A
 * change to the tie-break would move every run on the ladder, and that is
 * exactly the silent drift this exists to catch.
 *
 * It is not TRAVERSED because its last two lines are
 * `register(require('./v1-overlap')); register(require('./v2-jaccard'))` — the
 * registration list reaches every rung, so following it would make each run's
 * source digest depend on rungs it never touches. v3's digest would then move
 * when v4 lands, and a field that changes for reasons unrelated to the run is a
 * field nobody reads.
 *
 * Adding a rung still edits index.js and therefore still moves the digest of
 * every run recorded before it. That is TRUE — those runs were produced by
 * different bytes — so it is reported rather than suppressed, and the per-file
 * list is what makes it legible: `index.js differs` is a one-line, self-
 * explaining diff where a bare digest mismatch would be an alarm with no
 * content.
 *
 * NO NETWORK, NO GIT, NO NODE VERSION in the digest. It is a function of file
 * bytes alone, so it is reproducible on a clean clone and comparable across
 * machines — the same property that makes the Phase 1 checksum chain worth
 * having.
 *
 * THIS FILE LIVES OUTSIDE backend/retrieval/ AND HAS TO. Everything under
 * retrieval/ may require only itself and `crypto`, asserted by
 * tests/retrieval.interface.test.js. Reading its own source needs `fs`, so a
 * retriever cannot hash itself without breaking the property that lets Phase
 * 4.1 hand the app and the eval harness one import path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RETRIEVAL_DIR = path.resolve(__dirname, '..', 'retrieval');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Hashed but never followed. See the header. */
const LEAF_FILES = ['index.js'];

/** Always traversed, whatever the retriever requires. */
const TRAVERSED_ROOTS = ['types.js'];

/**
 * Relative require specifiers only. A bare specifier would mean the no-I/O
 * test is already failing, and `crypto` is the one allowed exception — neither
 * is a file whose bytes belong in this digest.
 */
function relativeRequires(source) {
  const specs = [];
  for (const match of source.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    specs.push(match[1]);
  }
  return specs;
}

function resolveJs(spec, fromDir) {
  const base = path.resolve(fromDir, spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The set of files whose bytes a run of `version` depends on.
 *
 * @param   {string} version  a registered retriever version, e.g. 'v3-tfidf'
 * @returns {{files: Array<{path: string, sha256: string}>, digest: string}}
 */
function retrieverSource(version) {
  const entry = path.join(RETRIEVAL_DIR, `${version}.js`);
  if (!fs.existsSync(entry)) {
    throw new Error(
      `source-digest: ${path.relative(REPO_ROOT, entry)} does not exist. ` +
        'A retriever is expected to live in a file named after its version.'
    );
  }

  const seen = new Set();
  const queue = [entry, ...TRAVERSED_ROOTS.map((f) => path.join(RETRIEVAL_DIR, f))];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeRequires(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveJs(spec, path.dirname(file));
      if (resolved) queue.push(resolved);
    }
  }
  for (const leaf of LEAF_FILES) seen.add(path.join(RETRIEVAL_DIR, leaf));

  const files = [...seen]
    .sort()
    .map((file) => ({
      path: path.relative(REPO_ROOT, file),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }));

  // Over the path/hash pairs, not over concatenated bytes: renaming a file
  // without editing it is a real change to what produced the run, and a
  // concatenation would miss it.
  const digest = crypto
    .createHash('sha256')
    .update(files.map((f) => `${f.path}:${f.sha256}`).join('\n'))
    .digest('hex');

  return { files, digest };
}

module.exports = { retrieverSource };
