import React, { useEffect, useState } from 'react';
import NoteEditor from './editor/NoteEditor';

function toInitialEditorText(note) {
  if (!note) return '';
  if (typeof note.contentText === 'string' && note.contentText.trim()) return note.contentText;
  if (typeof note.content === 'string') return note.content;
  if (note.content && typeof note.content === 'object' && typeof note.content.text === 'string') {
    return note.content.text;
  }
  return '';
}

export default function NoteForm({ onSubmit, editNote, onCancel, EditorComponent = NoteEditor }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [contentText, setContentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isEditing = Boolean(editNote?._id);

  useEffect(() => {
    if (!editNote) {
      setTitle('');
      setCategory('');
      setContentText('');
      return;
    }

    setTitle(editNote.title || '');
    setCategory(editNote.category || '');
    setContentText(toInitialEditorText(editNote));
  }, [editNote]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !contentText.trim()) return;

    const payload = {
      title: title.trim(),
      category: category.trim(),
      content: { text: contentText },
      contentText
    };

    try {
      setSubmitting(true);
      await onSubmit?.(payload);
      if (!isEditing) {
        setTitle('');
        setCategory('');
        setContentText('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Note title"
        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
        required
      />

      <input
        type="text"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="Category (optional)"
        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
      />

      <EditorComponent
        initialValue={contentText}
        onChange={setContentText}
      />

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-70"
        >
          {submitting ? 'Saving...' : (isEditing ? 'Update note' : 'Create note')}
        </button>

        {isEditing && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
