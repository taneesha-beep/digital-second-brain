'use strict';

/**
 * noteCorpus.service.js — Phase 4.1. The corpus adapter.
 *
 * Turns a user's `Note` documents into the plain `CorpusDoc` objects
 * backend/retrieval/ indexes, so the app and the eval harness run the identical
 * retrieval code over the identical shape of input.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS NOT UNDER backend/retrieval/, WHICH IS WHERE END-STATE.md
 * PUT IT.
 *
 * END-STATE §1's planned tree names `backend/retrieval/adapters/mongoNotes.js`.
 * That location is not merely unconventional, it is FORBIDDEN:
 * tests/retrieval.interface.test.js walks the require graph of every file under
 * backend/retrieval/ and fails if any specifier resolves outside it, `crypto`
 * excepted. An adapter requires ../models/Note by definition. So the adapter
 * lives on the APP side of the §7.1 boundary and the arrow only ever points one
 * way:
 *
 *     routes/  ->  services/noteCorpus  ->  retrieval/        never the reverse
 *     (I/O)        (I/O, this file)        (pure, no I/O)
 *
 * v1-overlap.js's header states the same rule from the other side — it copies
 * the tokenizer out of utils/keywords.js rather than importing it, precisely so
 * that retrieval never depends on app code. Nothing under backend/retrieval/ is
 * added or edited by Phase 4.1.
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT "THE SAME CORPUS" MEANS, because the 4.1 Done criterion rests on it.
 *
 * Two corpora are the same when their ORDERED list of {id, title, body} triples
 * renders identically under renderCorpus() below. That is a definition the
 * parity proof can hash, and without one the proof asserts nothing. §12.2
 * already recorded that "over a <=500-note user slice" has no referent on a
 * corpus with no users; this is the referent that does exist — a shape, checked
 * on shared content, rather than a notebook nobody has.
 * ─────────────────────────────────────────────────────────────────────────
 * THIS ADAPTER SORTS, AND utils/corpus.js STILL DOES NOT. Two functions, two
 * fixes, and only one of them is 4.1's.
 *
 * §7.2 froze tie order as "descending score, then lexicographic on the id" and
 * noted it reproduces shipped output exactly WHEN THE STORE RETURNS DOCUMENTS
 * IN ID ORDER — which `utils/corpus.js:6`, a `.limit(500)` with no `.sort()`,
 * does not guarantee. Shipping brand-new code with that same nondeterminism
 * would make the app's links a function of Mongo's return order, so the query
 * here is sorted and the freeze is TRUE BY CONSTRUCTION for this corpus.
 *
 * It is still only ASSUMED for utils/corpus.js, whose unsorted 500 continues to
 * feed extractKeywords and therefore the stored `note.keywords` that the graph
 * builder and the search route read. That is roadmap 4.6's item and it is
 * deliberately untouched: changing which 500 notes supply the document
 * frequencies changes every stored keyword list, which is the keyword-recompute
 * migration 4.6 owns.
 * ─────────────────────────────────────────────────────────────────────────
 * THE QUERY NOTE IS IN THE INDEX, AND THAT IS NOT A BUG.
 *
 * loadUserCorpus takes an `excludeId` because the shipped extractor needs a
 * leave-one-out document-frequency table. This adapter excludes nothing. §7.3
 * keeps the two exclusions distinct and they are not interchangeable:
 *
 *   self-retrieval exclusion  removes the query from the CANDIDATE POOL, and it
 *                             is retrieval/index.js's job — ctx.collect drops
 *                             the query id, and assertHits throws if one gets
 *                             through by another route.
 *   leave-one-out             removes the query from its own DF TABLE.
 *
 * The query stays in the index for both. Handing the retriever a corpus with
 * the query already removed would break the FIRST mechanism, because search()
 * rejects a query id that is not in the index — and a corpus that silently
 * omits the query is also one document short for every other document's df.
 */

const crypto = require('crypto');

const Note = require('../models/Note');
const retrieval = require('../retrieval');

/**
 * WHAT THE APP RUNS, and it is not the rung that won the ladder.
 *
 * v5-embeddings wins on test at 0.3197 against v4's 0.2391 (§19.1) and §17.13
 * says in terms that winning is not a reason to ship it. Phase 4.1 priced it in
 * app terms rather than inheriting the eval's framing, and the outcome is
 * recorded in EVALUATION.md §21.1: the blocker is NOT latency, which is
 * affordable, but that v5 needs a 384-float vector stored per note and kept in
 * sync with the text, needs a backfill for every existing note, emits no
 * `explain` for §2.13's link panel to render, and puts ~232 MiB of resident
 * model plus ~350 MiB of node_modules into a deployment.
 *
 * v4 needs NOTHING stored. It builds its index in memory from {id, title, body}
 * — which is exactly the "no persisted document-frequency collection, index
 * built in memory per user" that END-STATE §1 describes and ADR-0007 is meant
 * to record. Changing this constant is how the app changes retriever; nothing
 * else here is version-specific.
 */
