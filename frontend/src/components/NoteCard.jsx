import React from 'react';

function previewText(note, max = 110) {
  const raw = typeof note?.contentText === 'string'
    ? note.contentText
    : typeof note?.content === 'string'
      ? note.content
      : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return 'No content';
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}...`;
}

export default function NoteCard({ note, isSelected, onSelect, onEdit, onDelete }) {
  return (
    <div className={`rounded-xl border bg-white p-3 ${isSelected ? 'border-slate-700' : 'border-slate-200'}`}>
      <button type="button" onClick={() => onSelect?.(note)} className="w-full text-left">
        <p className="text-sm font-semibold text-slate-800">{note.title || 'Untitled'}</p>
        <p className="mt-1 text-xs text-slate-500">{previewText(note)}</p>
      </button>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onEdit?.(note)}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => onDelete?.(note._id)}
          className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
