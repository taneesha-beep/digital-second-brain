import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../api/axiosInstance';

const MODES = [
  { key: 'keyword',  label: 'Keywords', icon: '🔤' },
  { key: 'semantic', label: 'Concepts', icon: '🧠' },
  { key: 'tags',     label: 'Tags',     icon: '🏷️' },
];

export default function SearchBar({ onResults, placeholder = 'Search notes…' }) {
  const [query,   setQuery]   = useState('');
  const [mode,    setMode]    = useState('keyword');
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  const doSearch = useCallback(async (q, m) => {
    const trimmed = q.trim();
    if (!trimmed) { onResults?.(null); return; }
    setLoading(true);
    try {
      const { data } = await api.get('/search', {
        params: {
          q:    trimmed,
          mode: m,
          tags: m === 'tags' ? trimmed.replace(/^#+/, '') : ''
        }
      });
      onResults?.(Array.isArray(data) ? data : []);
    } catch {
      onResults?.([]);
    } finally {
      setLoading(false);
    }
  }, [onResults]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) { onResults?.(null); return; }
    debounceRef.current = setTimeout(() => doSearch(query, mode), 380);
    return () => clearTimeout(debounceRef.current);
  }, [query, mode, doSearch, onResults]);

  const clear = () => { setQuery(''); onResults?.(null); };

  return (
    <div className="w-full space-y-2">
      {/* Input */}
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
          {loading ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
          ) : '🔍'}
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            mode === 'tags'     ? 'Search by tag…' :
            mode === 'semantic' ? 'Search by meaning…' :
            placeholder
          }
          className="w-full rounded-lg border border-slate-600 bg-slate-800 py-1.5 pl-8 pr-7 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
        />
        {query && (
          <button type="button" onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 text-xs px-0.5">
            ✕
          </button>
        )}
      </div>

      {/* Mode pills */}
      <div className="flex gap-1">
        {MODES.map((m) => (
          <button key={m.key} type="button"
            onClick={() => setMode(m.key)}
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition
              ${mode === m.key
                ? 'bg-indigo-500 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}>
            <span>{m.icon}</span>{m.label}
          </button>
        ))}
      </div>

      {/* Mode hint */}
      {query.trim() && (
        <p className="text-[10px] text-slate-500 leading-tight">
          {mode === 'keyword'  && 'Searching by exact words and phrases'}
          {mode === 'semantic' && 'Searching by meaning and related concepts'}
          {mode === 'tags'     && 'Searching notes tagged with this label'}
        </p>
      )}
    </div>
  );
}