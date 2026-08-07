'use strict';

/**
 * index.js — Phase 2.1, the retriever interface
 *
 *   index(version, docs, params) -> handle
 *   search(handle, query, k)     -> [{ docId, score, explain? }]
 *
 * Pure functions over plain objects. No Mongo, no Express, no Note model —
 * which is what lets the eval harness and, from Phase 4.1, the app run the
 * identical code path.
 *
 * WHY THE SIGNATURE CARRIES A VERSION. The roadmap writes index(docs); the
 * version has to be chosen somewhere, and choosing it here means the handle is
 * self-describing. Run provenance then comes from describe(handle) — the thing
 * that actually produced the numbers — instead of from whatever the runner
 * believes it passed.
 *
 * SELF-RETRIEVAL IS EXCLUDED BY CONSTRUCTION, TWICE.
 *
 *   1. There is no way to express a search that does not exclude something.
 *      A query must resolve to an id present in the index; a query object with
 *      no id is a hard error. Results reach the caller only through
 *      ctx.collect, which drops the query id. A retriever that enumerates
 *      candidates its own way — and every efficient one does, because a
 *      postings list is how you avoid scanning the corpus per query — still
 *      cannot record itself.
 *
 *   2. assertHits throws if a self-hit appears anyway. Belt and braces,
 *      because mechanism 1 is a property of this file and mechanism 2 is a
 *      property of every call. Both are covered by a test that registers a
 *      retriever deliberately trying to return its own id.
 *
 * TWO DIFFERENT EXCLUSIONS EXIST AND THEY ARE NOT THE SAME ONE. Self-retrieval
 * exclusion removes the query from the *candidate pool*. Leave-one-out (v1's
 * idfCorpus param) removes the query from its own *document-frequency table*.
 * The query stays in the index for both.
 *
 * ORDERING IS OWNED HERE, NOT BY EACH RETRIEVER. Sorting, tie-breaking and
 * truncation happen once, in this file, so the tie-break is provably identical
 * across all six rungs rather than reimplemented six times. Ties are not an
 * edge case for v1: its score is shared/|keywords| with at most ten keywords,
 * so it takes at most eleven distinct values and the top-k boundary lands
 * inside a tie group routinely.
 */

const {
  resolveParams,
  paramsDigest,
  assertCapParam,
  assertCorpusDocs,
  assertHits
} = require('./types');

const registry = new Map();

/** Register a retriever module. Version strings are unique by construction. */
function register(retriever) {
  if (!retriever || typeof retriever.version !== 'string' || retriever.version === '') {
    throw new TypeError('register: retriever.version must be a non-empty string');
  }
  for (const fn of ['buildIndex', 'rank']) {
    if (typeof retriever[fn] !== 'function') {
      throw new TypeError(`register: ${retriever.version} must export ${fn}()`);
    }
  }
  if (typeof retriever.search === 'function') {
    // Rejected rather than ignored. A retriever exporting its own search is a
    // retriever able to skip the exclusion and the postconditions.
    throw new TypeError(`register: ${retriever.version} must not export search(); ranking is reported through ctx.collect`);
  }
  if (registry.has(retriever.version)) {
    throw new Error(`register: ${retriever.version} already registered`);
  }
  registry.set(retriever.version, retriever);
  return retriever;
}

function versions() {
  return [...registry.keys()].sort();
}

/**
 * Build a search structure over `docs`.
 *
 * @param   {string}   version
 * @param   {Object[]} docs
 * @param   {Object}   [params]  overrides; unknown keys throw
 * @returns {Object}   handle
 */
function index(version, docs, params = {}) {
  const retriever = registry.get(version);
  if (!retriever) {
    throw new Error(`index: unknown retriever ${version}. Known: ${versions().join(', ') || '(none)'}`);
  }
  assertCorpusDocs(docs);

  const resolved = resolveParams(version, retriever.defaultParams, params);
  // Checked at index() rather than at the first search(), so a mistyped cap
  // fails before a run file exists rather than after 2,304 queries of it.
  assertCapParam(version, resolved);
  const byId = new Map();
  for (const doc of docs) byId.set(doc.id, doc);

  return {
    version,
    params: resolved,
    docCount: docs.length,
    digest: paramsDigest(version, resolved),
    _retriever: retriever,
    _byId: byId,
    _state: retriever.buildIndex(docs, resolved)
  };
}

/** Provenance for a run file or a manifest. */
function describe(handle) {
  return {
    version: handle.version,
    params: handle.params,
    docCount: handle.docCount,
    digest: handle.digest
  };
}

/**
 * Rank the corpus against one query.
 *
 * `query` is a docId, or a document object carrying an `id`. Either way the id
 * must already be in the index. A document that is not in the corpus is
 * rejected rather than scored: what its document frequency should be is a real
 * open question — is it part of the corpus it is being compared against or not
 * — and answering it silently here would bake an arbitrary choice into every
 * number. Phase 4.1 decides it, where the app supplies live notes.
 *
 * @param   {Object} handle
 * @param   {string|Object} query
 * @param   {number} k
 * @returns {Array<{docId: string, score: number, explain?: Object}>}
 */
function search(handle, query, k) {
  if (!Number.isInteger(k) || k < 1) throw new TypeError('search: k must be a positive integer');

  const queryId = typeof query === 'string' ? query : query && query.id;
  if (typeof queryId !== 'string' || queryId === '') {
    // The one case where self-retrieval could not be prevented, so it is not
    // reachable: there is no anonymous query.
    throw new TypeError('search: query must be a docId or a document carrying a non-empty id');
  }
  const queryDoc = handle._byId.get(queryId);
  if (!queryDoc) throw new Error(`search: query ${queryId} is not in the index`);

  const collected = [];
  const seen = new Set();
  const ctx = {
    k,
    excludeId: queryId,
    collect(docId, score, explain) {
      if (docId === queryId) return; // structural exclusion — silently dropped
      if (seen.has(docId)) throw new Error(`collect: ${docId} collected twice`);
      seen.add(docId);
      collected.push(explain === undefined ? { docId, score } : { docId, score, explain });
    }
  };

  handle._retriever.rank(handle._state, queryDoc, ctx);

  // Descending score; ties broken lexicographically on the id string. Any
  // total order would do — what matters is that it is fixed, so a rerun cannot
  // reshuffle a tie group and move a document across the k boundary. See
  // v1-overlap.js for what this replaces in the shipped algorithm.
  collected.sort((a, b) => (b.score - a.score) || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));

  // assertCapParam has already established that cap is absent, null, or a
  // positive integer, so `== null` is the whole test. This deliberately no
  // longer reads Number.isFinite: that predicate does not coerce, so a cap
  // arriving as the string "8" fell through to Infinity and produced an
  // uncapped run whose digest recorded cap:"8" (§13.10).
  const cap = handle.params.cap == null ? Infinity : handle.params.cap;
  const hits = collected.slice(0, Math.min(k, cap));

  return assertHits(hits, { k, excludeId: queryId });
}

register(require('./v1-overlap'));
register(require('./v2-jaccard'));

module.exports = { index, search, describe, register, versions };
