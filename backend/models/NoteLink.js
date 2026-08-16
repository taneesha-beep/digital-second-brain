const mongoose = require('mongoose');
const notePair = require('../utils/notePair');

/**
 * NoteLink — canonical edge storage. Phase 4.2.
 *
 * REVIVED, WITH ITS SCHEMA REPLACED. This model existed and was referenced by
 * nothing, so it has never been written and there is neither data nor a live
 * index to migrate. END-STATE §1 says REVIVED; that was a plan, and what it
 * inherited had two defects it would have been wrong to carry forward silently:
 *
 *   the unique index was {user, sourceNote, targetNote}, which is DIRECTED,
 *   while the comment above it read "One undirected edge per note pair per
 *   user". The comment was the correct intention and the index was not.
 *
 *   similarityScore had `max: 1`, which a raw BM25 score VIOLATES. From 4.1 the
 *   stored strength is the retriever's own score (EVALUATION.md §21.5), so that
 *   ceiling would have rejected the write.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A ROW CARRIES TWO SCORES, WHICH IS THE ONE REAL DECISION IN 4.2
 *
 * `v4-bm25` declares `symmetric: false` and §14.5's amendment MEASURES it: 190
 * of 197 reachable fixture pairs disagree between the two directions, and every
 * symmetric exception has |A| = |B|. BM25 length-normalises and saturates the
 * document side and neither on the query side, so score(A→B) ≠ score(B→A) and
 * there are genuinely two numbers. A single stored weight has to destroy one.
 *
 * REJECTED — mean. §14.5 and §17.10 both record that symmetrising means scoring
 * f(A,B) + f(B,A), which is "a different retriever, not a setting". A mean is
 * exactly that retriever, computed at storage time — and roadmap 4.3 is about
 * to stamp retrieverVersion: 'v4-bm25' on this row, which that number would
 * make false. max and min at least SELECT among values the registered retriever
 * emitted; a mean is a value no rung on the ladder ever produced.
 *
 * REJECTED — min. BM25 normalises by document length, so min systematically
 * picks the view in which the target is the long document: long notes' edges
 * would be uniformly weak for a reason that is an artifact of the scoring
 * function rather than a property of the notes. It also inverts in the UI —
 * over a single observed direction min equals max, so the weight would DECREASE
 * as the second direction arrived.
 *
 * REJECTED — the source direction of whichever note was saved last. That is the
 * defect 4.2 exists to remove (PRIMER §3.5).
 *
 * REJECTED — a single stored max. It cannot be maintained without a ratchet.
 * max is commutative and idempotent, so max(existing, new) does converge to an
 * order-independent fixed point; but when a note is EDITED and its outgoing
 * score falls, a single field has no way to know which side to lower and the
 * stale higher value sticks forever. Avoiding that needs either both directions
 * kept, or a second full-depth retrieval pass per candidate at save time — and
 * the second would need a score(query, doc) accessor that backend/retrieval/
 * does not expose, which is an edit to the pure boundary 4.1 deliberately left
 * untouched.
 *
 * SO: both directions are stored, each replaced only by its own source's save,
 * and the single pair weight is DERIVED — weight() below, max over the observed
 * directions, a pure function of the row that no writer can ratchet.
 *
 * The roadmap's phrase is "one weight per pair by construction". What this is:
 * ONE EDGE PER PAIR BY CONSTRUCTION, ONE WEIGHT PER PAIR BY DEFINITION. The
 * unique index it specifies is unchanged.
 *
 * WHAT IT COSTS, said plainly: a note's stored edge set becomes the UNION of
 * "notes it ranked" and "notes that ranked it", so degree can exceed the cap of
 * 8 and the stored graph is not what the retriever returned. That is not new —
 * the pre-4.2 write pushed into the target's linkedNotes with no cap at all —
 * but it stops being an accident. What it buys is that ordering is preserved:
 * a note's panel sorts on its OWN direction, which is exactly the score
 * v4-bm25 gave it. Any single stored weight would have re-sorted that list by a
 * number partly determined by the other note.
 * ───────────────────────────────────────────────────────────────────────────
 * ↳ 4.3 STAMPED THE VERSION, AND THE "REJECTED — mean" ARGUMENT ABOVE HELD.
 *
 * That paragraph rejected a stored mean partly because "4.3 is about to stamp
 * retrieverVersion: 'v4-bm25' on this row, which that number would make false".
 * 4.3 arrived and the stamp is real — but it is per-DIRECTION rather than
 * per-row, which sharpens the argument rather than weakening it. A mean is a
 * value belonging to neither direction, so under per-direction provenance there
 * would be no field it could honestly be labelled in at all.
 *
 * The one thing 4.3 changed about the paragraph's premise: the label is not
 * 'v4-bm25' alone. It is a version AND a params digest, because 'v4-bm25' does
 * not distinguish k1 1.2 from k1 2.0 and a stored strength's scale depends on
 * which. See the field comments below and EVALUATION.md §23.2.
 * ───────────────────────────────────────────────────────────────────────────
 */

const NoteLinkSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },

    /**
     * THE CANONICAL PAIR. noteA and noteB are the same two notes in every row
     * for that pair, ordered so that String(noteA) < String(noteB). The
     * ordering is not meaningful — it is a normal form, and it is what makes
     * the unique index below able to reject a reversed duplicate.
     */
    noteA: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      required: true
    },
    noteB: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      required: true
    },

    /**
     * scoreAB is score(noteA → noteB): noteA as the query, noteB as the
     * document. scoreBA is the other direction. null means "not observed" —
     * that direction's note has not been saved since 4.2 — and is NOT the same
     * as zero.
     *
     * NO `min`, NO `max`, AND THAT IS DECIDED RATHER THAN OMITTED. A retriever
     * score has no scale (§21.5): it was an overlap coefficient in [0,1] until
     * 4.1 and is now a raw BM25 score, unbounded above. Note.linkedNotes.
     * strength carries `min: 0` and satisfies it ONLY because v4 runs the
     * `lucene` idf variant — `robertson` goes negative for df > N/2 (§16.6), so
     * a legitimate param change would make Mongo reject the write. That is on
     * 4.1's noticed list and it is not inherited here.
     *
     * The constraint that is true of EVERY rung on the ladder is that a score
     * is a finite number, so that is the constraint this validates. Infinity
     * and NaN are the failures worth catching: assertHits already rejects them
     * inside retrieval, and a schema that disagreed with it would be the
     * weaker statement of the two.
     */
    scoreAB: { type: Number, default: null, validate: finiteOrNull },
    scoreBA: { type: Number, default: null, validate: finiteOrNull },

    /**
     * The shared-term lists, per direction. Always empty under v4-bm25, which
     * explains a hit with a COUNT rather than a list (§21.5), and populated
     * only by rows the migration carried over from v1-era Note.linkedNotes.
     *
     * They exist for exactly one reason: without them the migration would
     * DESTROY v1's sharedKeywords, and a migration that loses data is not one
     * that can be described as reversible.
     */
    sharedAB: { type: [String], default: [] },
    sharedBA: { type: [String], default: [] },

    /**
     * WHAT WROTE EACH DIRECTION. Phase 4.3.
     *
     * PER-DIRECTION, NOT PER-ROW, and 4.2's answer is not automatically this
     * one — it was re-decided. A row's two directions are written by two
     * different notes' saves at two different times, and after
     * migrations/001-canonical-edges.js a single row LEGITIMATELY holds a
     * v1-era coefficient in one direction and a v4-bm25 score in the other
     * (§21.8, §22.4). One retrieverVersion per row would therefore be false
     * exactly on the rows that motivated the field. §23.1.
     *
     * TWO FIELDS PER DIRECTION, AND A VERSION STRING ALONE WOULD NOT DO.
     * `retriever` is describe(handle).version — 'v4-bm25' — and it is the
     * legible half. `digest` is describe(handle).digest, sha256 over
     * {version, params}, and it is the identifying half: 'v4-bm25' is the same
     * string under k1 1.2 and k1 2.0, under idfVariant lucene and robertson,
     * under titleWeight 2 and 1, which are exactly the distinctions §13 and
     * §16.8's sweeps exist to make and §16.9's ablations flipped. A stored
     * strength is a RAW SCORE whose scale those params set (§21.5), so a bare
     * version does not make the number interpretable and a digest does.
     *
     * NOT THE WHOLE DESCRIPTOR. That is §8.5's sidecar convention applied at
     * the wrong unit, and §13.9 already worked the correction out: when
     * per-item provenance is identical across items the committed unit MOVES UP
     * A LEVEL — 342 sweep points became one manifest plus a per-point digest.
     * Every edge the live app writes shares one configuration; what varies row
     * to row is WHICH configuration, not what it contains. Copying
     * {k1, b, idfVariant, qtfMode, titleWeight} onto every edge of every user
     * stores one constant N times.
     *
     * FLAT FIELDS RATHER THAN A NESTED { version, digest } SUBDOCUMENT, and
     * that is §22.6's finding applied before it bit: mongoose generates an _id
     * for every subdocument, which is what moved the migration artifact's
     * digest between runs when nothing had changed. Four flat strings cannot do
     * that.
     *
     * `notePair.UNKNOWN_PROVENANCE` in both fields of a direction is a RECORDED
     * UNKNOWN and is not the same statement as null — that file's header argues
     * why, and why guessing 'v1-overlap' from a non-empty sharedKeywords list
     * was rejected.
     */
    retrieverAB: { type: String, default: null },
    retrieverBA: { type: String, default: null },
    digestAB: { type: String, default: null },
    digestBA: { type: String, default: null }
  },
  { timestamps: true }
);

