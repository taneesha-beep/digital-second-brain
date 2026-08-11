'use strict';

/**
 * retained-for.js — Phase 4.1.
 *
 * How much memory does the thing this function returns actually hold on to?
 *
 *   const { retainedFor, formatRetained } = require('./lib/retained-for');
 *   const m = retainedFor(() => retrieval.index('v4-bm25', docs));
 *   console.log(formatRetained(m));
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT IS ONLY BEING WRITTEN NOW.
 *
 * §16.12 measured v4's retained heap, §17.11 measured v5's, and both were
 * open-coded gc/measure/gc blocks inside their own analyse script. 3.3's
 * noticed-list asked for the pattern to be extracted; 3.6 and 3.7 both deferred
 * it, and BOTH GAVE THE SAME HONEST REASON — neither session took a memory
 * measurement, so extracting a helper would have been writing a library with no
 * caller and no way to know it was right. 4.1 takes one (§21.4), so the
 * deferral expires here rather than being renewed a third time.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MISTAKE THIS FUNCTION EXISTS TO STOP ANYONE MAKING AGAIN.
 *
 * §17.11 got it wrong first and recorded it: `heapUsed` alone reported 2.0 MiB
 * for a structure that is 40.24 MiB of Float32Array. A large typed array's
 * BACKING STORE IS ALLOCATED OUTSIDE THE V8 HEAP, so heapUsed does not see it.
 * Quoting that number as "v5's memory" would have understated it by 20x.
 *
 * So this returns BOTH TERMS AND THEIR SUM, always, and formatRetained() prints
 * all three. There is no single-number accessor, deliberately: the whole defect
 * was a single number that looked like the answer.
 *
 * AND THE TWO TERMS ARE NOT COMPARABLE ACROSS RETRIEVERS. v4's index is Maps
 * and vocabulary strings, which are genuinely on the heap; v5's is one
 * contiguous matrix, which is genuinely not. `heap` for one and `buffers` for
 * the other measure different things wearing the same name, which is exactly
 * what §16.12 separated three of. Compare `total`, or compare nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT CANNOT DO, so a number out of it is not read as more than it is.
 *
 *   - It needs `node --expose-gc`. Without it there is no way to force a
 *     collection, and a delta measured against uncollected garbage is noise
 *     with a decimal point. It THROWS rather than returning an unreliable
 *     figure, because the failure mode of a silent fallback is a plausible
 *     wrong number in a writeup.
 *   - `global.gc()` is a request. V8 may retain what it likes, so a delta is a
 *     lower bound on what was freed and an upper bound on nothing. Two calls
 *     bracket the allocation rather than one, for the same reason §2.2's
 *     convention brackets a wall time with two runs.
 *   - It measures what is RETAINED BY THE RETURNED VALUE, not peak allocation
 *     during construction. A builder that allocates 300 MiB of intermediates
 *     and returns a 3 MiB structure reports 3 MiB. `peakRssMiB` is reported
 *     beside it for exactly that reason and is a property of the whole process,
 *     not of this call.
 */

const MIB = 1024 ** 2;

/**
 * @param   {Function} build  called once; its return value is held live across
 *                            the measurement, so it cannot be collected early
 * @param   {Object}   [opts]
 * @param   {string}   [opts.label]
 * @returns {{value: *, label: string, heapBytes: number, bufferBytes: number,
 *            totalBytes: number, externalBytes: number, peakRssBytes: number}}
 */
function retainedFor(build, { label = 'value' } = {}) {
  if (typeof build !== 'function') {
    throw new TypeError('retainedFor: build must be a function returning the structure to measure');
  }
  if (typeof global.gc !== 'function') {
    throw new Error(
      'retainedFor: run with `node --expose-gc`. Without a forced collection the ' +
        'delta is measured against whatever garbage happened to be live, and a ' +
        'plausible wrong number in a writeup is worse than no number.'
    );
  }

  global.gc();
  const before = process.memoryUsage();

  // Held in a binding that outlives the second gc(). If this were inlined into
  // the return statement V8 would be within its rights to collect it first, and
  // the measurement would read zero.
  const value = build();

  global.gc();
  const after = process.memoryUsage();

  const heapBytes = after.heapUsed - before.heapUsed;
  const bufferBytes = after.arrayBuffers - before.arrayBuffers;

  return {
    value,
    label,
    heapBytes,
    bufferBytes,
    totalBytes: heapBytes + bufferBytes,
    // `external` includes arrayBuffers and is reported for completeness rather
    // than added in — adding both would double-count the buffers.
    externalBytes: after.external - before.external,
    peakRssBytes: after.rss
  };
}

/** The three numbers, never one. Indented block, for an analyse script. */
function formatRetained(m, { indent = '  ' } = {}) {
  const mib = (bytes) => `${(bytes / MIB).toFixed(2)} MiB`;
  return [
    `${indent}retained for one ${m.label} (--expose-gc)   ${mib(m.totalBytes)}`,
    `${indent}  of which V8 heap      ${mib(m.heapBytes)}`,
    `${indent}  of which arrayBuffers ${mib(m.bufferBytes)}`,
    `${indent}peak RSS for this process              ${(m.peakRssBytes / MIB).toFixed(0)} MiB`
  ].join('\n');
}

module.exports = { retainedFor, formatRetained, MIB };
