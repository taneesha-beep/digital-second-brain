const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const Note     = require('../models/Note');
const { protect } = require('../middleware/auth');
const { extractKeywords } = require('../utils/keywords');
const { buildColorMap }   = require('../utils/colors');

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

    const keywords = extractKeywords(title, content);

    const note = await Note.create({
      user:    req.user._id,
      title,
      content,
      keywords,
      category: req.body.category || ''
    });

    // Recompute relations + colors for all user notes
    const allNotes = await Note.find({ user: req.user._id }).lean();
    const colorMap = buildColorMap(allNotes);

    for (const n of allNotes) {
      const related = [];
      for (const other of allNotes) {
        if (other._id.toString() === n._id.toString()) continue;
        const set1 = new Set(n.keywords);
        if (n.keywords.some(k => other.keywords.includes(k))) {
          related.push(other._id);
        }
      }
      const color = colorMap.get(n._id.toString()) || '#6366f1';
      await Note.findByIdAndUpdate(n._id, { relatedNotes: related, color });
    }

    const populated = await Note.findById(note._id)
      .populate('relatedNotes', 'title _id color');

    res.status(201).json(populated);
  } catch (err) {
    console.error('Upload error:', err);
    if (err.message.includes('Only .txt')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Error processing uploaded file' });
  }
});

module.exports = router;
