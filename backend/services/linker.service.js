/**
 * linker.service.js — a thin wrapper over backend/retrieval/ (4.1), writing
 * canonical edges (4.2).
 *
 * WHAT 4.1 CHANGED. Lines 24-36 of the pre-4.1 file computed the ranked list
 * here: read the source note's STORED keywords, intersect them with every other
 * note's stored keywords, score by overlap coefficient, filter at 0.15, cap at
 * 8. That composition is exactly what retrieval/v1-overlap.js re-expresses and
 * results/parity/ is the byte-identical proof of it (§7.6). The computation
 * moved into backend/retrieval/ over text, and this file does storage.
 *
 * WHAT 4.2 CHANGES, WHICH IS THE STORAGE 4.1 LEFT ALONE. The bidirectional
 * write is gone. It was last-writer-wins — it wrote the SOURCE's strength into
 * the TARGET's record, so the stored graph depended on save order (PRIMER
 * §3.5), and §7.6 quantified it at 15 differing lines between two store
 * orderings. Links now live in one canonical row per unordered pair, in
 * models/NoteLink.js, behind a unique index on {user, noteA, noteB}.
 *
 *   before   findOne + find + findByIdAndUpdate, then findById + save PER LINK
 *            ops = 3 + 2 x links, EXACT on all 34 fixture notes
 *            min 9, p50 19, mean 18.06, max 19       results/write-cost.txt
 *   after    findOne + find + ONE ordered bulkWrite
 *            3, constant in the link count
 *
 * A bulkWrite is one command and N server-side writes; results/write-cost.txt
 * states that where the number is quoted, and it is not a latency measurement.
 *
 * WHICH DIRECTION A CANONICAL EDGE STORES — the actual decision, and it is
 * argued at length in models/NoteLink.js's header rather than here, because it
 * is a property of the storage rather than of this caller. In one line: BOTH,
 * because v4-bm25 is asymmetric (§14.5's amendment measures 190 of 197 pairs
 * disagreeing), each direction is replaced only by its own source's save, and
 * the single pair weight is derived by NoteLink.weight() rather than stored.
 *
 * Note.linkedNotes IS NO LONGER WRITTEN. It is not derived and it is not
 * dual-written: it is retired, kept on disk untouched as the migration's
 * rollback, and no route serves it any more. models/Note.js says so at the
 * field. getLinkedNotes() below is the read path that replaces it, and it
 * returns the identical response shape, so LinkedNotesPanel.jsx needs no change
 * and FROZEN.md needs no second exception.
 *
 * THE LINKER STILL DOES NOT READ note.keywords, AND THAT IS STILL HALF OF
 * §7.1's OBLIGATION. routes/notes.js:119 keeps writing them, and
 * graphBuilder.service.js and routes/search.js?mode=semantic keep reading them.
 * So the app remains in the stated partial state 4.1 recorded: linking is
 * v4-over-text, the graph view and semantic search are still
 * v1-over-stored-keywords. The graph builder is roadmap 4.4.
 *
 * WHAT A STORED SCORE MEANS. It is the raw retriever score, not a coefficient
 * in [0,1] — unbounded above, and non-negative only because v4 runs the
 * `lucene` idf variant (§16.6). No rescaling is applied: the only one available
 * would divide by the top score in the note's own list, which would make a
 * stored score depend on which other notes exist — the corpus-epoch defect 4.6
 * exists to remove. Roadmap 4.3 puts retrieverVersion beside it, which is what
 * makes the number interpretable; until then it is a score without a scale.
 */

const Note = require('../models/Note');
const NoteLink = require('../models/NoteLink');
const { indexUserNotes, relatedNotes, LINK_CAP } = require('./noteCorpus.service');

/**
 * Recompute one note's outgoing edges and write them as canonical rows.
 *
 * ONE ORDERED bulkWrite, and the order is load-bearing:
 *
 *   1. CLEAR. The source's outgoing direction is nulled on every row it touches
 *      — both branches, because the source is noteA in some pairs and noteB in
 *      others. Without this, a link the retriever no longer returns would
 *      survive forever: the upserts below only ever write the pairs that ARE
 *      hits, so a dropped pair is invisible to them.
 *   2. UPSERT. One per hit. The filter carries the canonical pair, so an
 *      existing row is updated and a new one is inserted, and the unique index
 *      is what makes "or" exclusive rather than hopeful.
 *   3. DELETE the rows left with neither direction observed. A pair nobody
 *      ranks any more is not an edge, and leaving null-null rows would make
 *      every incident-edge query pay for them.
 *
 * Steps 1 and 3 must bracket step 2, so the batch is ordered — which is
 * bulkWrite's default and is passed explicitly anyway, because a default that
 * matters is a default worth writing down.
 */
