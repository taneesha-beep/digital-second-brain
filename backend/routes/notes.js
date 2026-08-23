const express   = require('express');
const router    = express.Router();
const Note      = require('../models/Note');
const NoteLink  = require('../models/NoteLink');
const NoteVersion = require('../models/NoteVersion');
const { protect } = require('../middleware/auth');
const { extractKeywords } = require('../utils/keywords');
const { loadUserCorpus } = require('../utils/corpus');
const { buildGlobalGraph } = require('../services/graphBuilder.service');
const { computeAndSaveLinks, getLinkedNotes } = require('../services/linker.service');
const { saveVersion, getVersions } = require('../services/version.service');
// Phase 6.1, extended at 6.3. No-ops entirely unless DSB_TRACING=1 —
// observability/sdk.js. This is the ONLY OpenTelemetry-aware require in this
// file on purpose: @opentelemetry/api is never imported directly by app code,
// which is what keeps "how much OTel is in here" answerable by reading one
// line. A test asserts it.
const {
  withSpan, SPANS,
  fireDetached, currentSpanContext, JOBS, DSB_JOB
} = require('../observability');

router.use(protect);

// ── Helpers ──────────────────────────────────────────────────────────────────

function blockNoteToPlainText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(blockNoteToPlainText).join(' ').trim();
  if (typeof value === 'object') {
    const ownText   = typeof value.text === 'string' ? value.text : '';
    const fromContent  = blockNoteToPlainText(value.content);
    const fromChildren = blockNoteToPlainText(value.children);
    return [ownText, fromContent, fromChildren].filter(Boolean).join(' ').trim();
  }
  return '';
}

/**
 * Normalise whatever the client sends as `content`.
 * Quill Delta { ops: [...] } is stored as-is.
 * Legacy plain strings are wrapped as { text } for backwards compat.
 * Anything else (null, undefined, empty array) becomes {}.
 */
function normalizeContent(value) {
  if (!value) return {};
  // Quill Delta — has an ops array
  if (typeof value === 'object' && Array.isArray(value.ops)) return value;
  // Any other object (legacy { text: '...' } or block-note arrays) — keep as-is
  if (typeof value === 'object') return value;
  // Plain string — wrap for backwards compat
  if (typeof value === 'string' && value.trim()) return { text: value };
  return {};
}

/**
 * Fire one of the two un-awaited background jobs inside a detached, linked
 * span. Phase 6.3.
 *
 * THE JOB IS STILL NOT AWAITED, WHICH IS THE WHOLE CONSTRAINT. Nothing here
 * adds a round trip to the request: `origin` is read from the active context
 * synchronously by the caller, the span is created synchronously, and
 * fireDetached() returns nothing at all — so this cannot be awaited by
 * accident, which is a stronger guarantee than a comment saying not to. The
 * awaited operation count on both save routes is unchanged: PUT is still
 * findOne + loadUserCorpus + save, POST is still create.
 *
 * THE SWALLOW LIVES IN fireDetached() AND THE WORDING LIVES HERE. detachedSpan
 * rethrows on purpose, so something must catch; putting the catch in
 * observability/ is what lets it be tested without a database, and passing the
 * log line in from here is what keeps that module out of the business of
 * choosing words. THE LABELS ARE THE ONES THAT WERE ALREADY THERE, verbatim —
 * they are the string somebody greps a terminal for, and 6.3 has no business
 * renaming them.
 */
function fireJob(jobName, origin, noteId, run, label) {
  fireDetached(
    jobName,
    origin,
    run,
    { [DSB_JOB.NOTE_ID]: String(noteId) },
    (err) => console.error(`${label}:`, (err && err.message) || err)
  );
}

// Run linking in background — never blocks the response.
function runLinkingAsync(noteId, userId, origin) {
  fireJob(
    JOBS.LINK,
    origin,
    noteId,
    () => computeAndSaveLinks(noteId, userId),
    'Background linking error'
  );
}

