import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axiosInstance';

function badgeForStrength(strength) {
  if (strength > 0.6) return { label: 'Strong', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  if (strength >= 0.3) return { label: 'Moderate', cls: 'bg-amber-100 text-amber-700 border-amber-200' };
  return { label: 'Weak', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
}

export default function LinkedNotesPanel({ noteId, onNoteSelect }) {
  const navigate = useNavigate();
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!noteId) {
      setLinks([]);
      setError('');
      return;
    }

    let mounted = true;
    setLoading(true);
    setError('');

    api.get(`/notes/${noteId}/links`)
      .then(({ data }) => {
        if (!mounted) return;
        setLinks(Array.isArray(data?.links) ? data.links : []);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err?.response?.data?.message || 'Failed to load related notes');
        setLinks([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [noteId]);

  const sortedLinks = useMemo(
    () => [...links].sort((a, b) => (b.strength || 0) - (a.strength || 0)),
    [links]
  );

  const openNote = (linked) => {
    const note = linked?.noteId;
    const id = note?._id || note;
    if (!id) return;
    if (onNoteSelect) onNoteSelect(id);
    else navigate(`/note/${id}`);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-800">🔗 Related Notes</h3>

      <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
        {loading && <p className="text-sm text-slate-500">Loading related notes...</p>}
        {!loading && error && <p className="text-sm text-red-600">{error}</p>}

        {!loading && !error && sortedLinks.length === 0 && (
          <p className="text-sm text-slate-500">No related notes yet. Add more notes on similar topics.</p>
        )}

        {!loading && !error && sortedLinks.map((link, idx) => {
          const note = link.noteId || {};
          const strength = Number(link.strength || 0);
          const badge = badgeForStrength(strength);
          const keywords = Array.isArray(link.sharedKeywords) ? link.sharedKeywords : [];

          return (
            <div key={`${note._id || idx}`} className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => openNote(link)}
                  className="text-left text-sm font-medium text-slate-800 hover:underline"
                >
                  {note.title || 'Untitled'}
                </button>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>
                  {badge.label}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-1">
                {keywords.map((kw) => (
                  <span key={kw} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