function finiteOrNull(value) {
  return value === null || value === undefined || Number.isFinite(value);
}
finiteOrNull.message = 'score must be a finite number or null';

/**
 * ONE UNDIRECTED EDGE PER NOTE PAIR PER USER — and now the index says what the
 * comment says, which is the half that was wrong before.
 */
NoteLinkSchema.index({ user: 1, noteA: 1, noteB: 1 }, { unique: true });

/**
 * The incident-edge query is {user, $or: [{noteA: id}, {noteB: id}]}. Mongo can
 * use a different index per $or branch; the unique index above already serves
 * the noteA branch as a prefix, so only the noteB branch needs its own.
 */
NoteLinkSchema.index({ user: 1, noteB: 1 });

/**
 * THE PROVENANCE QUERY'S INDEXES. Phase 4.3, and there are two of them because
 * §23.1's answer was per-direction.
 *
 *   NoteLink.find({user, $or: [{retrieverAB: v}, {retrieverBA: v}]})
 *
 * is 4.3's Done criterion — "a query can return the edge set for a given
 * version" — and Mongo can use a different index per $or branch. Neither branch
 * is served as a prefix by anything above, so each needs its own. That is the
 * DIRECT PRICE of per-direction provenance: a per-row field would have needed
 * one index, and could not have described a mixed row.
 *
 * The pattern is 4.2's, reused rather than invented: {user, noteB} exists for
 * exactly the same reason on exactly the same shape of query.
 *
 * COST, and it is not measured here: every additional index makes every write
 * more expensive in index maintenance. §22.7 already states that the unique
 * index does this in a way the operation count cannot see, and two more indexes
 * add to it. results/write-cost.txt counts OPERATIONS ISSUED, which is
 * unchanged at 3 — provenance rides inside the existing $set — and that is a
 * different claim from a latency one.
 */
NoteLinkSchema.index({ user: 1, retrieverAB: 1 });
NoteLinkSchema.index({ user: 1, retrieverBA: 1 });

