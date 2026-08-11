'use strict';

/**
 * notePair.js — the canonical-pair normal form. Phase 4.2.
 *
 * THE NORMAL FORM LIVES IN EXACTLY ONE PLACE, and this is it. Four callers need
 * it — models/NoteLink.js attaches these as statics, services/linker.service.js
 * builds its bulkWrite from them, migrations/001-canonical-edges.js
 * canonicalises existing rows, and scripts/lib/fake-note-store.js needs them to
 * fake the collection. Two implementations would eventually disagree about a
 * boundary case and produce the duplicate rows the unique index exists to
 * forbid, at which point the index converts a quiet inconsistency into a failed
 * write. Better, and still avoidable.
 *
 * IT IS HERE AND NOT IN THE MODEL because the model requires mongoose, and the
 * harness — which has never loaded a database driver, deliberately (§7.5) —
 * would have to in order to reach one function. A normal form is arithmetic on
 * two ids; it does not need an ODM.
 */

/**
 * Order two note ids into the pair's normal form.
 *
 * Compared as STRINGS, not as ObjectIds. Ids arrive here as ObjectIds from
 * Mongo and as strings from the retrieval interface, whose corpus ids are
 * strings by construction (retrieval/types.js). Hex ordering agrees with
 * ObjectId ordering, and what actually matters is that the comparison is the
 * SAME one everywhere rather than which order it picks.
 *
 * A self-pair throws rather than returning something. Self-retrieval exclusion
 * is retrieval/index.js's job and assertHits turns a leak into a throw
 * (CLAUDE.md names it as the most common way an IR evaluation goes quietly
 * wrong); a self-edge reaching storage would mean that guard had already
 * failed, and storing it would hide the failure behind a row that looks fine.
 *
 * @returns {{noteA: *, noteB: *, forward: boolean}} forward is true when `from`
 *   is noteA — i.e. when the from→to direction is the AB one.
 */
function canonicalPair(from, to) {
  const f = String(from);
  const t = String(to);
  if (f === t) throw new Error(`NoteLink: a note cannot link to itself (${f})`);
  return f < t
    ? { noteA: from, noteB: to, forward: true }
    : { noteA: to, noteB: from, forward: false };
}

/** Which fields hold the from→to direction, given canonicalPair()'s `forward`. */
function directionFields(forward) {
  return forward
    ? { score: 'scoreAB', shared: 'sharedAB', reverseScore: 'scoreBA', reverseShared: 'sharedBA' }
    : { score: 'scoreBA', shared: 'sharedBA', reverseScore: 'scoreAB', reverseShared: 'sharedAB' };
}

/**
 * THE ONE WEIGHT PER PAIR, derived rather than stored — max over the observed
 * directions. models/NoteLink.js's header argues why max and not mean, min, or
 * the source direction of whichever note was saved last.
 *
 * Returns null for a row with neither direction observed. The linker's
 * bulkWrite deletes those rather than leaving them behind, so a null from here
 * is a row that should not exist.
 */
function weight(row) {
  const observed = [row.scoreAB, row.scoreBA].filter((s) => s !== null && s !== undefined);
  return observed.length === 0 ? null : Math.max(...observed);
}

module.exports = { canonicalPair, directionFields, weight };
