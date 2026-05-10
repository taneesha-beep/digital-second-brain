import React from 'react';
import { deleteLink } from '../api/notes';

export default function RelatedNotes({ selectedNote, allNotes = [], onSelect, onLinkRemoved }) {
  if (!selectedNote) {
    return <p className="text-sm text-slate-500">Select a note to view related notes.</p>;
  }

  const linkedIds = (selectedNote.linkedNotes || selectedNote.relatedNotes || [])
    .map((r) => (typeof r === 'string' ? r : r?._id))
    .filter(Boolean);

  const linked = allNotes.filter((n) => linkedIds.includes(n._id));

  const unlink = async (relatedId) => {
    await deleteLink(selectedNote._id, relatedId);
    onLinkRemoved?.(selectedNote._id, relatedId);
  };

  if (linked.length === 0) {
    return <p className="text-sm text-slate-500">No related notes yet.</p>;
  }

  return (
    <div className="space-y-2">
      {linked.map((note) => (
        <div key={note._id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3">
          <button type="button" onClick={() => onSelect?.(note)} className="text-sm text-slate-700 hover:underline">
            {note.title || 'Untitled'}
          </button>
          <button
            type="button"
            onClick={() => unlink(note._id)}
            className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50"
          >
            Remove link
          </button>
        </div>
      ))}
    </div>
  );
}
