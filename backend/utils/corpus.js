const Note = require('../models/Note');

/**
 * The user's other notes, as the document-frequency corpus for
 * `extractKeywords`. Called by routes/notes.js:124, routes/upload.js:56 and
 * routes/search.js:79.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `.sort({_id: 1})` IS PHASE 4.6, AND IT CLOSES ONE OF TWO DEFECTS.
 *
 * Until 4.6 this was a `.limit(500)` with no `.sort()`, so above 500 notes the
 * corpus was whichever 500 the database happened to return — EVALUATION §7.2's
 * first unspecified input, and the reason shipped v1 is a function of (query,
 * corpus, save history, database return order) rather than of (query, corpus).
 * MEASURED at results/keyword-stability.txt section A before the change: at
 * N=1000, reversing the store's return order moved 549 of 1000 notes' keyword
 * sets. It is now zero by construction.
 *
 * `{_id: 1}` rather than anything else, for two reasons:
 *
 *   it is what noteCorpus.service.js:155 already sorts by, so a >500-note
 *   user's KEYWORD corpus and their LINKING corpus are now the same slice
 *   rather than two arbitrary 500s of the same notebook;
 *
 *   ObjectIds are monotonic in creation time, so this is also "oldest first" —
 *   but the property being bought is determinism, not chronology.
 *
 * `{updatedAt: -1}` — "the 500 most recently edited" — is a defensible product
 * answer and a worse engineering one: every save would reorder the corpus for
 * every other note, making the keyword list a function of edit history in a NEW
 * way. That is the defect below, made worse rather than better.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT CLOSE, AND THIS FUNCTION IS NOT WHERE THAT LIVES.
 *
 * §7.2's SECOND unspecified input — *when* each note's keywords were computed —
 * is untouched and is untouchable from here. `routes/notes.js:124-125` extracts
 * at save time and persists, and nothing recomputes, so a note's list is a
 * snapshot of whatever corpus existed at its own last save. Sorting specifies
 * WHICH 500 at a given moment; it cannot specify WHICH MOMENT.
 *
 * Measured at 4.6 rather than asserted: 220 of 500 notes' keyword sets differ
 * between a save history and the converged state, and 341 of 500 differ between
 * two save orders of the same notes. The instability is front-loaded — 70.0% of
 * the first ten saves against 22.0% of saves 251-500 — because the earliest
 * notes see an almost-empty corpus, where `docCount` falls back to 1 and every
 * idf is the same constant.
 *
 * Any stored value derived from a moving corpus is a function of when it was
 * derived. The only two fixes are to stop storing it or to recompute everything
 * whenever the corpus moves, and 4.6 priced the first: extracting every list at
 * read time costs 2202.8 ms at N=500 against buildGlobalGraph's 5.1 ms.
 * EVALUATION §26.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PRE-4.6 FUNCTION IS PRESERVED at scripts/lib/corpus-v1-shipped.js, so
 * §7.6's demonstration C still has a real "before" side to compare against.
 * Do not delete it.
 */
async function loadUserCorpus(userId, { excludeId = null, limit = 500 } = {}) {
  const filter = { user: userId };
  if (excludeId) filter._id = { $ne: excludeId };
  const docs = await Note.find(filter).select('title contentText').sort({ _id: 1 }).limit(limit).lean();
  return docs.map((d) => ({ title: d.title || '', content: d.contentText || '' }));
}

module.exports = { loadUserCorpus };