/**
 * The normal form and the derived weight are ATTACHED here, not defined here —
 * utils/notePair.js owns them, so the linker, the migration and the harness's
 * fake collection all share one definition without any of them having to load
 * mongoose to reach it. That file's header says why one definition matters.
 */
NoteLinkSchema.statics.canonicalPair = notePair.canonicalPair;
NoteLinkSchema.statics.directionFields = notePair.directionFields;
NoteLinkSchema.statics.weight = notePair.weight;
NoteLinkSchema.statics.weightProvenance = notePair.weightProvenance;
NoteLinkSchema.statics.UNKNOWN_PROVENANCE = notePair.UNKNOWN_PROVENANCE;

/**
 * The normal form is enforced on write as well as constructed on write. A row
 * that reached the database reversed would be a SECOND row for a pair that
 * already has one, and the unique index cannot see that — it indexes the fields
 * it is given, so {a,b} and {b,a} are two different keys and both are accepted.
 * The index guarantees uniqueness OF THE NORMAL FORM; this is what guarantees
 * the normal form.
 *
 * AND IT DOES NOT COVER bulkWrite, which is how the linker writes. Mongoose
 * document middleware runs for save() and create() and not for update
 * operations, so this hook protects hand-written code and the migration's
 * document path, while the linker's correctness rests on canonicalPair() alone.
 * That is why scripts/verify-migration.js checks the invariant with a QUERY
 * against a real database rather than trusting the hook: a guard whose coverage
 * is smaller than it looks is the kind of thing this repo has been bitten by
 * (§21.6).
 */
NoteLinkSchema.pre('validate', function assertCanonical(next) {
  if (this.noteA && this.noteB && !(String(this.noteA) < String(this.noteB))) {
    return next(new Error(
      `NoteLink: noteA must sort before noteB — got ${String(this.noteA)} and ${String(this.noteB)}. ` +
      'Build the row with NoteLink.canonicalPair().'
    ));
  }
  for (const side of ['AB', 'BA']) {
    const bad = provenanceKindError(side, this[`retriever${side}`], this[`digest${side}`]);
    if (bad) return next(new Error(bad));
  }
  return next();
});

/**
 * THE PAIRED-KIND INVARIANT. Phase 4.3.
 *
 * A direction's two provenance fields are in exactly one of three states, and
 * they are in the SAME one: both null (unlabelled), both the recorded-unknown
 * sentinel, or both real. `retrieverAB: 'v4-bm25'` beside `digestAB: 'unknown'`
 * is nonsense — it claims to know the configuration and to not know it — and so
 * is the reverse.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: that an observed score must carry a label.
 * That is TRUE AFTER 002 and false before it, and it is false in a state the
 * project will really be in — 4.2's linker writes scores and no labels, so
 * every row it wrote between the two deploys is legitimately score-without-
 * label. Baking a post-migration property into an always-property would make
 * the model reject a state the system is designed to pass through. It is
 * checked where it belongs instead: as a QUERY in
 * migrations/002-edge-provenance.js's verify(), over the collection, after the
 * migration.
 *
 * AND THIS HOOK DOES NOT COVER bulkWrite, which is how the linker and both
 * migrations write. §22.4 established that; nothing here changes it. The hook
 * protects the document path, and the real enforcement is the query.
 */
function provenanceKindError(side, retriever, digest) {
  const kind = (value) => {
    if (value === null || value === undefined) return 'null';
    return value === notePair.UNKNOWN_PROVENANCE ? 'unknown' : 'real';
  };
  const r = kind(retriever);
  const d = kind(digest);
  if (r === d) return null;
  return (
    `NoteLink: retriever${side} and digest${side} must agree in kind — got ${r} and ${d} ` +
    `(${JSON.stringify(retriever)}, ${JSON.stringify(digest)}). A direction knows its ` +
    'configuration or it does not; it cannot half-know it.'
  );
}

module.exports = mongoose.model('NoteLink', NoteLinkSchema);
