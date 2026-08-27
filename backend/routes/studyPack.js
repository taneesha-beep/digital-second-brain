const express = require('express');
const { protect } = require('../middleware/auth');
const { studyPackLimiter, quotaDailyLimiter } = require('../middleware/rateLimit');
const { buildStudyPack } = require('../services/studyPack.service');
const { objectIdParam } = require('../middleware/objectId');

const router = express.Router();

// A malformed id in the URL used to be a 500 on every one of these routes —
// `Note.findOne({_id: 'banana'})` throws a CastError and the catch maps it to
// "Error fetching". Measured at 12 of 12 id-taking endpoints across 5 routers.
// This answers with the SAME response this router already gives for a note that
// is simply absent, so a malformed id is indistinguishable from a missing one.
// See middleware/objectId.js for why that rather than a 400.
//
// router.param runs AFTER router.use, so `protect` and any rate limiter still
// see the request and still count it. A test pins that ordering.
router.param('noteId', objectIdParam({ status: 400, message: 'Note not found or access denied' }));


router.use(protect);

// Phase 0.3's criterion EXTENDED, 25 Aug 2026. 0.3 was written on 31 Jul 2026
// and names /api/llm/* only, because this endpoint did not exist until 5.1.
// services/studyPack.service.js:504 constructs its own `new Groq()` and never
// touches llm.service.js, so nothing mounted on /api/llm covers this route —
// and results/studypack-constants.txt §C prices a pack at 5508 reserved tokens
// against a single-note feature's ~2338, making the uncovered one the expensive
// one. A tighter per-user limit than /api/llm for that reason; the same shared
// daily budget, because there is only one organisation quota.
router.use(studyPackLimiter);
router.use(quotaDailyLimiter);

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
