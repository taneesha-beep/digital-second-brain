const express = require('express');
const { protect } = require('../middleware/auth');
const { buildStudyPack } = require('../services/studyPack.service');

const router = express.Router();

router.use(protect);

/**
 * POST /api/study-pack/:noteId — Phase 5.1.
 *
 * A SEPARATE MOUNT FROM /api/llm, AND routes/llm.js IS NOT EDITED.
 *
 * The five single-note features are 5.1's A/B control. Hanging this off
 * /api/llm would put it behind `POST /:noteId/:feature`, which matches
 * `/study-pack/:id` with noteId='study-pack' unless route registration order is
 * exactly right — a correctness property held by line ordering in another file.
 * A separate mount cannot shadow the control and cannot be shadowed by it.
 *
 * The response is deliberately WIDER than what the panel renders. Everything
 * needed to audit a call is in it — which notes went into the prompt, which were
 * dropped for budget, the retriever version and digest that chose them, the
 * finish reason, and the citation counts. §28.3 records the opposite position:
 * `processNote()` returned a string and discarded `usage` and `finish_reason`,
 * so 5.3 could not measure four of its own deliverables through the shipped
 * surface and had to cut a frozen copy instead. 5.4 consumes these fields; the
 * panel ignores most of them.
 */
router.post('/:noteId', async (req, res) => {
  const { noteId } = req.params;

  try {
    const pack = await buildStudyPack(noteId, req.user.id);
    if (!pack) {
      return res.status(400).json({ message: 'Note not found or access denied' });
    }
    return res.json(pack);
  } catch (err) {
    // Same shape as routes/llm.js: 500 with the mapped message. The `status`
    // and `code` the service carries forward (§29.6) stay server-side — they
    // exist so a HARNESS can branch on a 429, and a browser client cannot do
    // anything with them that the message does not already say.
    return res.status(500).json({ message: err.message || 'Failed to build study pack' });
  }
});

module.exports = router;