// ── GET /api/notes ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // linkedNotes is deprecated at 4.2 and no longer written (models/Note.js).
    // Excluding it here is what stops a retired field being served as though it
    // were current — a stale array in an API response is a second source of
    // truth whether or not anything reads it.
    const notes = await Note.find({ user: req.user._id })
      .select('-linkedNotes')
      .sort({ updatedAt: -1 })
      .lean();
    res.json(notes);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching notes' });
  }
});

// ── GET /api/notes/graph ──────────────────────────────────────────────────────
router.get('/graph', async (req, res) => {
  try {
    const graph = await buildGlobalGraph(req.user._id);
    res.json(graph);
  } catch (err) {
    res.status(500).json({ message: 'Error building graph data' });
  }
});

// ── POST /api/notes ───────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const note = await Note.create({
      title:       req.body.title       || 'Untitled Note',
      content:     req.body.content     || {},
      contentText: req.body.contentText || '',
      user:        req.user._id,
      tags:        [],
      keywords:    []
    });
    // Run linking in background — don't await so response is instant.
    //
    // Phase 6.3: the context is captured HERE, synchronously, while the request
    // is still the active span. By the time the job runs the response has been
    // sent and there is no active context left to inherit — which is precisely
    // why propagation has to be explicit rather than ambient.
    runLinkingAsync(note._id, req.user._id, currentSpanContext());
    res.status(201).json(note);
  } catch (err) {
    console.error('Full create error:', err);
    res.status(500).json({ message: err.message || 'Error creating note' });
  }
});

// ── PUT /api/notes/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  // Client-writable fields only. `keywords` and `embedding` are derived
  // server-side; accepting them from the body let a caller desync a note's
  // vector from its text and poison every downstream link.
  const { title, content, contentText, category, tags } = req.body;
  try {
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id });
    if (!note) return res.status(404).json({ message: 'Note not found' });

    if (title !== undefined)     note.title   = title;

    // Phase 6.1's `normalize` span. THE WHOLE content-shaping block, not just
    // normalizeContent(): this is the stage that turns the three historical
    // content shapes into contentText, and blockNoteToPlainText is half of it.
    //
    // ⚠️ THIS STAGE EXISTS ONLY ON PUT. `POST /api/notes` stores req.body
    // content verbatim with `keywords: []` — so a freshly created note is
    // un-normalized and un-extracted until its first update. Noticed at 6.1,
    // out of scope, not fixed.
    withSpan(SPANS.NORMALIZE, () => {
      if (content !== undefined)   note.content = normalizeContent(content);
      if (contentText !== undefined) {
        note.contentText = contentText;
      } else if (Array.isArray(content)) {
        note.contentText = blockNoteToPlainText(content);
      } else if (content !== undefined) {
        note.contentText = blockNoteToPlainText(note.content);
      }
    });

    if (Array.isArray(tags))       note.tags      = tags;
    if (category !== undefined)    note.category  = category;

    // Extract keywords from updated text, using the user's other notes as the corpus.
    //
    // The corpus load is INSIDE the span deliberately. It is a Mongo round trip
    // rather than computation, but extractKeywords cannot run without the
    // document-frequency table it returns, so timing them apart would report a
    // fast `extract` beside an unattributed gap — PRIMER §8.2's second reading,
    // manufactured on purpose. One stage, one span, I/O included.
    await withSpan(SPANS.EXTRACT, async () => {
      const corpus = await loadUserCorpus(req.user._id, { excludeId: note._id });
      note.keywords = extractKeywords(note.title, note.contentText, corpus);
    });

    await note.save();

    // Phase 6.3. ONE capture for BOTH jobs: they are two effects of one save
    // and they belong to the same originating request span.
    const origin = currentSpanContext();

    // Save version snapshot in background.
    //
    // ⚠️ THIS CALL CANNOT REJECT. saveVersion() catches internally, logs, and
    // returns null — so the `.catch` this replaces had never fired and the span
    // around it would be GREEN on every failure. version.service.js marks the
    // active span from inside that catch for exactly this reason; without that
    // line this wrapper is §22.6's shape, a check that runs and cannot fail.
    fireJob(
      JOBS.VERSION,
      origin,
      note._id,
      () => saveVersion(note._id, note.content, note.contentText),
      'Version save skipped'
    );

    // Run linking in background
    runLinkingAsync(note._id, req.user._id, origin);

    res.json(note);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ message: 'Error updating note' });
  }
});

