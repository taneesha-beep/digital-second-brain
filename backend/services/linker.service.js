/**
 * linker.service.js — from Phase 4.1, a thin wrapper over backend/retrieval/.
 *
 * WHAT CHANGED. Lines 24-36 of the pre-4.1 file computed the ranked list here:
 * read the source note's STORED keywords, intersect them with every other
 * note's stored keywords, score by overlap coefficient, filter at 0.15, cap at
 * 8. That composition is exactly what retrieval/v1-overlap.js re-expresses, and
 * `results/parity/` is the byte-identical proof of it (§7.6). The computation
 * now happens in backend/retrieval/ over text, and this file does storage.
 *
 * WHAT DID NOT CHANGE. The bidirectional write below is untouched — it is
 * last-writer-wins, it makes the STORED graph depend on save order, and §7.6
 * quantified it at 15 differing lines between two store orderings. v1-overlap
 * deliberately never re-expressed it (§7.5) and 4.1 deliberately does not fix
 * it. Roadmap 4.2 is canonical edge storage; that is where the up-to-8
 * sequential findById+save round trips become one bulkWrite and where a pair
 * gets one weight by construction.
 *
 * THE LINKER NO LONGER READS note.keywords — AND THAT IS ONLY HALF OF §7.1's
 * OBLIGATION. §7.1 recorded that "the app must stop reading stored
 * note.keywords and let the shared index compute them". The linker now does.
 * routes/notes.js:119 still WRITES them, and graphBuilder.service.js and
 * routes/search.js?mode=semantic still READ them, so the app is in a stated
 * partial state: linking is v4-over-text, the graph view and semantic search
 * are still v1-over-stored-keywords. Removing the write breaks the graph, and
 * the graph builder is roadmap 4.4. EVALUATION.md §21.3.
 *
 * WHAT `strength` NOW HOLDS, because the field's meaning changed and nothing in
 * the schema says so. It was an overlap coefficient in [0, 1]. It is now the
 * raw retriever score, whose range is a property of the retriever: BM25 under
 * the `lucene` idf variant is unbounded above and strictly non-negative. No
 * rescaling is applied, because the only rescaling available — dividing by the
 * top score in this note's own result list — would make a stored strength
 * depend on which other notes exist, which is the corpus-epoch defect 4.6
 * exists to remove. Roadmap 4.3 puts `retrieverVersion` beside it, which is
 * what makes the number interpretable; until then it is a score without a scale
 * and this comment is the only place that says so.
 */

const Note = require('../models/Note');
const { indexUserNotes, relatedNotes, LINK_CAP } = require('./noteCorpus.service');

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
    // uniform contract across the ladder and expected Phase 7.4 to inherit it;
    // it arrives one rung earlier than that, here, because linkedNotes.
    // sharedKeywords is a real stored field with a real consumer. There is no
    // term list to put in it, so it is left empty rather than filled with
    // something reconstructed after the fact — a lexical overlap computed
    // beside a BM25 hit is a post-hoc rationalisation, not the reason the
    // document ranked. LinkedNotesPanel.jsx renders nothing when it is empty.
    sharedKeywords: []
  }));

  await Note.findByIdAndUpdate(source._id, { $set: { linkedNotes: links } });

  // Make links bidirectional: update each linked note to include the source
  for (const link of links) {
    const targetId = link.noteId;
    const targetNote = await Note.findById(targetId);
    if (!targetNote) continue;

    const existingLinkIndex = targetNote.linkedNotes.findIndex(
      (ln) => ln.noteId.toString() === source._id.toString()
    );

    if (existingLinkIndex === -1) {
      // Add the source note to target's linkedNotes
      targetNote.linkedNotes.push({
        noteId: source._id,
        strength: link.strength,
        sharedKeywords: link.sharedKeywords
      });
    } else {
      // Update the strength if already exists
      targetNote.linkedNotes[existingLinkIndex].strength = link.strength;
      targetNote.linkedNotes[existingLinkIndex].sharedKeywords = link.sharedKeywords;
    }

    await targetNote.save();
  }

  return links;
}

async function getLinkedNotes(noteId) {
  const note = await Note.findById(noteId)
    .populate('linkedNotes.noteId', 'title _id')
    .lean();

  if (!note) return [];
  return (note.linkedNotes || [])
    .sort((a, b) => (b.strength || 0) - (a.strength || 0));
}

module.exports = {
  computeAndSaveLinks,
  getLinkedNotes
};
