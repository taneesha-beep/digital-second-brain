const Note = require('../models/Note');

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .filter((k) => typeof k === 'string')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function intersectKeywords(sourceKeywords, targetKeywords) {
  const sourceSet = new Set(normalizeKeywords(sourceKeywords));
  return normalizeKeywords(targetKeywords).filter((k) => sourceSet.has(k));
}

async function computeAndSaveLinks(noteId, userId) {
  const source = await Note.findOne({ _id: noteId, user: userId }).lean();
  if (!source) return [];

  const others = await Note.find({ user: userId, _id: { $ne: source._id } }).lean();
  const sourceKeywords = normalizeKeywords(source.keywords);
  const denominator = Math.max(sourceKeywords.length, 1);

  const links = others
    .map((otherNote) => {
      const sharedKeywords = intersectKeywords(sourceKeywords, otherNote.keywords);
      const strength = sharedKeywords.length / denominator;
      return {
        noteId: otherNote._id,
        strength: Number(strength.toFixed(4)),
        sharedKeywords
      };
    })
    .filter((link) => link.strength > 0.15)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 8);

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
