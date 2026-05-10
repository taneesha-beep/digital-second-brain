import React, { useMemo, useState } from 'react';
import api from '../../api/axiosInstance';

const FEATURES = [
  { key: 'summarize', label: 'Summarize' },
  { key: 'flashcards', label: 'Flashcards' },
  { key: 'concepts', label: 'Key Concepts' },
  { key: 'examQs', label: 'Exam Questions' },
  { key: 'eli5', label: 'ELI5' }
];

function parseResultArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function AIPanel({ noteId }) {
  const [activeFeature, setActiveFeature] = useState('summarize');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultText, setResultText] = useState('');
  const [resultItems, setResultItems] = useState([]);
  const [flipped, setFlipped] = useState({});

  const isArrayFeature = useMemo(
    () => ['flashcards', 'concepts', 'examQs'].includes(activeFeature),
    [activeFeature]
  );

  const runFeature = async (feature) => {
    if (!noteId || loading) return;
    setActiveFeature(feature);
    setLoading(true);
    setError('');
    setResultText('');
    setResultItems([]);
    setFlipped({});

    try {
      const { data } = await api.post(`/llm/${noteId}/${feature}`);
      const payload = data?.result;

      if (['summarize', 'eli5'].includes(feature)) {
        setResultText(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
      } else {
        const items = parseResultArray(payload);
        if (items.length === 0) {
          throw new Error('Model did not return a valid JSON array');
        }
        setResultItems(items);
      }
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Failed to process AI request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FEATURES.map((feature) => {
          const active = activeFeature === feature.key;
          return (
            <button
              key={feature.key}
              type="button"
              onClick={() => runFeature(feature.key)}
              disabled={loading || !noteId}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                active
                  ? 'border-[#7F77DD] bg-[#7F77DD] text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {feature.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-[140px] rounded-lg border border-slate-100 bg-slate-50 p-3">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
            Thinking...
          </div>
        )}

        {!loading && error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        {!loading && !error && !noteId && (
          <p className="text-sm text-slate-500">Select a note to use AI tools.</p>
        )}

        {!loading && !error && noteId && !isArrayFeature && resultText && (
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{resultText}</p>
        )}

        {!loading && !error && noteId && isArrayFeature && resultItems.length > 0 && (
          <div className="grid grid-cols-1 gap-3">
            {resultItems.map((item, idx) => {
              if (activeFeature === 'flashcards') {
                const isFlipped = Boolean(flipped[idx]);
                return (
                  <button
                    key={`flashcard-${idx}`}
                    type="button"
                    onClick={() => setFlipped((prev) => ({ ...prev, [idx]: !prev[idx] }))}
                    className="rounded-lg border border-slate-200 bg-white p-3 text-left"
                  >
                    <p className="mb-1 text-xs uppercase text-slate-400">
                      {isFlipped ? 'Answer' : 'Question'}
                    </p>
                    <p className="text-sm text-slate-700">
                      {isFlipped ? item.a || item.answer : item.q || item.question}
                    </p>
                  </button>
                );
              }

              if (activeFeature === 'concepts') {
                return (
                  <div key={`concept-${idx}`} className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-sm font-semibold text-slate-800">{item.term}</p>
                    <p className="mt-1 text-sm text-slate-600">{item.definition}</p>
                  </div>
                );
              }

              return (
                <div key={`exam-${idx}`} className="rounded-lg border border-slate-200 bg-white p-3">
                  <p className="text-sm font-semibold text-slate-800">{item.question}</p>
                  <p className="mt-1 text-sm text-slate-600">{item.answer}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
