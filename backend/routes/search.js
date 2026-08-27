const express = require('express');
const router  = express.Router();
const Note    = require('../models/Note');
const { protect } = require('../middleware/auth');
const { extractKeywords } = require('../utils/keywords');
const { loadUserCorpus } = require('../utils/corpus');

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
    //
    // ⚠️ NO `excludeId`, AND THAT IS CORRECT — the note below is not.
    //
    // CLAUDE.md has carried this call as "one real bug left behind" since 4.6,
    // on the grounds that the missing `excludeId` gives a >500-note user "a
    // different semantic-search match set". 4.6's OWN measurement says the
    // opposite and is the one to trust: the query here is a SEARCH STRING, not
    // a stored note, so there is nothing to leave out. There is no defect in
    // the missing argument. Re-verified 27 Aug 2026 at the pre-Phase-8 sweep.
    //
    // WHAT IS REAL IS ONE LINE DOWN, AND NOTHING HAS EVER SAID IT. The IDF
    // corpus is capped at 500 notes by loadUserCorpus; the MATCH SET below has
    // no `.limit()` at all. So above 500 notes the query's keywords are
    // weighted by a 500-note sample while every note in the notebook is scored
    // against them. That asymmetry is unique to this route — notes.js:191 and
    // upload.js:56 both extract against the same capped corpus they then write
    // into.
    //
    // DELIBERATELY NOT ALIGNED, AND THE REASON IS WHICH DIRECTION THE FIX
    // RUNS. Capping the match set to match the corpus would make search find
    // FEWER of a large user's notes, which is a worse product outcome than an
    // approximate rarity signal. Raising the corpus cap is a different change
    // with a cost nobody has measured. Both are product decisions and neither
    // is a bug fix, so the asymmetry is recorded here rather than removed.
    //
    // One more thing a reader should not have to discover: `mode=semantic`
    // scores against STORED note.keywords — the v1 selection — so this route is
    // one of the four remaining readers of that field, and it is not the
    // v4-bm25 path the linker uses. The name is a misnomer inherited from an
    // earlier design; no embeddings are involved.
    if (mode === 'semantic' && q) {
      const corpus = await loadUserCorpus(req.user._id);
      const queryKeywords = extractKeywords('', q, corpus, 10);
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