async function computeAndSaveLinks(noteId, userId) {
  const source = await Note.findOne({ _id: noteId, user: userId }).lean();
  if (!source) return [];

  const handle = await indexUserNotes(userId);
  const hits = relatedNotes(handle, source._id, LINK_CAP);

  const links = hits.map((hit) => ({
    noteId: hit.docId,
    strength: Number(hit.score.toFixed(4)),
    // v4-bm25's `explain` is {shared: <count>}, a NUMBER, where v1's was
    // {sharedKeywords: [...]}, a LIST. §17.12 found that `explain` cannot be a
    // uniform contract across the ladder. There is no term list to put here, so
    // it is left empty rather than filled with something reconstructed after
    // the fact — a lexical overlap computed beside a BM25 hit is a post-hoc
    // rationalisation, not the reason the document ranked.
    sharedKeywords: []
  }));

  const ops = [
    { updateMany: { filter: { user: userId, noteA: source._id }, update: { $set: { scoreAB: null, sharedAB: [] } } } },
    { updateMany: { filter: { user: userId, noteB: source._id }, update: { $set: { scoreBA: null, sharedBA: [] } } } }
  ];

  for (const link of links) {
    const { noteA, noteB, forward } = NoteLink.canonicalPair(source._id, link.noteId);
    const f = NoteLink.directionFields(forward);
    ops.push({
      updateOne: {
        filter: { user: userId, noteA, noteB },
        update: {
          $set: { [f.score]: link.strength, [f.shared]: link.sharedKeywords },
          $setOnInsert: { [f.reverseScore]: null, [f.reverseShared]: [] }
        },
        upsert: true
      }
    });
  }

  ops.push({ deleteMany: { filter: { user: userId, scoreAB: null, scoreBA: null } } });

  await NoteLink.bulkWrite(ops, { ordered: true });

  return links;
}

/**
 * One note's related notes, as the ranked list the UI reads.
 *
 * THE RESPONSE SHAPE IS UNCHANGED from the linkedNotes era — {noteId, strength,
 * sharedKeywords} sorted descending — so LinkedNotesPanel.jsx is untouched.
 * `direction` is added, and it is the only new field: it is the one piece of
 * information canonical storage has that the old array could not express.
 *
 * SORTING, WHICH IS THE ONE PLACE THIS DESIGN HAD TO CHOOSE. A pair can carry
 * one direction or two, and a note's edge set is now the UNION of "notes it
 * ranked" and "notes that ranked it". Outgoing links sort first, by the note's
 * OWN score — which is exactly the ordering v4-bm25 returned for it, and
 * preserving that is what keeping two scores bought. Incoming-only links follow,
 * by the score the other note gave. They are a different class of evidence and
 * they are ordered as one rather than interleaved on a number that would mean
 * two different things down one column.
 */
async function getLinkedNotes(noteId, userId) {
  const rows = await NoteLink.find({
    user: userId,
    $or: [{ noteA: noteId }, { noteB: noteId }]
  })
    .populate('noteA', 'title _id')
    .populate('noteB', 'title _id')
    .lean();

  const id = String(noteId);
  const links = [];

  for (const row of rows) {
    const aId = String(row.noteA && row.noteA._id ? row.noteA._id : row.noteA);
    const isA = aId === id;
    const other = isA ? row.noteB : row.noteA;
    // A row whose far endpoint no longer resolves is a deleted note that the
    // delete route did not reach. Skipping is right for a read path — this is
    // not the place to repair the store — and verify-migration.js counts them.
    if (!other) continue;

    const own = isA ? row.scoreAB : row.scoreBA;
    const reverse = isA ? row.scoreBA : row.scoreAB;
    const ownShared = isA ? row.sharedAB : row.sharedBA;
    const reverseShared = isA ? row.sharedBA : row.sharedAB;
    const outgoing = own !== null && own !== undefined;

    links.push({
      noteId: other,
      strength: outgoing ? own : reverse,
      sharedKeywords: (outgoing ? ownShared : reverseShared) || [],
      direction: outgoing ? 'out' : 'in'
    });
  }

  return links.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1) ||
      (b.strength || 0) - (a.strength || 0)
  );
}

module.exports = {
  computeAndSaveLinks,
  getLinkedNotes
};
