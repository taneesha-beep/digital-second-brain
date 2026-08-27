const express = require('express');
const PDFDocument = require('pdfkit');
const Note = require('../models/Note');
const { protect } = require('../middleware/auth');
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
router.param('noteId', objectIdParam({ status: 404, message: 'Note not found' }));


// This route used to accept the session JWT as ?token=, because the download
// was triggered by window.open() and a navigation cannot carry headers. URLs
// leak: they land in server access logs, browser history, proxy logs, and the
// Referer header sent to third parties, and the token leaked was the full
// session token rather than anything export-scoped.
//
// The client now fetches the export with XHR and saves the response as a Blob,
// so the token travels in the Authorization header like every other request
// and this route can use the standard middleware.
router.use(protect);

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
