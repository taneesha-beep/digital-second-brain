const express = require('express');
const { protect } = require('../middleware/auth');
const { llmLimiter, quotaDailyLimiter } = require('../middleware/rateLimit');
const Note = require('../models/Note');
const { processNote } = require('../services/llm.service');

const router = express.Router();

router.use(protect);

// Phase 0.3, finally. HERE rather than in server.js for two reasons, both in
// middleware/rateLimit.js's header: the key is req.user.id, which only exists
// after protect; and server.js's mounts are scraped by
// tests/integration.app.test.js with a single-argument regex, so a limiter
// passed there as a second argument would delete this route from that suite's
// mount list rather than fail loudly.
//
// PER-USER FIRST, GLOBAL SECOND. A request the per-user limiter refuses never
// reaches the shared daily budget, so one looping client spends its own
// allowance rather than everybody's.
//
// services/llm.service.js IS NOT EDITED. tests/gen-shipped-parity.test.js reads
// that file's source and asserts it differs from the frozen v1 copy at exactly
// MODEL and max_tokens; a third edit turns it red, and the prompts, the system
// message and temperature 0.4 are 5.1's A/B control.
router.use(llmLimiter);
router.use(quotaDailyLimiter);

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
