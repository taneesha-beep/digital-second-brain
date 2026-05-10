import React from 'react';
import ExportMenu from './ExportMenu';

export default function ExportButtons({ notes = [] }) {
  const allContent = notes
    .map((n) => `# ${n.title || 'Untitled'}\n\n${n.contentText || ''}`)
    .join('\n\n---\n\n');

  const downloadBlob = (filename, mimeType, text) => {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const exportMarkdown = () => {
    downloadBlob('notes-export.md', 'text/markdown;charset=utf-8', allContent || '# Notes\n');
  };

  const exportPdf = () => {
    // Lightweight fallback: export printable text as .txt with pdf-like intent.
    downloadBlob('notes-export.txt', 'text/plain;charset=utf-8', allContent || 'Notes');
  };

  const exportFlashcards = () => {
    const cards = notes.map((n) => ({
      question: n.title || 'Untitled',
      answer: n.contentText || ''
    }));
    downloadBlob('flashcards.json', 'application/json;charset=utf-8', JSON.stringify(cards, null, 2));
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 text-sm font-medium text-slate-800">Export</p>
      <ExportMenu
        disabled={notes.length === 0}
        onExportPdf={exportPdf}
        onExportMarkdown={exportMarkdown}
        onExportFlashcards={exportFlashcards}
      />
    </div>
  );
}
