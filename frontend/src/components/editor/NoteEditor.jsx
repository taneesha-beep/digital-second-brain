import React, { useEffect, useRef } from 'react';

const TOOLBAR = [
  [{ header: [1, 2, 3, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['blockquote', 'code-block'],
  ['clean']
];

let quillLoaded = false;
let quillLoadPromise = null;

function loadQuill() {
  if (quillLoaded) return Promise.resolve();
  if (quillLoadPromise) return quillLoadPromise;

  quillLoadPromise = new Promise((resolve) => {
    // Load Quill CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.snow.min.css';
    document.head.appendChild(link);

    // Load Quill JS
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/quill/1.3.7/quill.min.js';
    script.onload = () => { quillLoaded = true; resolve(); };
    document.head.appendChild(script);
  });

  return quillLoadPromise;
}

/**
 * NoteEditor
 *
 * Props:
 *   initialValue — Quill Delta { ops: [...] }, plain string, or { text: string }.
 *                  Whatever is stored in Note.content — passed straight through.
 *   onChange({ delta, text }) — called on every keystroke.
 *                  delta → store as Note.content  (rich formatting preserved)
 *                  text  → store as Note.contentText (plain text for NLP/search)
 */
export default function NoteEditor({ initialValue = null, onChange }) {
  const containerRef = useRef(null);
  const quillRef     = useRef(null);
  const onChangeRef  = useRef(onChange);
  const initialRef   = useRef(initialValue); // snapshot at mount — not reactive
  onChangeRef.current = onChange;

  // ── Mount Quill once ──────────────────────────────────────────────────────
  useEffect(() => {
    loadQuill().then(() => {
      if (!containerRef.current || quillRef.current) return;

      const quill = new window.Quill(containerRef.current, {
        theme: 'snow',
        placeholder: 'Type your note… (use toolbar for formatting)',
        modules: { toolbar: TOOLBAR },
      });

      setQuillContent(quill, initialRef.current);

      quill.on('text-change', () => {
        onChangeRef.current?.({
          delta: quill.getContents(),   // full Delta — preserves all formatting
          text:  quill.getText().trim(), // plain text — for NLP / keyword extraction
        });
      });

      quillRef.current = quill;
    });
  }, []); // intentionally runs once

  // ── Swap content when the selected note changes ───────────────────────────
  useEffect(() => {
    const quill = quillRef.current;
    if (!quill) return;
    setQuillContent(quill, initialValue);
  }, [initialValue]);

  return (
    <div className="w-full rounded-xl overflow-hidden border border-slate-200">
      <div ref={containerRef} style={{ minHeight: '200px', fontSize: '14px' }} />
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Load the right content into a Quill instance.
 * Handles all the formats Note.content can arrive in:
 *   - Quill Delta  : { ops: [...] }
 *   - Plain object : { text: '...' }  (legacy notes saved before Delta support)
 *   - Plain string : '...'            (very old notes / imports)
 *   - null / undefined / empty       : clears the editor
 */
function setQuillContent(quill, value) {
  if (!quill) return;

  if (value && typeof value === 'object' && Array.isArray(value.ops)) {
    // ✅ Quill Delta — restore rich formatting
    quill.setContents(value, 'silent');
  } else if (typeof value === 'string' && value.trim()) {
    // Legacy plain string
    quill.setText(value, 'silent');
  } else if (value && typeof value === 'object' && typeof value.text === 'string') {
    // Legacy { text: '...' } shape
    quill.setText(value.text, 'silent');
  } else {
    // Empty / new note
    quill.setText('', 'silent');
  }

  // Move cursor to end
  quill.setSelection(quill.getLength(), 0);
}