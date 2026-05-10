import React, { useState } from 'react';
import { uploadNote } from '../api/notes';

export default function UploadNote({ onNoteCreated }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleUpload = async () => {
    if (!file || loading) return;
    setError('');
    setLoading(true);
    try {
      const { data } = await uploadNote(file);
      onNoteCreated?.(data);
      setFile(null);
    } catch (err) {
      setError(err?.response?.data?.message || 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 text-sm font-medium text-slate-800">Upload Note File</p>
      <input
        type="file"
        accept=".txt,.pdf"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        className="mb-2 block w-full text-xs text-slate-600"
      />
      <button
        type="button"
        disabled={!file || loading}
        onClick={handleUpload}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
      >
        {loading ? 'Uploading...' : 'Upload'}
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
