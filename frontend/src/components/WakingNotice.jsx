import React, { useEffect, useState } from 'react';
import { onSlowRequest } from '../api/axiosInstance';

/*
 * Shown when a request has been outstanding longer than SLOW_REQUEST_MS — in
 * practice, when the free Render instance is spinning up after idling. See the
 * header in api/axiosInstance.js for the measurements behind it.
 *
 * IT SHOWS A COUNTER RATHER THAN A SPINNER, deliberately. A spinner that runs
 * for half a minute is indistinguishable from a hung app; a number going up is
 * evidence that something is still happening. The wait is not being made
 * shorter here, only legible, and the copy says so rather than implying the app
 * is nearly done.
 *
 * The duration quoted is Render's own ("50 seconds or more") rather than the
 * 27 s measured on 18 Nov 2026, so the notice under-promises instead of setting
 * an expectation a slower spin-up would break.
 *
 * Mounted ONCE, in App.jsx, outside <Routes> so it survives navigation. It
 * renders null whenever nothing is slow, which is almost always.
 */
export default function WakingNotice() {
  const [since, setSince] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => onSlowRequest(setSince), []);

  useEffect(() => {
    if (since === null) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);

  if (since === null) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
        zIndex: 9999, maxWidth: 'calc(100vw - 32px)',
        display: 'flex', alignItems: 'center', gap: 10,
        background: '#1a1a2e', border: '1px solid rgba(148,163,184,0.25)',
        borderRadius: 10, padding: '10px 16px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
        color: '#e2e8f0', fontSize: 13, lineHeight: 1.4
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: '#818cf8', animation: 'dsb-pulse 1.2s ease-in-out infinite'
        }}
      />
      <span>
        <strong style={{ fontWeight: 600, color: '#fff' }}>
          Waking the server… {seconds}s
        </strong>
        <span style={{ color: '#94a3b8' }}>
          {' '}— free hosting sleeps after inactivity. This can take up to a minute.
        </span>
      </span>
      {/* Scoped here rather than in index.css: the keyframe exists only for this
          component, and nothing else should be able to depend on it. */}
      <style>{`@keyframes dsb-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }`}</style>
    </div>
  );
}
