'use strict';

/**
 * bootstrap.js — Phase 2.5
 *
 * The paired bootstrap over per-query score differences. Pure functions: an
 * array of numbers in, an interval and a p-value out. No file loading, no run
 * files, no qrels — same boundary as eval/metrics.js, and for the same reason.
 *
 * WHY BOOTSTRAP AND NOT A PAIRED t-TEST. The t-test assumes the *sample mean*
 * of the differences is approximately normal. With n = 2,304 queries that is
 * normally uncontroversial by CLT. It is not fine here, and the dev data says
 * why rather than theory:
 *
 *   - At nDCG@8 the two v1 runs are per-query IDENTICAL. All 2,304 differences
 *     are exactly 0, the variance is exactly 0, and the t-statistic is 0/0 —
 *     undefined, not merely imprecise.
 *   - At nDCG@10 only 61 of 2,304 differ. That is a point mass at zero with a
 *     2.6% slab, so the effective sample size driving the CLT is 61, not 2,304,
 *     and the distribution is severely skewed. This is the regime where the
 *     normal approximation to the mean is at its worst.
 *   - Underneath both: the median query carries ONE judgment (EVALUATION.md
 *     §5.2), so its nDCG@10 can only take one of eleven values — 0, or
 *     1/log2(r+1) for r in 1..10. Per-query scores are lattice-valued and the
 *     difference of two lattices is lattice-valued. Nothing here is smooth.
 *
 * The bootstrap assumes none of that. It resamples the empirical distribution,
 * which is what a spike-and-slab lattice actually is, and it yields the
 * interval directly in metric units — which is the deliverable PRIMER.md §5.5
 * names: "v4 beats v3 by 0.012, 95% CI [0.003, 0.021]".
 *
 * PAIRED. The differences are formed per query BEFORE anything is resampled,
 * so query difficulty cancels. Resampling the two score vectors independently
 * would discard the pairing and with it most of the power.
 *
 * TWO INVERSIONS, AND THEY ARE NOT THE SAME QUANTITY.
 *
 *   - The 95% interval is the PERCENTILE interval over resampled means. This is
 *     the estimate of where the true mean difference lies.
 *   - The p-value is the CENTRED (shifted) bootstrap ASL — shift the
 *     differences to mean zero, which is H0, resample, and count how often
 *     |mean*| reaches |observed mean|. This is an actual hypothesis test.
 *     Smucker, Allan & Carterette (2007), "A comparison of statistical
 *     significance tests for IR evaluation".
 *
 * PRIMER.md §5.5 describes a third reading — "if 9,800 of 10,000 resamples
 * still show v4 ahead, p ~= 0.02" — which is the interval inversion, not the
 * ASL. It is reported here as `favouringA` / `favouringB` counts under their
 * own names, deliberately NOT as a second p-value, because two p-values in one
 * report is an invitation to quote the smaller one.
 *
 * THE >= IS LOAD-BEARING, AND THE ALL-ZERO CASE IS WHY. When every difference
 * is 0, every centred resample mean is exactly 0, so |mean*| = 0 and
 * |observed| = 0. Counting `>=` gives p = 1.0, which is correct: two identical
 * runs are maximally consistent with H0. Counting `>` would give p = 0.0 — a
 * claim of perfect significance for a pair that does not differ on a single
 * query. That is not a hypothetical; it is the exact shape of the v1 cap
 * ablation at k <= 8, and it is the first thing the tests check.
 *
 * NO p = 0. The count uses the (1 + r) / (B + 1) convention, so the smallest
 * value this can return is 1 / (B + 1). A bootstrap with B resamples has no
 * standing to resolve anything below that, and printing 0.0000 would claim it
 * had.
 *
 * DETERMINISM. Math.random() cannot be seeded in Node, so it is unusable for a
 * number that goes in a document. mulberry32 is the same PRNG build-splits.js
 * uses at 1.4: seeded, dependency-free, all state transitions integer ops via
 * Math.imul, so the stream is identical on any platform and Node version.
 *
 * `seed` IS REQUIRED AND HAS NO DEFAULT IN THIS MODULE. A default here would
 * let a call site get a reproducible-looking number without ever naming the
 * seed it came from. The CLI owns the default and prints it.
 */

/**
 * mulberry32 — 32-bit seeded PRNG, identical to build-splits.js §1.4.
 *
 * Index selection below is Math.floor(rand() * n), which carries a modulo bias
 * of order n / 2^32 — about 5e-7 at n = 2,304. Stated rather than ignored; it
 * is the same construction 1.4's Fisher-Yates uses and it is orders of
 * magnitude below the Monte Carlo error of any B this will be run with.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

/**
 * The two-sided percentile interval of an ALREADY SORTED array, as a pair of
 * order statistics: index L = floor(alpha/2 * B) from the bottom, and its
 * mirror U = B - 1 - L from the top.
 *
 * ORDER STATISTICS, NOT INTERPOLATION. The resampled means are a discrete
 * empirical distribution. Interpolating between two of them invents a value the
 * bootstrap never produced, and at B = 10,000 the conventions differ by less
 * than the Monte Carlo error anyway — so this is a choice about honesty rather
 * than about accuracy.
 *
 * SYMMETRIC BY CONSTRUCTION, and that is not cosmetic. Negating every
 * difference (which is what swapping A and B does) reverses the sorted array,
 * mapping index i to B-1-i. Picking the endpoints as L and B-1-L makes the
 * interval mirror EXACTLY under that swap: comparing A against B and B against
 * A give intervals that are each other's negation to the last bit.
 *
 * The obvious nearest-rank convention — ceil(q * B) - 1 at each end
 * independently — does NOT have this property. At B = 1,000 and alpha = 0.05 it
 * picks index 24 from the bottom and index 974 from the top, which are 25 and
 * 26 places in from their respective ends: off by one order statistic, worth
 * ~2e-4 on real dev data. Measured, not reasoned: a mirror test caught it.
 * That matters here because results/comparisons/registry.json deliberately
 * accepts a registered pair in either direction, so both orders will be run.
 */
