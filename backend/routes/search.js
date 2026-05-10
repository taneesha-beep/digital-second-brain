const express = require('express');
const router  = express.Router();
const Note    = require('../models/Note');
const { protect } = require('../middleware/auth');
const { extractKeywords } = require('../utils/keywords');

router.use(protect);

// ── helpers ───────────────────────────────────────────────────────────────────

function snippet(text, query = '', maxLen = 180) {
  const t = String(text || '');
  if (!query) return t.slice(0, maxLen);
  const idx = t.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return t.slice(0, maxLen);
  const start = Math.max(0, idx - 60);
  const end   = Math.min(t.length, idx + 120);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

function formatNote(note, query) {
  return {
    _id:      note._id,
    title:    note.title,
    tags:     note.tags     || [],
    keywords: note.keywords || [],
    snippet:  snippet(note.contentText, query),
    createdAt: note.createdAt
  };
}

// ── GET /api/search ───────────────────────────────────────────────────────────
// Query params:
//   q       – search string
//   mode    – keyword (default) | semantic | tags
//   tags    – comma-separated tag list (used in tags mode or combined)
router.get('/', async (req, res) => {
  try {
    const q        = String(req.query.q    || '').trim();
    const mode     = String(req.query.mode || 'keyword').toLowerCase();
    const tagsRaw  = String(req.query.tags || '').trim();
    const tagsArr  = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

    let results = [];

    // ── Tags mode — must come before empty-query check ────────────────────
    if (mode === 'tags' || (!q && tagsArr.length > 0)) {
      const tagQuery = q.trim()
        ? q.trim().toLowerCase().replace(/^#+/, '')
        : tagsArr[0];
      // Search tags array AND title/contentText for the tag string
      results = await Note.find({
        user: req.user._id,
        $or: [
          { tags:     { $regex: tagQuery, $options: 'i' } },
          { keywords: { $regex: tagQuery, $options: 'i' } },
          { title:    { $regex: tagQuery, $options: 'i' } }
        ]
      })
        .select('title tags keywords createdAt contentText')
        .limit(20)
        .lean();
      return res.json(results.map((n) => formatNote(n, tagQuery)));
    }

    // ── Empty query → return 10 most recent notes ─────────────────────────
    if (!q && tagsArr.length === 0) {
      const recent = await Note.find({ user: req.user._id })
        .select('title tags keywords createdAt contentText')
        .sort({ updatedAt: -1 })
        .limit(10)
        .lean();
      return res.json(recent.map((n) => formatNote(n, '')));
    }

    // ── Semantic mode — extract query keywords, score by overlap ─────────
    if (mode === 'semantic' && q) {
      const queryKeywords = extractKeywords('', q, [], 10);
      const allNotes = await Note.find({ user: req.user._id })
        .select('title tags keywords createdAt contentText')
        .lean();

      // Score each note by how many query keywords it contains
      const scored = allNotes
        .map((note) => {
          const noteKws  = new Set((note.keywords || []).map((k) => k.toLowerCase()));
          const titleWords = String(note.title || '').toLowerCase();
          const bodyWords  = String(note.contentText || '').toLowerCase();

          let score = 0;
          for (const kw of queryKeywords) {
            if (noteKws.has(kw))              score += 3; // keyword match
            if (titleWords.includes(kw))      score += 2; // title match
            if (bodyWords.includes(kw))       score += 1; // body match
          }
          // Also boost notes whose title contains the raw query
          if (titleWords.includes(q.toLowerCase())) score += 5;

          return { note, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

      return res.json(scored.map(({ note }) => formatNote(note, q)));
    }

    // ── Keyword mode (default) — MongoDB $text search ─────────────────────
    // Fallback to regex if text index isn't set up
    if (q) {
      try {
        results = await Note.find({
          user: req.user._id,
          $text: { $search: q }
        }, {
          score: { $meta: 'textScore' }
        })
          .select('title tags keywords createdAt contentText')
          .sort({ score: { $meta: 'textScore' } })
          .limit(20)
          .lean();
      } catch {
        // Text index not available — fall back to regex
        results = await Note.find({
          user: req.user._id,
          $or: [
            { title:       { $regex: q, $options: 'i' } },
            { contentText: { $regex: q, $options: 'i' } },
            { tags:        { $regex: q, $options: 'i' } },
            { keywords:    { $regex: q, $options: 'i' } }
          ]
        })
          .select('title tags keywords createdAt contentText')
          .limit(20)
          .lean();
      }

      // Also filter by tags if provided alongside keyword search
      if (tagsArr.length > 0) {
        results = results.filter((n) =>
          tagsArr.some((tag) => (n.tags || []).includes(tag))
        );
      }

      return res.json(results.map((n) => formatNote(n, q)));
    }

    return res.json([]);
  } catch (err) {
    return res.status(500).json({ message: err.message || 'Search error' });
  }
});

module.exports = router;