const APP_RETRIEVER = 'v4-bm25';

/** utils/corpus.js:3 — the same slice the shipped extractor reads. */
const CORPUS_LIMIT = 500;

/** linker.service.js:36 — slice(0, 8), preserved as a product constant. */
const LINK_CAP = 8;

/**
 * Note -> CorpusDoc.
 *
 * `id` IS STRINGIFIED HERE AND THAT IS THE LOAD-BEARING LINE. Corpus ids are
 * strings by construction (§2 — "so a qrels join can never fail on 1 !== '1'"),
 * `assertCorpusDocs` rejects a non-string id, and a Mongo `_id` is an ObjectId.
 *
 * The two sides fail differently and only one of them is loud. MEASURED by
 * parity-app.js demonstration C rather than reasoned about, because the first
 * draft of this comment guessed wrong:
 *
 *   index side, no String()   `index: docs[0].id must be a non-empty string`
 *   search() handed the raw
 *     ObjectId                `search: query must be a docId or a document
 *                              carrying a non-empty id` — an ObjectId's `.id`
 *                              is a Buffer, not a string, so it is rejected
 *   relatedNotes() below,
 *     without String()        0 HITS, SILENTLY. No throw, no log, no links —
 *                              and it runs inside an un-awaited background job
 *                              whose failures only reach console.error anyway,
 *                              so there would be nothing to reach.
 *
 * The third is the one worth the line of code. This comment previously claimed
 * the failure was self-retrieval; it is not — §7.3's two mechanisms hold — it
 * is a note that quietly stops having any related notes at all.
 *
 * `body` reads contentText and nothing else, exactly as utils/corpus.js:7 does.
 * normalizeContent() and blockNoteToPlainText() are upstream of this — they turn
 * three historical content shapes into contentText at write time
 * (routes/notes.js:106-113) and FROZEN.md keeps them that way. §7.5 records the
 * same boundary for the parity harness.
 */
function toCorpusDoc(note) {
  return {
    id: String(note._id),
    title: note.title || '',
    body: note.contentText || ''
  };
}

/**
 * A user's notes as a corpus, in a SPECIFIED order.
 *
 * Sorted by `_id` ascending: see the header. ObjectIds are monotonic in
 * creation time, so this is also "oldest first", but the property being bought
 * is determinism rather than chronology.
 */
async function loadNoteCorpus(userId, { limit = CORPUS_LIMIT } = {}) {
  const notes = await Note.find({ user: userId })
    .select('title contentText')
    .sort({ _id: 1 })
    .limit(limit)
    .lean();
  return notes.map(toCorpusDoc);
}

/**
 * The canonical rendering that DEFINES corpus identity. One line per document,
 * in order, with the fields the retriever actually reads.
 *
 * Tab-separated with newlines escaped, so a body containing the separator
 * cannot forge a row boundary — the failure that would let two different
 * corpora hash the same.
 */
function renderCorpus(docs) {
  const lines = [`# corpus — ${docs.length} documents`];
  for (const doc of docs) {
    lines.push(`${doc.id}\t${escapeField(doc.title)}\t${escapeField(doc.body)}`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeField(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

/** SHA-256 over renderCorpus(). What "the same corpus" is checked with. */
function corpusDigest(docs) {
  return crypto.createHash('sha256').update(renderCorpus(docs)).digest('hex');
}

/**
 * Build a retrieval handle over one user's notes.
 *
 * REBUILT PER CALL, deliberately and measurably. At the <=500 notes this slice
 * holds the build is milliseconds (§21.4), and a cache is a second thing to get
 * wrong — it needs invalidation on every write, and a stale index is the same
 * class of defect as the stale keyword lists 4.6 exists to remove. END-STATE §1
 * describes a cached per-user index and ADR-0007 is where the trigger condition
 * for adding one belongs; this is not that task.
 */
async function indexUserNotes(userId, { version = APP_RETRIEVER, params = {}, limit = CORPUS_LIMIT } = {}) {
  const docs = await loadNoteCorpus(userId, { limit });
  return retrieval.index(version, docs, params);
}

/**
 * The related notes for one note, as a ranked list.
 *
 * Returns [] rather than throwing when the note is not in the handle's corpus.
 * Two ways that happens and neither is exceptional: the note was deleted
 * between the index build and this call, or the user holds more than
 * CORPUS_LIMIT notes and this one fell outside the slice. Throwing would turn
 * an ordinary state into a background-job error that only reaches console.error
 * anyway (CLAUDE.md — the two jobs are un-awaited).
 */
function relatedNotes(handle, noteId, k = LINK_CAP) {
  const id = String(noteId);
  if (!handle._byId.has(id)) return [];
  return retrieval.search(handle, id, k);
}

module.exports = {
  APP_RETRIEVER,
  CORPUS_LIMIT,
  LINK_CAP,
  toCorpusDoc,
  loadNoteCorpus,
  renderCorpus,
  corpusDigest,
  indexUserNotes,
  relatedNotes,
  describe: retrieval.describe
};
