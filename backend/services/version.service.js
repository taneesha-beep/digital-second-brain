const NoteVersion = require('../models/NoteVersion');

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
