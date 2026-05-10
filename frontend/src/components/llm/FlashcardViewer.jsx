import React, { useEffect, useMemo, useState } from 'react';

function normalizeCards(flashcards = []) {
  return flashcards
    .filter((c) => c && typeof c.question === 'string' && typeof c.answer === 'string')
    .map((c) => ({ question: c.question.trim(), answer: c.answer.trim() }));
}

export default function FlashcardViewer({ flashcards = [] }) {
  const cards = useMemo(() => normalizeCards(flashcards), [flashcards]);
  const [index, setIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  useEffect(() => {
    setIndex(0);
    setIsFlipped(false);
  }, [cards.length]);

  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No flashcards to display yet.
      </div>
    );
  }

  const current = cards[index];

  const goPrev = () => {
    setIndex((prev) => (prev === 0 ? cards.length - 1 : prev - 1));
    setIsFlipped(false);
  };

  const goNext = () => {
    setIndex((prev) => (prev === cards.length - 1 ? 0 : prev + 1));
    setIsFlipped(false);
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsFlipped((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsFlipped((v) => !v);
          }
        }}
        className="relative h-56 cursor-pointer rounded-xl border border-slate-200 [perspective:1200px]"
        aria-label="Flashcard. Click to flip."
      >
        <div
          className={`relative h-full w-full rounded-xl transition-transform duration-500 [transform-style:preserve-3d] ${
            isFlipped ? '[transform:rotateY(180deg)]' : ''
          }`}
        >
          <div className="absolute inset-0 rounded-xl bg-white p-4 [backface-visibility:hidden]">
            <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Question</p>
            <p className="text-sm text-slate-700">{current.question}</p>
            <p className="absolute bottom-3 right-4 text-xs text-slate-400">Click to flip</p>
          </div>

          <div className="absolute inset-0 rounded-xl bg-slate-800 p-4 text-white [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <p className="mb-2 text-xs uppercase tracking-wide text-slate-300">Answer</p>
            <p className="text-sm">{current.answer}</p>
            <p className="absolute bottom-3 right-4 text-xs text-slate-300">Click to flip back</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          Previous
        </button>

        <p className="text-xs text-slate-500">
          Card {index + 1} of {cards.length}
        </p>

        <button
          type="button"
          onClick={goNext}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
        >
          Next
        </button>
      </div>
    </div>
  );
}
