const express = require('express');
const { objectIdParam } = require('../middleware/objectId');
const router  = express.Router();

// A malformed id in the URL used to be a 500 on every one of these routes —
// `Note.findOne({_id: 'banana'})` throws a CastError and the catch maps it to
// "Error fetching". Measured at 12 of 12 id-taking endpoints across 5 routers.
// This answers with the SAME response this router already gives for a note that
// is simply absent, so a malformed id is indistinguishable from a missing one.
// See middleware/objectId.js for why that rather than a 400.
//
// router.param runs AFTER router.use, so `protect` and any rate limiter still
// see the request and still count it. A test pins that ordering.
router.param('noteId', objectIdParam({ status: 404, message: 'Note not found or access denied' }));

const { protect } = require('../middleware/auth');
const { buildGlobalGraph, buildNoteGraph, expandKeyword } = require('../services/graphBuilder.service');
const Note = require('../models/Note');

router.use(protect);

// GET /api/graph/note/:noteId
// Returns Cytoscape elements for the per-note hierarchical graph.
// Optional query: ?expanded=kw1,kw2  (pre-expanded keywords)
router.get('/note/:noteId', async (req, res) => {
  try {
    const { noteId } = req.params;
    const note = await Note.findOne({ _id: noteId, user: req.user.id })
      .select('_id keywords').lean();
    if (!note) return res.status(404).json({ message: 'Note not found or access denied' });

    const expandedKeywords = req.query.expanded
      ? req.query.expanded.split(',').map((k) => k.trim()).filter(Boolean)
      : [];

    const graph = await buildNoteGraph(noteId, expandedKeywords);
    return res.json(graph);
  } catch (err) {
    console.error('[graph/note]', err);
    return res.status(500).json({ message: err.message || 'Failed to build note graph' });
  }
});

// GET /api/graph/note/:noteId/expand/:keyword
// Lazy-loads Level-2 sub-keyword nodes for a single keyword click.
router.get('/note/:noteId/expand/:keyword', async (req, res) => {
  try {
    const { noteId, keyword } = req.params;
    const note = await Note.findOne({ _id: noteId, user: req.user.id })
      .select('_id').lean();
    if (!note) return res.status(404).json({ message: 'Note not found or access denied' });

    const kw = String(keyword || '').trim();
    if (!kw) return res.status(400).json({ message: 'Keyword required' });

    const result = await expandKeyword(noteId, kw);
    return res.json(result);
  } catch (err) {
    console.error('[graph/expand]', err);
    return res.status(500).json({ message: err.message || 'Failed to expand keyword' });
  }
});

// GET /api/graph/global
router.get('/global', async (req, res) => {
  try {
    const graph = await buildGlobalGraph(req.user.id);
    return res.json(graph);
  } catch (err) {
    console.error('[graph/global]', err);
    return res.status(500).json({ message: err.message || 'Failed to build global graph' });
  }
});

module.exports = router;