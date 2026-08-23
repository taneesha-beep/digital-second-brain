const NoteVersion = require('../models/NoteVersion');
// Phase 6.3. No-ops entirely unless DSB_TRACING=1 — observability/sdk.js.
const { failActiveSpan } = require('../observability');

const MAX_VERSIONS_PER_NOTE = 20;

const saveVersion = async (noteId, content, contentText) => {
  if (!noteId) return null;
  try {
    const totalBefore = await NoteVersion.countDocuments({ noteId });
    const versionNumber = totalBefore + 1;

    const savedVersion = await NoteVersion.create({
      noteId,
      versionNumber,
      content: content ?? {},
      contentText: contentText ?? ''
    });

    const totalAfter = totalBefore + 1;
    if (totalAfter > MAX_VERSIONS_PER_NOTE) {
      const toDelete = totalAfter - MAX_VERSIONS_PER_NOTE;
      const stale = await NoteVersion
        .find({ noteId })
        .sort({ savedAt: 1, versionNumber: 1 })
        .limit(toDelete)
        .select('_id')
        .lean();

      if (stale.length > 0) {
        await NoteVersion.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
      }
    }

    return savedVersion;
  } catch (err) {
    // PHASE 6.3, AND IT IS ONE LINE FOR A REASON WORTH THE PARAGRAPH.
    //
    // This catch is why `saveVersion` is not what CLAUDE.md describes. The two
    // background jobs are documented as failing to console.error and nothing
    // else; that is true of computeAndSaveLinks, whose rejection at least
    // reaches the caller's `.catch`. This one never rejects at all — it logs
    // here and returns null — so the caller's handler has never once fired and
    // the 6.3 span wrapped around the call would report SUCCESS on every
    // failure. §22.6's shape exactly: a check that runs and cannot fail.
    //
    // Marking the ACTIVE span rather than taking one as a parameter keeps this
    // function's signature and its purity story unchanged, and it is correct
    // precisely because routes/notes.js starts that span with startActiveSpan.
    // With tracing off there is no active span and this returns null.
    //
    // The log line, the return value and the control flow below are untouched:
    // a version save failing is still non-critical and still must not fail the
    // request that caused it.
    failActiveSpan(err);
    console.error('Version save failed (non-critical):', err.message);
    return null;
  }
};

async function getVersions(noteId) {
  const versions = await NoteVersion.find({ noteId })
    .sort({ savedAt: -1 })
    .select('versionNumber savedAt contentText')
    .lean();

  return versions.map((version) => ({
    versionNumber: version.versionNumber,
    savedAt: version.savedAt,
    contentText: String(version.contentText || '').slice(0, 100)
  }));
}

module.exports = {
  saveVersion,
  getVersions
};
