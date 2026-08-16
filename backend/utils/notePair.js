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

/**
 * THE RECORDED UNKNOWN. Phase 4.3.
 *
 * A direction that carries a score but no label gets this in BOTH of its
 * provenance fields. It means "nobody recorded what wrote this and nothing in
 * the data can recover it" — which is the true state of every row
 * migrations/001-canonical-edges.js carried across, and it is not the same
 * statement as `null`.
 *
 * WHY NOT null. On this row `null` already means something: "direction not
 * observed" (scoreAB: null). A null label would be indistinguishable from a
 * writer that forgot to set one — the same absence standing for two different
 * facts, which is the shape EVALUATION.md §22.6 records as the most dangerous a
 * check can have.
 *
 * WHY NOT A GUESS. There is a tempting signal: v1-overlap always wrote a
 * non-empty sharedKeywords (its score is |shared| / max(|source|, 1) admitted
 * above 0.15, so a stored v1 link has at least one shared term) where v4-bm25
 * always writes an empty one. It is rejected, and not merely on principle. It
 * is a rule about what a CORRECTLY FUNCTIONING v1 writes rather than about what
 * is in the database — 001 already counts `nonFinite` skips, so malformed
 * entries are known to exist. And decisively: even a correct version string
 * could not carry a correct digest, because a v1 row's params were whatever the
 * shipped code held at that note's save time, across corpus epochs (§7.2,
 * roadmap 4.6). Provenance for a migrated row is not merely unknown, it is
 * UNKNOWABLE, and in two fields rather than one. §23.3.
 *
 * IT IS IMPOSSIBLE TO MISTAKE FOR A VERSION, and that is checked rather than
 * asserted: tests/edges.provenance.test.js fails if this value ever appears in
 * retrieval.versions(), and fails if it ever matches the shape /^v\d+-[a-z0-9]+$/
 * that all six registered rungs satisfy. Two independent checks, because a
 * sentinel whose only protection is that nobody has picked the same string is
 * not protected.
 */
const UNKNOWN_PROVENANCE = 'unknown';

/**
 * Which fields hold the from→to direction, given canonicalPair()'s `forward`.
 *
 * ↳ 4.3 ADDED `retriever` AND `digest`, AND THE RULE THAT PUT THEM HERE IS
 * WORTH STATING ONCE: EVERYTHING ONE SAVE WRITES IS PER-DIRECTION. A save
 * writes one direction's score, one direction's shared list and one direction's
 * provenance, in a single $set. A field a save writes that is NOT per-direction
 * is a field two saves fight over — which is last-writer-wins, the defect 4.2
 * removed. §23.1.
 */
function directionFields(forward) {
  return forward
    ? {
      score: 'scoreAB', shared: 'sharedAB', retriever: 'retrieverAB', digest: 'digestAB',
      reverseScore: 'scoreBA', reverseShared: 'sharedBA', reverseRetriever: 'retrieverBA', reverseDigest: 'digestBA'
    }
    : {
      score: 'scoreBA', shared: 'sharedBA', retriever: 'retrieverBA', digest: 'digestBA',
      reverseScore: 'scoreAB', reverseShared: 'sharedAB', reverseRetriever: 'retrieverAB', reverseDigest: 'digestAB'
    };
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

/**
 * The weight AND which direction it came from, with that direction's provenance.
 * Phase 4.3.
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION. weight() above is `max` over two
 * directions that may carry DIFFERENT provenance — after 001 a row can hold a
 * v1-era coefficient in one direction and a v4-bm25 score in the other — so
 * "which retriever produced this pair's weight" is a real question that the
 * number alone cannot answer. Adding provenance made weight()'s silence about
 * which direction it picked read as a defect that was always there.
 *
 * weight() ITSELF IS UNCHANGED, deliberately: scripts/verify-migration.js
 * asserts on its return value against a committed artifact, and widening a
 * function under a check is how a check quietly stops testing what it says.
 *
 * TIES GO TO AB, which is arbitrary and therefore written down. The directions
 * are equal, so the weight is the same either way; only the reported provenance
 * differs, and picking the normal form's first field makes the choice a
 * property of the pair rather than of the arrival order.
 *
 * @returns {{weight: number, direction: 'AB'|'BA', retriever: ?string, digest: ?string}|null}
 */
function weightProvenance(row) {
  const ab = row.scoreAB === null || row.scoreAB === undefined ? null : row.scoreAB;
  const ba = row.scoreBA === null || row.scoreBA === undefined ? null : row.scoreBA;
  if (ab === null && ba === null) return null;

  const useAB = ba === null || (ab !== null && ab >= ba);
  return useAB
    ? { weight: ab, direction: 'AB', retriever: row.retrieverAB ?? null, digest: row.digestAB ?? null }
    : { weight: ba, direction: 'BA', retriever: row.retrieverBA ?? null, digest: row.digestBA ?? null };
}

module.exports = { canonicalPair, directionFields, weight, weightProvenance, UNKNOWN_PROVENANCE };
