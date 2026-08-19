import React, { useMemo, useState } from 'react';
import api from '../../api/axiosInstance';

/**
 * The first five take ONE note and are Phase 5.1's A/B control — they call
 * `/llm/:noteId/:feature` and nothing about them changed.
 *
 * `studyPack` is the sixth and it is a different shape: it calls a different
 * endpoint, sends the note PLUS its retrieved neighbours, and every item it
 * returns carries a citation. `cluster: true` is what the render branches on.
 */
const FEATURES = [
  { key: 'summarize', label: 'Summarize' },
  { key: 'flashcards', label: 'Flashcards' },
  { key: 'concepts', label: 'Key Concepts' },
  { key: 'examQs', label: 'Exam Questions' },
  { key: 'eli5', label: 'ELI5' },
  { key: 'studyPack', label: 'Study Pack', cluster: true }
];

/**
 * The chip under each generated item, naming the note it came from.
 *
 * AN UNCITED ITEM IS SHOWN AS UNCITED RATHER THAN HIDDEN. The server keeps
 * items whose citation it could not resolve and flags them (studyPack.service.js
 * — "invalid items are kept and flagged, never dropped"), and the panel honours
 * that: dropping them here would put the defect back out of sight one layer up,
 * which is the whole failure mode §28.5 records for `eli5`.
 */
function SourceChip({ item }) {
  if (item.citation === 'valid') {
    return (
      <span className="inline-block rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700">
        from: {item.sourceTitle}
      </span>
    );
  }
  return (
    <span className="inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
      {item.citation === 'missing' ? 'no source given' : `source ${item.source} not in this cluster`}
    </span>
  );
}

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
  const [pack, setPack] = useState(null);

  const isArrayFeature = useMemo(
    () => ['flashcards', 'concepts', 'examQs'].includes(activeFeature),
    [activeFeature]
  );
  const isCluster = activeFeature === 'studyPack';

  const runFeature = async (feature) => {
    if (!noteId || loading) return;
    setActiveFeature(feature);
    setLoading(true);
    setError('');
    setResultText('');
    setResultItems([]);
    setFlipped({});
    setPack(null);

    try {
      // The cluster feature is a DIFFERENT ENDPOINT, not a sixth value of
      // :feature. routes/llm.js is untouched by Phase 5.1 because the five
      // features it serves are the A/B control the generation baseline measures.
      if (feature === 'studyPack') {
        const { data } = await api.post(`/study-pack/${noteId}`);
        setPack(data);
        return;
      }

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

        {!loading && !error && noteId && isCluster && pack && (
          <div className="space-y-3">
            {/* WHAT THE MODEL WAS GIVEN, shown rather than implied. This is the
                only place in the app where a user can see which notes reached a
                prompt — and it is the difference between a study pack and the
                five single-note features sitting beside it. */}
            <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
              <p className="font-semibold text-slate-800">
                Built from {pack.context?.notes?.length ?? 0} notes
                {pack.retrieval?.version ? ` · ${pack.retrieval.version}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {(pack.context?.notes || []).map((note) => (
                  <span key={note.noteId} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                    [{note.label}] {note.title}
                  </span>
                ))}
              </div>
              {pack.context?.dropped?.length > 0 && (
                <p className="mt-2 text-[11px] text-slate-500">
                  {pack.context.dropped.length} lower-ranked note
                  {pack.context.dropped.length === 1 ? '' : 's'} left out to stay inside the context budget.
                </p>
              )}
              {pack.generation?.finishReason === 'length' && (
                <p className="mt-2 text-[11px] text-amber-700">
                  The model hit its output limit, so this pack may be short.
                </p>
              )}
            </div>

            {(pack.flashcards || []).length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Flashcards</p>
                <div className="grid grid-cols-1 gap-2">
                  {pack.flashcards.map((item, idx) => {
                    const isFlipped = Boolean(flipped[`f${idx}`]);
                    return (
                      <div key={`pack-card-${idx}`} className="rounded-lg border border-slate-200 bg-white p-3">
                        <button
                          type="button"
                          onClick={() => setFlipped((prev) => ({ ...prev, [`f${idx}`]: !prev[`f${idx}`] }))}
                          className="w-full text-left"
                        >
                          <p className="mb-1 text-xs uppercase text-slate-400">
                            {isFlipped ? 'Answer' : 'Question'}
                          </p>
                          <p className="text-sm text-slate-700">{isFlipped ? item.a : item.q}</p>
                        </button>
                        <div className="mt-2">
                          <SourceChip item={item} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(pack.concepts || []).length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Key concepts</p>
                <div className="grid grid-cols-1 gap-2">
                  {pack.concepts.map((item, idx) => (
                    <div key={`pack-concept-${idx}`} className="rounded-lg border border-slate-200 bg-white p-3">
                      <p className="text-sm font-semibold text-slate-800">{item.term}</p>
                      <p className="mt-1 text-sm text-slate-600">{item.definition}</p>
                      <div className="mt-2">
                        <SourceChip item={item} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(pack.flashcards || []).length === 0 && (pack.concepts || []).length === 0 && (
              <p className="text-sm text-red-600">
                The model returned no usable items
                {pack.generation?.parseError ? ' (its output could not be parsed as JSON)' : ''}.
              </p>
            )}
          </div>
        )}

        {!loading && !error && noteId && !isCluster && !isArrayFeature && resultText && (
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
