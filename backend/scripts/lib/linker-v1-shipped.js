'use strict';

/**
 * linker-v1-shipped.js — Phase 4.1. THE PRE-4.1 LINKER, PRESERVED.
 *
 * NOT SHIPPED CODE. Nothing under backend/routes/, backend/services/ or
 * backend/models/ requires this file. Its only caller is scripts/parity-v1.js,
 * and through it tests/retrieval.v1-parity.test.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS, WHICH IS A CONSEQUENCE 4.1 CAUSED AND HAD TO REPAIR.
 *
 * §7.6's parity proof compares TWO IMPLEMENTATIONS of one algorithm:
 *
 *   shipped side   utils/keywords.js + utils/corpus.js + linker.service.js,
 *                  required unmodified and run as routes/notes.js runs them
 *   harness side   retrieval/v1-overlap.js
 *
 * and §7.5's whole argument is that "comparing a reimplementation against a
 * reimplementation would prove nothing". Phase 4.1 rewired
 * services/linker.service.js to go through the retrieval interface — so the
 * shipped side of that comparison STOPPED BEING THE SHIPPED v1 ALGORITHM and
 * became v4-bm25. `npm test` caught it: two v1-parity tests failed, one of them
 * showing BM25-scale scores in a file whose header says overlap coefficient.
 *
 * Two thirds of the shipped side are untouched and still run live: keywords.js
 * and corpus.js are unmodified by 4.1 and are still what routes/notes.js:118-119
 * calls in production. Only the SCORING — the pre-4.1 linker.service.js lines
 * 24-36, the payload of the $set — has no live counterpart any more. It is
 * preserved here rather than deleted, because the alternative is a parity proof
 * whose two halves are both retrieval/v1-overlap.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT "PRESERVED" MEANS HERE, AND HOW IT IS CHECKED.
 *
 *   source        backend/services/linker.service.js
 *   at            tag v0-pre-reorientation, commit 30e1329
 *   whole file    sha256 a982a71a28c309346af7fedfeaac9cab4ea057aec97cba9a666fff525041ff74
 *
 * The tag exists for exactly this ("Tag v0-pre-reorientation on the current
 * shipped code, permanently reachable" — END-STATE §4), and it was verified
 * byte-identical to origin/main's copy at 0fb7829 before this file was written,
 * so there is no ambiguity about which bytes "the shipped algorithm" names.
 *
 * ONE LINE DIFFERS AND IT IS THE FIRST ONE: `require('../models/Note')` becomes
 * `require('../../models/Note')`, because this file sits two directories deeper.
 * Both resolve to the same path, which is the path fake-note-store's install()
 * primes. Everything after it is byte-for-byte the tagged file, delimited below
 * and hashed by tests/retrieval.v1-parity.test.js against
 * sha256 579e1f0b9b5270642abb10e1370e373f8e40aa6cfbc8c8a979b3c2d2e027c03f
 * — which is the tagged file from line 2, reproducible with:
 *
 *   git show v0-pre-reorientation:backend/services/linker.service.js \
 *     | tail -n +2 | shasum -a 256
 *
 * A behavioural check sits behind the byte check and is the stronger of the
 * two: if this copy diverged, results/parity/v1-shipped.txt would stop
 * reproducing 83f9e35e… and the parity test would fail on the output rather
 * than on the source.
 */

const Note = require('../../models/Note');

// ─── BEGIN VERBATIM — do not edit below this line ──────────────────────────

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

// ─── END VERBATIM ──────────────────────────────────────────────────────────
