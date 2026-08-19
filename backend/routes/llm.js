const express = require('express');
const { protect } = require('../middleware/auth');
const Note = require('../models/Note');
const { processNote } = require('../services/llm.service');

const router = express.Router();

router.use(protect);

// POST /api/llm/:noteId/:feature
router.post('/:noteId/:feature', async (req, res) => {
  const { noteId, feature } = req.params;

  try {
    const note = await Note.findOne({ _id: noteId, user: req.user.id }).lean();
    if (!note) {
      return res.status(400).json({ message: 'Note not found or access denied' });
    }

    const contentText = String(note.contentText || '').trim();
    if (!contentText) {
      return res.status(400).json({ message: 'Note contentText is empty' });
    }

    // processNote returns an observation from 5.5 — text plus the usage and
    // finish_reason it used to discard. The response shape is unchanged:
    // `result` is the same string it always was, and AIPanel.jsx reads it the
    // same way. The rest stays server-side until 5.4 has somewhere to put it.
    const { text } = await processNote(contentText, feature);
    return res.json({ result: text });
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Failed to process LLM request' });
  }
});

module.exports = router;
