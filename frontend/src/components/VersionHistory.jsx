import React, { useEffect, useState } from 'react';
import api from '../api/axiosInstance';

export default function VersionHistory({ noteId, onRestore }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    if (!noteId) return;
    setLoading(true);
    api.get(`/notes/${noteId}/versions`)
      .then(({ data }) => setVersions(Array.isArray(data) ? data : []))
      .catch((err) => setError(err?.response?.data?.message || 'Failed to load versions'))
      .finally(() => setLoading(false));
  }, [noteId]);

  const handleRestore = async (versionNumber) => {
    try {
      const { data } = await api.get(`/notes/${noteId}/versions/${versionNumber}`);
      onRestore?.(data.content);
    } catch (err) {
      alert('Failed to restore version: ' + err.message);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-800">🕐 Version History</h3>

      {loading && <p className="text-sm text-slate-500">Loading versions…</p>}
      {!loading && error && <p className="text-sm text-red-500">{error}</p>}
      {!loading && !error && versions.length === 0 && (
        <p className="text-sm text-slate-500">No versions saved yet. Save the note to create a snapshot.</p>
      )}

      <div className="max-h-[300px] space-y-2 overflow-y-auto">
        {versions.map((v, idx) => (
          <div key={v.versionNumber}
            className="flex items-start justify-between rounded-lg border border-slate-100 bg-slate-50 p-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-700">Version {v.versionNumber}</span>
                {idx === 0 && (
                  <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                    Current
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                {new Date(v.savedAt).toLocaleString()}
              </p>
              {v.contentText && (
                <p className="mt-1 truncate text-xs text-slate-500">{v.contentText.slice(0, 80)}…</p>
              )}
            </div>
            {idx !== 0 && (
              <button type="button" onClick={() => handleRestore(v.versionNumber)}
                className="ml-3 flex-shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100">
                Restore
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}