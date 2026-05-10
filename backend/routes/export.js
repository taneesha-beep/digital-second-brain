const express = require('express');
const PDFDocument = require('pdfkit');
const jwt = require('jsonwebtoken');
const Note = require('../models/Note');

const router = express.Router();

// Custom auth for export: check token from query param
const authExport = (req, res, next) => {
  const token = req.query.token;
  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id };
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

router.use(authExport);

function sanitizeFilename(value = 'note') {
  return String(value)
    .trim()
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'note';
}

// GET /api/export/:noteId?format=pdf|markdown|text
router.get('/:noteId', async (req, res) => {
  try {
    const { noteId } = req.params;
    const format = String(req.query.format || 'markdown').toLowerCase();
    const note = await Note.findOne({ _id: noteId, user: req.user.id }).lean();
    if (!note) return res.status(404).json({ message: 'Note not found' });

    const title = note.title || 'Untitled';
    const tags = Array.isArray(note.tags) ? note.tags.join(', ') : '';
    const contentText = String(note.contentText || '');
    const safeName = sanitizeFilename(title);

    if (format === 'markdown') {
      const markdown = `# ${title}\n\nTags: ${tags}\n\n${contentText}`;
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
      return res.send(markdown);
    }

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);

      const doc = new PDFDocument({ margin: 48 });
      doc.pipe(res);

      doc.fontSize(20).font('Helvetica-Bold').text(title);
      doc.moveDown(0.6);
      doc.fontSize(12).fillColor('#6b7280').font('Helvetica').text(`Tags: ${tags}`);
      doc.moveDown(0.8);
      doc.fontSize(12).fillColor('#111111').font('Helvetica').text(contentText || 'No content');
      doc.end();
      return;
    }

    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(contentText);
    }

    return res.status(400).json({ message: 'Invalid format. Use pdf, markdown, or text.' });
  } catch (err) {
    return res.status(500).json({ message: 'Error exporting note' });
  }
});

module.exports = router;
