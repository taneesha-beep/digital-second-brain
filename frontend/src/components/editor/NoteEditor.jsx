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

export default function NoteEditor({ initialValue: _iv = '', onChange }) {
  const initialValue = typeof _iv === 'string' ? _iv : (typeof _iv?.text === 'string' ? _iv.text : '');
  const containerRef = useRef(null);
  const quillRef    = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    loadQuill().then(() => {
      if (!containerRef.current || quillRef.current) return;

      const quill = new window.Quill(containerRef.current, {
        theme: 'snow',
        placeholder: 'Type your note… (use toolbar for formatting)',
        modules: { toolbar: TOOLBAR }
      });

      // Set initial content
      if (initialValue) {
        quill.setText(initialValue);
        quill.setSelection(quill.getLength(), 0);
      }

      quill.on('text-change', () => {
        const text = quill.getText().trim();
        onChangeRef.current?.(text);
      });

      quillRef.current = quill;
    });
  }, []); // only run once

  // Update content when note changes
  useEffect(() => {
    const quill = quillRef.current;
    if (!quill) return;
    const current = quill.getText().trim();
    if (current === initialValue.trim()) return;
    quill.setText(initialValue || '');
  }, [initialValue]);

  return (
    <div className="w-full rounded-xl overflow-hidden border border-slate-200">
      <div ref={containerRef} style={{ minHeight: '200px', fontSize: '14px' }} />
    </div>
  );
}