// ── DELETE /api/notes/:id ─────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id });
    if (!note) return res.status(404).json({ message: 'Note not found' });
    await note.deleteOne();
    // Canonical edges incident to the note, either endpoint. Not optional: a
    // note delete that left these behind would leave the store full of edges
    // pointing at nothing, which getLinkedNotes has to skip over and which no
    // later save would ever clean up.
    await NoteLink.deleteMany({
      user: req.user._id,
      $or: [{ noteA: note._id }, { noteB: note._id }]
    });
    // And the deprecated array, so the rollback target stays internally
    // coherent while it still exists.
    await Note.updateMany(
      { user: req.user._id },
      { $pull: { linkedNotes: { noteId: note._id } } }
    );
    res.json({ message: 'Note deleted', id: req.params.id });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting note' });
  }
});

// ── DELETE /api/notes/:id/relations/:relatedId ────────────────────────────────
router.delete('/:id/relations/:relatedId', async (req, res) => {
  try {
    const { id, relatedId } = req.params;
    // One row, both directions — which is what an undirected unlink always
    // meant and what the two $pulls below were emulating. The next save of
    // either note recreates the edge if the retriever still ranks it; that was
    // true before 4.2 as well.
    const { noteA, noteB } = NoteLink.canonicalPair(id, relatedId);
    await NoteLink.deleteOne({ user: req.user._id, noteA, noteB });
    await Note.findOneAndUpdate(
      { _id: id,        user: req.user._id },
      { $pull: { linkedNotes: { noteId: relatedId } } }
    );
    await Note.findOneAndUpdate(
      { _id: relatedId, user: req.user._id },
      { $pull: { linkedNotes: { noteId: id } } }
    );
    res.json({ message: 'Link removed' });
  } catch (err) {
    res.status(500).json({ message: 'Error removing link' });
  }
});

// ── GET /api/notes/:id/links ──────────────────────────────────────────────────
router.get('/:id/links', async (req, res) => {
  try {
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id }).select('_id').lean();
    if (!note) return res.status(404).json({ message: 'Note not found' });
    // userId is required from 4.2: edges are scoped to a user on the row, so
    // the read cannot be derived from the note id alone. Ownership is already
    // checked above; this is the query filter, not a second check.
    const links = await getLinkedNotes(req.params.id, req.user._id);
    res.json({ links });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching linked notes' });
  }
});

// ── GET /api/notes/:id/versions ───────────────────────────────────────────────
router.get('/:id/versions', async (req, res) => {
  try {
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id }).select('_id').lean();
    if (!note) return res.status(404).json({ message: 'Note not found' });
    const versions = await getVersions(req.params.id);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching versions' });
  }
});

// ── GET /api/notes/:id/versions/:versionNumber ────────────────────────────────
router.get('/:id/versions/:versionNumber', async (req, res) => {
  try {
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id }).select('_id').lean();
    if (!note) return res.status(404).json({ message: 'Note not found' });
    const vNum = Number(req.params.versionNumber);
    if (!Number.isFinite(vNum)) return res.status(400).json({ message: 'Invalid version number' });
    const version = await NoteVersion.findOne({ noteId: req.params.id, versionNumber: vNum }).lean();
    if (!version) return res.status(404).json({ message: 'Version not found' });
    res.json(version);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching version' });
  }
});

// ── GET /api/notes/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // The populate on linkedNotes is gone with the field (4.2). Related notes
    // come from GET /api/notes/:id/links, which is what LinkedNotesPanel.jsx
    // already calls; the frontend's only other reader guards with
    // `(n.linkedNotes || [])` and degrades to an empty list.
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id })
      .select('-linkedNotes');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    res.json(note);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching note' });
  }
});

module.exports = router;