function percentileInterval(sorted, alpha) {
  const b = sorted.length;
  if (b === 0) return [null, null];
  const lower = Math.min(b - 1, Math.max(0, Math.floor((alpha / 2) * b)));
  const upper = b - 1 - lower;
  return [sorted[Math.min(lower, upper)], sorted[Math.max(lower, upper)]];
}

/**
 * Paired bootstrap over per-query differences.
 *
 * @param {number[]} differences  score_A - score_B, one per query, already paired
 * @param {Object}   options
 * @param {number}   options.seed       required; no default in this module
 * @param {number}   options.resamples  B
 * @param {number}   options.alpha      two-sided, so the interval is 1 - alpha
 * @returns {Object}
 */
function pairedBootstrap(differences, options) {
  const { seed, resamples = 10000, alpha = 0.05 } = options || {};

  if (!Number.isInteger(seed)) {
    throw new TypeError(`bootstrap: seed must be an integer (got ${seed})`);
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new TypeError(`bootstrap: resamples must be a positive integer (got ${resamples})`);
  }
  if (!(alpha > 0 && alpha < 1)) {
    throw new TypeError(`bootstrap: alpha must be in (0, 1) (got ${alpha})`);
  }
  if (!Array.isArray(differences) || differences.length === 0) {
    throw new TypeError('bootstrap: differences must be a non-empty array');
  }
  for (let i = 0; i < differences.length; i += 1) {
    if (!Number.isFinite(differences[i])) {
      throw new TypeError(`bootstrap: differences[${i}] is not a finite number (${differences[i]})`);
    }
  }

  const n = differences.length;
  const observed = mean(differences);

  // Counted with exact float inequality. Two per-query scores that agree to
  // 1e-16 but not to the bit are counted as differing, which is the
  // conservative direction: it can only make `differing` larger, never smaller,
  // so it cannot manufacture an appearance of identity that is not there.
  let differing = 0;
  let aBetter = 0;
  let bBetter = 0;
  for (let i = 0; i < n; i += 1) {
    if (differences[i] > 0) { differing += 1; aBetter += 1; }
    else if (differences[i] < 0) { differing += 1; bBetter += 1; }
  }

  // H0: the mean difference is zero. Shifting the whole vector by -observed
  // imposes exactly that while preserving the shape of the distribution, which
  // is the property a parametric test has to assume instead.
  const centred = new Float64Array(n);
  for (let i = 0; i < n; i += 1) centred[i] = differences[i] - observed;

  const rand = mulberry32(seed);
  const resampledMeans = new Float64Array(resamples);
  let atLeastAsExtreme = 0;
  let resamplesFavouringA = 0;
  let resamplesFavouringB = 0;
  const absObserved = Math.abs(observed);

  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    let centredSum = 0;
    // ONE index draw feeding BOTH sums, so the percentile interval and the ASL
    // are computed over the same resamples rather than over two independent
    // bootstraps that happen to share a seed. Halves the PRNG draws and, more
    // to the point, makes the two numbers describe one experiment.
    for (let i = 0; i < n; i += 1) {
      const j = Math.floor(rand() * n);
      sum += differences[j];
      centredSum += centred[j];
    }
    const m = sum / n;
    resampledMeans[b] = m;
    if (m > 0) resamplesFavouringA += 1;
    else if (m < 0) resamplesFavouringB += 1;

    // >= not >. On an all-zero difference vector both sides are 0 and this is
    // what returns p = 1.0 rather than p = 0.0. See the header.
    if (Math.abs(centredSum / n) >= absObserved) atLeastAsExtreme += 1;
  }

  // (1 + r) / (B + 1): never 0, and honest about the resolution floor.
  const p = (1 + atLeastAsExtreme) / (resamples + 1);

  // Monte Carlo standard error of p itself — the part of the p-value that is
  // resampling noise rather than data. Reported beside p so the choice of B is
  // visible instead of being something the reader has to take on trust.
  const pMonteCarloSe = Math.sqrt((p * (1 - p)) / resamples);

  const sorted = Float64Array.from(resampledMeans).sort();
  const [ciLow, ciHigh] = percentileInterval(sorted, alpha);

  return {
    n,
    observedMeanDifference: observed,
    ci: [ciLow, ciHigh],
    ciLevel: 1 - alpha,
    p,
    pMonteCarloSe,
    pFloor: 1 / (resamples + 1),
    // True when the difference vector is identically zero. The caller reports
    // this case differently — a zero-width interval is zero-width BY
    // CONSTRUCTION, and printing it beside a resampled one without saying so
    // would imply the bootstrap had established something.
    degenerate: differing === 0,
    differing,
    aBetter,
    bBetter,
    // The mean over the queries that actually moved. On a spike-and-slab
    // difference vector this is the quantity with any content in it; the
    // overall mean is that number diluted by the point mass at zero.
    meanOverDiffering: differing === 0
      ? null
      : differences.reduce((acc, d) => acc + d, 0) / differing,
    resamples,
    seed,
    prng: 'mulberry32',
    resamplesFavouringA,
    resamplesFavouringB,
    resamplesTied: resamples - resamplesFavouringA - resamplesFavouringB
  };
}

module.exports = { mulberry32, mean, percentileInterval, pairedBootstrap };
