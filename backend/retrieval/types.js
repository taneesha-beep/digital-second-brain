'use strict';

/**
 * types.js — Phase 2.1
 *
 * The shapes every retriever on the ladder agrees on, plus the runtime
 * validators that enforce them.
 *
 * These are JSDoc typedefs rather than TypeScript because the repo is
 * CommonJS JavaScript throughout; `tsc --checkJs` reads them if that is ever
 * wanted. The typedefs document, the validators enforce, and only the second
 * kind of guarantee survives a refactor.
 *
 * NO I/O, NO DEPENDENCIES. Everything under backend/retrieval/ may require
 * only other files in backend/retrieval/ and the `crypto` builtin. That is
 * asserted by a test (tests/retrieval.interface.test.js) rather than left to
 * discipline, because it is the property that lets Phase 4.1 hand the app and
 * the eval harness the same import path.
 */

const crypto = require('crypto');

/**
 * A corpus document. `id` is mandatory and is the only field the interface
 * itself reads — everything else is consumed by whichever retriever is
 * indexing. v1 reads `title` and `body`; v5 will read a precomputed `vector`
 * the same way, because embedding is corpus preparation and arrives as data.
 *
 * @typedef  {Object} CorpusDoc
 * @property {string}  id     stable document id; strings throughout, matching
 *                            the corpus build's decision to emit string ids so
 *                            a qrels join can never fail on 1 !== "1"
 * @property {string} [title]
 * @property {string} [body]
 */

/**
 * One result. `explain` is retriever-specific and optional: the 2.2 run-file
 * writer reads only docId and score, but v1 needs it to reproduce the shipped
 * linker's stored `sharedKeywords` byte for byte, and 7.4's explainability
 * panel is the eventual consumer.
 *
 * @typedef  {Object} Hit
 * @property {string}  docId
 * @property {number}  score
 * @property {Object} [explain]
 */

/**
 * Returned by index(). Self-describing: `version` and `params` travel with the
 * thing that actually produced the numbers, rather than with whatever the
 * runner believes it passed.
 *
 * @typedef  {Object} Handle
 * @property {string}   version
 * @property {Readonly<Object>} params
 * @property {number}   docCount
 * @property {string}   digest    SHA-256 over {version, params}
 */

/**
 * A retriever module. Note what is NOT here: `search`. Retrievers expose
 * `rank`, and the only exported `search` lives in ./index.js, which owns
 * self-retrieval exclusion, ordering, and the postconditions. A retriever
 * cannot opt out of them by exporting its own.
 *
 * `termCount` is OPTIONAL and is not part of retrieval. It exists because
 * scripts/analyse-rungs.js stratifies by how many terms a query carries, and at
 * 3.1 it read that straight out of v1's private `_state.keywordsById` — which
 * crashed on the first rung that does not represent documents as keyword lists.
 * An accessor is the fix; reaching into another module's state was the defect.
 *
 * The quantity is NOT the same across rungs and the caller must say which it is
 * reporting: for v1 and v2 it is the length of the top-10 selection, so it is
 * capped at 10 and 96% of the corpus sits exactly there; for v3 at full
 * vocabulary it is the number of distinct terms, mean 36.5 and unbounded. A
 * `d <= 6` stratum means different things either side of that, which is why
 * analyse-rungs prints the source rather than assuming the two agree.
 *
 * @typedef  {Object} Retriever
 * @property {string}   version
 * @property {Object}   defaultParams
 * @property {function(CorpusDoc[], Object): Object} buildIndex
 * @property {function(Object, CorpusDoc, RankContext): void} rank
 * @property {function(Object, string): number} [termCount]
 */

/**
 * Handed to rank(). The retriever reports results through `collect` and never
 * returns them, so the exclusion cannot be bypassed by a retriever that
 * enumerates candidates its own way — which every efficient one does, since a
 * postings list is how you avoid scanning the corpus per query.
 *
 * @typedef  {Object} RankContext
 * @property {number}   k
 * @property {string}   excludeId
 * @property {function(string, number, Object=): void} collect
 */

/** Deep-sorted JSON, so a digest over the same params is the same string. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** SHA-256 over {version, params}. Ties a run file to one configuration. */
function paramsDigest(version, params) {
  return crypto
    .createHash('sha256')
    .update(canonicalJson({ version, params }))
    .digest('hex');
}

/**
 * Merge overrides onto defaults and freeze the result.
 *
 * Unknown keys are a hard error. A typo'd parameter that silently does nothing
 * produces a run that looks like a one-variable change and is not one, which
 * is the exact failure the "never change two variables at once" rule exists to
 * prevent — and it is invisible in the output.
 */
