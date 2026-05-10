import React, { useRef, useState } from 'react';

export default function TagInput({ tags = [], onChange }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  const addTag = (raw) => {
    const tag = raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
    if (!tag || tags.includes(tag)) { setInput(''); return; }
    onChange?.([...tags, tag]);
    setInput('');
  };

  const removeTag = (tag) => onChange?.(tags.filter((t) => t !== tag));

  const handleKeyDown = (e) => {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault();
      addTag(input);
    }
    if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div
      className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span key={tag}
          className="flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
          #{tag}
          <button type="button" onClick={() => removeTag(tag)}
            className="ml-0.5 text-indigo-400 hover:text-indigo-700 leading-none">
            ✕
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => input.trim() && addTag(input)}
        placeholder={tags.length === 0 ? 'Add tags… (#ML, #DBMS, #Exam)' : ''}
        className="min-w-[140px] flex-1 bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
      />
    </div>
  );
}