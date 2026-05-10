import React from 'react';

export default function TagPill({
  tag,
  selected = false,
  disabled = false,
  size = 'md',
  onClick,
  onRemove
}) {
  const label = String(tag || '').trim();
  if (!label) return null;

  const sizeClass =
    size === 'sm'
      ? 'px-2 py-0.5 text-xs'
      : size === 'lg'
        ? 'px-3 py-1.5 text-sm'
        : 'px-2.5 py-1 text-xs';

  const styleClass = selected
    ? 'border-slate-700 bg-slate-800 text-white'
    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100';

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onClick?.(label)}
        className={`rounded-full border font-medium transition ${sizeClass} ${styleClass} ${
          disabled ? 'cursor-not-allowed opacity-60' : ''
        }`}
      >
        #{label}
      </button>

      {onRemove && !disabled && (
        <button
          type="button"
          onClick={() => onRemove(label)}
          className="rounded-full border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label={`Remove tag ${label}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