function resolveParams(version, defaults, overrides = {}) {
  const unknown = Object.keys(overrides).filter((k) => !(k in defaults));
  if (unknown.length > 0) {
    throw new Error(
      `${version}: unknown param${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. ` +
        `Known: ${Object.keys(defaults).sort().join(', ')}`
    );
  }
  return Object.freeze({ ...defaults, ...overrides });
}

/**
 * `cap` is the one per-retriever param the INTERFACE itself reads — index.js
 * truncates with slice(0, min(k, cap)) — so it is the one whose type the
 * interface has to enforce.
 *
 * WHY THIS EXISTS (opened by 2.7, EVALUATION.md §13.10). index.js used to
 * write `Number.isFinite(handle.params.cap) ? … : Infinity`, and
 * Number.isFinite does not coerce. A cap arriving as the STRING "8" is not
 * finite, so it fell through to Infinity and the run was silently UNCAPPED
 * while describe(handle).digest faithfully recorded cap:"8". That is exactly
 * the "run that lies about itself" the --param JSON parsing exists to prevent,
 * surviving one layer further down. A non-integer number is the same defect in
 * a quieter form: slice truncates, so cap 8.5 behaves as 8 while the digest
 * says 8.5.
 *
 * `null` is the spelling for "no cap" (`--param cap=null`), so it is the only
 * non-integer accepted. `Infinity` is rejected rather than aliased: JSON
 * cannot express it, so it could only arrive as the string "Infinity", which
 * is the bug this catches.
 *
 * Absent is left alone — `cap` is optional, and a retriever that declares no
 * cap (v3 and v4 will not) is uncapped by not having the param at all.
 */
function assertCapParam(version, params) {
  if (!('cap' in params) || params.cap === null) return params;
  if (!Number.isInteger(params.cap) || params.cap < 1) {
    throw new TypeError(
      `${version}: cap must be null or a positive integer, got ${typeof params.cap} ` +
        `${JSON.stringify(params.cap)}. A cap the interface cannot read silently ` +
        `produces an UNCAPPED run whose digest records the cap it ignored.`
    );
  }
  return params;
}

/**
 * Validate a corpus before indexing. Duplicate ids are checked because a
 * duplicate silently makes one document unreachable and inflates document
 * frequency — a slow, quiet corruption of every IDF on the ladder.
 */
function assertCorpusDocs(docs) {
  if (!Array.isArray(docs)) throw new TypeError('index: docs must be an array');
  const seen = new Set();
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    if (!doc || typeof doc !== 'object') {
      throw new TypeError(`index: docs[${i}] is not an object`);
    }
    if (typeof doc.id !== 'string' || doc.id === '') {
      throw new TypeError(`index: docs[${i}].id must be a non-empty string`);
    }
    if (seen.has(doc.id)) throw new Error(`index: duplicate doc id ${doc.id}`);
    seen.add(doc.id);
  }
  return docs;
}

/**
 * Postcondition on every search(). The self-retrieval check is the reason this
 * function exists: CLAUDE.md names the query sitting in its own candidate pool
 * as the most common way an IR evaluation goes quietly wrong, and "quietly" is
 * the operative word — it inflates every metric while looking healthy. This
 * turns it into a throw.
 */
function assertHits(hits, { k, excludeId }) {
  if (!Array.isArray(hits)) throw new TypeError('search: hits must be an array');
  if (hits.length > k) throw new Error(`search: returned ${hits.length} hits for k=${k}`);
  const seen = new Set();
  let previous = Infinity;
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (typeof hit.docId !== 'string' || hit.docId === '') {
      throw new TypeError(`search: hits[${i}].docId must be a non-empty string`);
    }
    if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) {
      throw new TypeError(`search: hits[${i}].score must be a finite number`);
    }
    if (hit.docId === excludeId) {
      throw new Error(`search: self-retrieval — query ${excludeId} returned itself at rank ${i + 1}`);
    }
    if (seen.has(hit.docId)) throw new Error(`search: duplicate docId ${hit.docId}`);
    seen.add(hit.docId);
    if (hit.score > previous) {
      throw new Error(`search: hits not in descending score order at rank ${i + 1}`);
    }
    previous = hit.score;
  }
  return hits;
}

module.exports = {
  canonicalJson,
  paramsDigest,
  resolveParams,
  assertCapParam,
  assertCorpusDocs,
  assertHits
};
