import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api',
  headers: { 'Content-Type': 'application/json' }
});

/*
 * SLOW-REQUEST NOTIFIER — the backend runs on a FREE Render instance, which
 * spins down after ~15 minutes of inactivity. The next request then pays the
 * spin-up: MEASURED at 27,366 ms and 27,599 ms on 18 Nov 2026, and Render's own
 * dashboard says "50 seconds or more". Nothing is broken when that happens, but
 * a button reading "Signing in…" for half a minute is indistinguishable from a
 * dead app, which is exactly how it was reported.
 *
 * It lives HERE rather than in LoginPage because this file is the only HTTP
 * entry point in the app, so one implementation covers login, the notes load
 * and every call added later. Per-page spinners would each need their own.
 *
 * THRESHOLD: the warm p90 measured 240 ms against these 2,500 ms, an order of
 * magnitude of headroom, so a normal request cannot trip it.
 *
 * It counts IN-FLIGHT requests rather than timing one, because the dashboard
 * fires several at once and any of them can be the one that wakes the server.
 * The clock starts when the first request goes out and stops when the last
 * settles, so overlapping calls cannot restart or prematurely clear it.
 */
export const SLOW_REQUEST_MS = 2500;

let inflight = 0;
let timer = null;
let startedAt = null;
let slowSince = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(slowSince);
}

/** Subscribe to slow-request state. Receives the start timestamp, or null when
 *  nothing is slow. Returns an unsubscribe function for effect cleanup. */
export function onSlowRequest(fn) {
  listeners.add(fn);
  fn(slowSince);
  return () => listeners.delete(fn);
}

function requestStarted() {
  inflight += 1;
  if (timer === null && slowSince === null) {
    // Stamp the moment the WAIT began, not the moment we notice it. The counter
    // is reporting how long the user has been waiting, so starting it at the
    // threshold would permanently understate it by SLOW_REQUEST_MS — it read
    // "1s" after four seconds of waiting, which is the opposite of the honesty
    // the counter exists for.
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      // Only announce if something is STILL in flight. Without this a request
      // that settles in the same tick as the timer leaves the notice stuck on.
      if (inflight > 0) { slowSince = startedAt; emit(); }
    }, SLOW_REQUEST_MS);
  }
}

function requestSettled() {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    startedAt = null;
    if (slowSince !== null) { slowSince = null; emit(); }
  }
}

// Attach JWT token to every request automatically
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  requestStarted();
  return config;
}, (error) => {
  // A request that never leaves still incremented the counter above only if it
  // got that far; this handler covers config-stage failures, which do not.
  return Promise.reject(error);
});

// Handle 401 globally — clear auth and redirect to login
api.interceptors.response.use(
  (response) => {
    requestSettled();
    return response;
  },
  (error) => {
    requestSettled();
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
