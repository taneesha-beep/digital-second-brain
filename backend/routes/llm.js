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

    const responseText = await processNote(contentText, feature);
    if (typeof responseText === 'string' && responseText.startsWith('Error:')) {
      return res.status(500).json({ message: responseText });
    }
    return res.json({ result: responseText });
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Failed to process LLM request' });
  }
});

module.exports = router;
