import React from 'react';

export default function SearchResults({ results, onSelect, onClear }) {
  if (!results) return null;

  return (
    <div className="mt-1 w-full">
      {results.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-slate-400">No notes found.</p>
      ) : (
        <>
          <div className="mb-1 flex items-center justify-between px-1">
            <p className="text-[10px] text-slate-400">{results.length} result{results.length !== 1 ? 's' : ''}</p>
            <button type="button" onClick={onClear}
              className="text-[10px] text-slate-500 hover:text-slate-300">
              Clear
            </button>
          </div>
          <div className="space-y-1">
            {results.map((note) => (
              <button key={note._id} type="button"
                onClick={() => onSelect(note)}
                className="block w-full rounded-md bg-slate-800 px-3 py-2 text-left transition hover:bg-slate-700 border border-slate-700">
                <p className="truncate text-sm font-medium text-slate-100">
                  {note.title || 'Untitled'}
                </p>
                {note.snippet && (
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-400 leading-snug">
                    {note.snippet}
                  </p>
                )}
                {note.tags?.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {note.tags.slice(0, 4).map((tag) => (
                      <span key={tag}
                        className="rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}