const Note = require('../models/Note');

async function loadUserCorpus(userId, { excludeId = null, limit = 500 } = {}) {
  const filter = { user: userId };
  if (excludeId) filter._id = { $ne: excludeId };
  const docs = await Note.find(filter).select('title contentText').limit(limit).lean();
  return docs.map((d) => ({ title: d.title || '', content: d.contentText || '' }));
}

module.exports = { loadUserCorpus };
