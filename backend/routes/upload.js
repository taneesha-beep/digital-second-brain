const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const Note     = require('../models/Note');
const { protect } = require('../middleware/auth');
const { extractKeywords } = require('../utils/keywords');
const { loadUserCorpus } = require('../utils/corpus');
const { buildColorMap }   = require('../utils/colors');
const { computeAndSaveLinks } = require('../services/linker.service');

router.use(protect);

// ── Multer setup: keep files in memory (no disk write) ──────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['text/plain', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt and .pdf files are supported'));
    }
  }
});

// ── POST /api/upload ─────────────────────────────────────────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  try {
    let extractedText = '';

    if (req.file.mimetype === 'application/pdf') {
      // Extract text from PDF buffer
      const pdfData    = await pdfParse(req.file.buffer);
      extractedText    = pdfData.text.trim();
    } else {
      // Plain text — decode buffer as UTF-8
      extractedText = req.file.buffer.toString('utf-8').trim();
    }

    if (!extractedText) {
      return res.status(400).json({ message: 'Could not extract any text from this file' });
    }

    // Use filename (without extension) as note title
    const rawName = req.file.originalname.replace(/\.[^/.]+$/, '');
    const title   = rawName.length > 200 ? rawName.slice(0, 200) : rawName;
    // Limit content to first 10,000 characters to keep DB documents reasonable
    const content = extractedText.slice(0, 10000);

    const corpus = await loadUserCorpus(req.user._id);
    const keywords = extractKeywords(title, content, corpus);

    // ⚠️ contentText IS SET HERE AS OF 27 Aug 2026 AND IT NEVER WAS BEFORE.
    //
    // FOUND BY THE PRE-PHASE-8 SWEEP; no noticed list has ever carried it. This
    // route stored the extracted file text as `content` and left `contentText`
    // to the schema default of '' (models/Note.js:24). The linker reads
    // contentText and nothing else (noteCorpus.service.js:141), so EVERY
    // UPLOADED FILE WAS INDEXED WITH AN EMPTY BODY: its links came from the
    // title alone, and it contributed an empty document to every other note's
    // document-frequency corpus. computeAndSaveLinks is AWAITED below, so this
    // was never a race — it was simply wrong every time.
    //
    // The note's own `keywords` were always fine: extractKeywords() above reads
    // `content` directly. Only the retrieval half saw nothing.
    //
    // ⚠️ SCOPE, STATED RATHER THAN OVERSOLD: `POST /api/upload` IS UNREACHABLE
    // FROM THE UI. FROZEN.md records it, and a grep of frontend/src/ finds no
    // caller at all — Dashboard.jsx extracts PDF/DOCX in the browser and then
    // PUTs, which sets both fields correctly. So no user has ever hit this. It
    // is a real defect on a live registered route, not a live incident.
    //
    // FIXED RATHER THAN LEFT, UNDER FROZEN.md's OWN RULE: "bugs that make a
    // frozen area BREAK still get fixed. What is frozen is discretionary
    // improvement." A one-line correctness fix is the first, not the second.
    // `content` here is already plain text from the extractor, so this needs
    // no call into the frozen normalization path.
    const note = await Note.create({
      user:    req.user._id,
      title,
      content,
      contentText: content,
      keywords,
      category: req.body.category || ''
    });

    // Recompute colors for all user notes
    const allNotes = await Note.find({ user: req.user._id }).lean();
    const colorMap = buildColorMap(allNotes);

    for (const n of allNotes) {
      const color = colorMap.get(n._id.toString()) || '#6366f1';
      await Note.findByIdAndUpdate(n._id, { color });
    }

    // Compute canonical edges via the shared linker service (4.2 — they land in
    // models/NoteLink.js, not on the note).
    await computeAndSaveLinks(note._id, req.user._id);

    // The linkedNotes populate is gone with the field. Related notes come from
    // GET /api/notes/:id/links; returning a retired array here would be serving
    // a second source of truth that nothing updates.
    const created = await Note.findById(note._id).select('-linkedNotes');

    res.status(201).json(created);
  } catch (err) {
    console.error('Upload error:', err);
    if (err.message.includes('Only .txt')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Error processing uploaded file' });
  }
});

module.exports = router;
