const express   = require('express');
const router    = express.Router();
const Note      = require('../models/Note');
const NoteVersion = require('../models/NoteVersion');
const { protect } = require('../middleware/auth');
const { extractKeywords } = require('../utils/keywords');
const { buildGlobalGraph } = require('../services/graphBuilder.service');
const { computeAndSaveLinks, getLinkedNotes } = require('../services/linker.service');
const { saveVersion, getVersions } = require('../services/version.service');

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

function normalizeContent(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') return { text: value };
  return {};
}

// Run linking in background — never blocks the response
function runLinkingAsync(noteId, userId) {
  computeAndSaveLinks(noteId, userId).catch((err) =>
    console.error('Background linking error:', err.message)
  );
}

// ── GET /api/notes ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const notes = await Note.find({ user: req.user._id })
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
    // Run linking in background — don't await so response is instant
    runLinkingAsync(note._id, req.user._id);
    res.status(201).json(note);
  } catch (err) {
    console.error('Full create error:', err);
    res.status(500).json({ message: err.message || 'Error creating note' });
  }
});

// ── PUT /api/notes/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { title, content, contentText, category, tags, embedding } = req.body;
  try {
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id });
    if (!note) return res.status(404).json({ message: 'Note not found' });

    if (title !== undefined)     note.title   = title;
    if (content !== undefined)   note.content = normalizeContent(content);
    if (contentText !== undefined) {
      note.contentText = contentText;
    } else if (Array.isArray(content)) {
      note.contentText = blockNoteToPlainText(content);
    } else if (content !== undefined) {
      note.contentText = blockNoteToPlainText(note.content);
    }
    if (Array.isArray(tags))       note.tags      = tags;
    if (Array.isArray(embedding))  note.embedding = embedding;
    if (category !== undefined)    note.category  = category;

    // Extract keywords from updated text
    note.keywords = extractKeywords(note.title, note.contentText);

    await note.save();

    // Save version snapshot in background
    saveVersion(note._id, note.content, note.contentText).catch((e) =>
      console.error('Version save skipped:', e.message)
    );

    // Run linking in background
    runLinkingAsync(note._id, req.user._id);

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
    // Remove this note from other notes' linkedNotes
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
    const links = await getLinkedNotes(req.params.id);
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
    const note = await Note.findOne({ _id: req.params.id, user: req.user._id })
      .populate('linkedNotes.noteId', 'title _id color keywords');
    if (!note) return res.status(404).json({ message: 'Note not found' });
    res.json(note);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching note' });
  }
});

module.exports = router;