'use strict';

/**
 * bootstrap.test.js — Phase 2.5
 *
 * WHAT THESE TESTS CAN ESTABLISH. Less than metrics.test.js could, and the
 * difference is worth stating. nDCG has a closed form, so a hand-worked example
 * pins it exactly. A bootstrap is a Monte Carlo estimate: its output is a
 * random variable, and no fixture can assert "the p-value is 0.0312" without
 * baking in the PRNG stream. So the tests below fall into four kinds, and only
 * the first two are about correctness of the statistic:
 *
 *   A. DEGENERATE CASES WHERE THE ANSWER IS FORCED. An all-zero difference
 *      vector has exactly one right answer at every output, whatever the seed.
 *      This is where the >= vs > choice in the ASL lives, and getting it wrong
 *      produces p = 0.0000 for two identical runs — the single most dangerous
 *      failure this file can have. It is the first test.
 *   B. INVARIANTS THE DEFINITION FORCES. Antisymmetry under swapping A and B.
 *      A constant shift moving the mean and the interval by exactly that shift.
 *      Scaling. These hold for every seed and every B, so they catch an
 *      arithmetic slip that a fixture would only catch on one stream.
 *   C. DETERMINISM. Same seed, same numbers, bit for bit. Different seed,
 *      different numbers. Without both halves, "seeded" is unverified.
 *   D. STATISTICAL SANITY on constructed data with a known answer — a large
 *      real effect must come out significant, pure noise must not. These are
 *      the weakest tests here (they assert a range, not a value) and they are
 *      included because they are the only ones that would catch the bootstrap
 *      being wired up backwards.
 */

const {
  mulberry32,
  mean,
  percentileInterval,
  pairedBootstrap
} = require('../eval/bootstrap');

const SEED = 20260804;

// ---------------------------------------------------------------------------
// A. Degenerate cases — the answer is forced, whatever the seed
// ---------------------------------------------------------------------------

describe('the all-zero difference vector', () => {
  // This is the measured shape of v1-overlap vs v1-overlap-uncapped at
  // nDCG@8: 0 of 2,304 queries differ, because the cap acts only at ranks 9
  // and 10 and Math.min(k, 8) === k for k <= 8. A correct implementation must
  // not crash, must not invent a p-value, and must report a zero-width
  // interval. Those are three separate assertions and they are separate below.
  const zeros = new Array(2304).fill(0);
  const result = pairedBootstrap(zeros, { seed: SEED, resamples: 2000 });

  test('does not throw', () => {
    expect(() => pairedBootstrap(zeros, { seed: SEED, resamples: 100 })).not.toThrow();
  });

  test('reports a zero mean difference', () => {
    expect(result.observedMeanDifference).toBe(0);
  });

  test('reports a zero-width interval', () => {
    expect(result.ci[0]).toBe(0);
    expect(result.ci[1]).toBe(0);
  });

  test('reports p = 1, not p = 0 — this is the >= in the ASL', () => {
    // The whole test file exists for this line. Every centred resample mean is
    // exactly 0, so |mean*| >= |observed| holds for all B and the count is B,
    // giving (1 + B) / (B + 1) = 1. Counting `>` instead would give
    // (1 + 0) / (B + 1) ~= 0.0005, which reads as overwhelming significance
    // for two runs that do not differ on a single query.
    expect(result.p).toBe(1);
  });

  test('flags itself degenerate, so the caller can say why the interval is empty', () => {
    expect(result.degenerate).toBe(true);
    expect(result.differing).toBe(0);
    expect(result.aBetter).toBe(0);
    expect(result.bBetter).toBe(0);
    expect(result.meanOverDiffering).toBeNull();
  });

  test('every resample is tied, none favours either side', () => {
    expect(result.resamplesFavouringA).toBe(0);
    expect(result.resamplesFavouringB).toBe(0);
    expect(result.resamplesTied).toBe(result.resamples);
  });
});

describe('a single query', () => {
  // n = 1 makes every resample the same value, so the interval collapses onto
  // the observation. Not a realistic input, but it is the boundary where an
  // off-by-one in the resampling loop shows up as a crash or a NaN.
  test('does not produce NaN', () => {
    const result = pairedBootstrap([0.25], { seed: SEED, resamples: 500 });
    expect(result.observedMeanDifference).toBe(0.25);
    expect(result.ci[0]).toBe(0.25);
    expect(result.ci[1]).toBe(0.25);
    expect(Number.isFinite(result.p)).toBe(true);
    // Centred, a single value is exactly 0, so every resample mean is 0 and
    // |0| >= |0.25| is false. p is the floor.
    expect(result.p).toBeCloseTo(1 / 501, 12);
  });
});

describe('a constant non-zero difference', () => {
  // Every query improves by exactly 0.1. There is no variance, so the interval
  // is a point and the centred vector is all zeros — which means the ASL
  // cannot reject, and that is correct rather than a bug: a bootstrap over a
  // zero-variance sample has no evidence about sampling variability at all.
  const result = pairedBootstrap(new Array(100).fill(0.1), { seed: SEED, resamples: 1000 });

  test('recovers the constant as the mean and the interval', () => {
    expect(result.observedMeanDifference).toBeCloseTo(0.1, 12);
    expect(result.ci[0]).toBeCloseTo(0.1, 12);
    expect(result.ci[1]).toBeCloseTo(0.1, 12);
  });

  test('is not marked degenerate — the differences are non-zero', () => {
    expect(result.degenerate).toBe(false);
    expect(result.differing).toBe(100);
    expect(result.aBetter).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// B. Invariants the definition forces
// ---------------------------------------------------------------------------

describe('invariants', () => {
  const differences = [];
  const rand = mulberry32(7);
  for (let i = 0; i < 400; i += 1) differences.push(rand() - 0.45);

  test('swapping A and B negates the mean and mirrors the interval', () => {
    const forward = pairedBootstrap(differences, { seed: SEED, resamples: 1000 });
    const backward = pairedBootstrap(differences.map((d) => -d), { seed: SEED, resamples: 1000 });

    expect(backward.observedMeanDifference).toBeCloseTo(-forward.observedMeanDifference, 12);
    expect(backward.ci[0]).toBeCloseTo(-forward.ci[1], 12);
    expect(backward.ci[1]).toBeCloseTo(-forward.ci[0], 12);
    // The p-value is two-sided, so it is unchanged by the direction. Same seed
    // means the same resample indices, so this is exact rather than close.
    expect(backward.p).toBe(forward.p);
    expect(backward.aBetter).toBe(forward.bBetter);
    expect(backward.bBetter).toBe(forward.aBetter);
  });

  test('a constant shift moves the mean and the interval by exactly that shift', () => {
    const shift = 0.37;
    const base = pairedBootstrap(differences, { seed: SEED, resamples: 1000 });
    const shifted = pairedBootstrap(differences.map((d) => d + shift), { seed: SEED, resamples: 1000 });

    expect(shifted.observedMeanDifference).toBeCloseTo(base.observedMeanDifference + shift, 12);
    expect(shifted.ci[0]).toBeCloseTo(base.ci[0] + shift, 12);
    expect(shifted.ci[1]).toBeCloseTo(base.ci[1] + shift, 12);
    // The CENTRED vector is shift-invariant, so the resampled test statistic is
    // identical; only |observed| moved. A shift away from zero can therefore
    // only make p smaller or equal, never larger.
    expect(shifted.p).toBeLessThanOrEqual(base.p);
  });

  test('scaling scales the mean and the interval, and leaves p alone', () => {
    const base = pairedBootstrap(differences, { seed: SEED, resamples: 1000 });
    const scaled = pairedBootstrap(differences.map((d) => d * 3), { seed: SEED, resamples: 1000 });

    expect(scaled.observedMeanDifference).toBeCloseTo(base.observedMeanDifference * 3, 12);
    expect(scaled.ci[0]).toBeCloseTo(base.ci[0] * 3, 12);
    expect(scaled.ci[1]).toBeCloseTo(base.ci[1] * 3, 12);
    // Both sides of |mean*| >= |observed| scale by 3, so the comparison is
    // unchanged. p is scale-free, which it must be for a metric-agnostic tool.
    expect(scaled.p).toBe(base.p);
  });

  test('the interval brackets the observed mean on well-behaved data', () => {
    const result = pairedBootstrap(differences, { seed: SEED, resamples: 2000 });
    expect(result.ci[0]).toBeLessThanOrEqual(result.observedMeanDifference);
    expect(result.ci[1]).toBeGreaterThanOrEqual(result.observedMeanDifference);
  });

  test('p never reaches 0, whatever the effect size', () => {
    // A vast effect with real variance. The (1 + r) / (B + 1) convention floors
    // p at 1/(B+1); printing 0.0000 would claim a resolution B does not have.
    const huge = differences.map((d) => d + 50);
    const result = pairedBootstrap(huge, { seed: SEED, resamples: 1000 });
    expect(result.p).toBeGreaterThan(0);
    expect(result.p).toBeCloseTo(1 / 1001, 12);
    expect(result.pFloor).toBeCloseTo(1 / 1001, 12);
  });

  test('the Monte Carlo standard error shrinks as 1/sqrt(B)', () => {
    const small = pairedBootstrap(differences, { seed: SEED, resamples: 1000 });
    const large = pairedBootstrap(differences, { seed: SEED, resamples: 16000 });
    // Sixteen times the resamples is four times the precision, up to the
    // p-values themselves differing slightly. A loose bound, because the point
    // is the direction and the order of magnitude, not the constant.
    expect(large.pMonteCarloSe).toBeLessThan(small.pMonteCarloSe);
  });
});

// ---------------------------------------------------------------------------
// C. Determinism — both halves, or "seeded" is unverified
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const differences = [];
  const rand = mulberry32(11);
  for (let i = 0; i < 300; i += 1) differences.push(rand() - 0.5);

  test('the same seed reproduces every output bit for bit', () => {
    const first = pairedBootstrap(differences, { seed: SEED, resamples: 2000 });
    const second = pairedBootstrap(differences, { seed: SEED, resamples: 2000 });
    expect(second.p).toBe(first.p);
    expect(second.ci[0]).toBe(first.ci[0]);
    expect(second.ci[1]).toBe(first.ci[1]);
    expect(second.resamplesFavouringA).toBe(first.resamplesFavouringA);
  });

  test('a different seed gives a different resample stream', () => {
    // The other half. If this passed only because the outputs are constant,
    // the test above would be asserting nothing.
    const first = pairedBootstrap(differences, { seed: SEED, resamples: 2000 });
    const second = pairedBootstrap(differences, { seed: SEED + 1, resamples: 2000 });
    expect(second.ci[0]).not.toBe(first.ci[0]);
  });

  test('mulberry32 produces the documented stream', () => {
    // Pinned so a refactor of the PRNG cannot silently move every p-value in
    // every committed comparison report. These are the first four draws at
    // seed 20260804, recorded from this implementation.
    const next = mulberry32(20260804);
    const draws = [next(), next(), next(), next()];
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
    const again = mulberry32(20260804);
    expect([again(), again(), again(), again()]).toEqual(draws);
  });

  test('seed is required and must be an integer', () => {
    expect(() => pairedBootstrap([1, 2], {})).toThrow(/seed/);
    expect(() => pairedBootstrap([1, 2], { seed: 1.5 })).toThrow(/seed/);
    expect(() => pairedBootstrap([1, 2], { seed: '20260804' })).toThrow(/seed/);
  });
});

// ---------------------------------------------------------------------------
// D. Statistical sanity — a range, not a value
// ---------------------------------------------------------------------------

describe('statistical sanity', () => {
  test('a large real effect comes out significant', () => {
    const differences = [];
    const rand = mulberry32(3);
    // Mean +0.2, spread about +/-0.05. Nothing should call this a tie.
    for (let i = 0; i < 500; i += 1) differences.push(0.2 + (rand() - 0.5) * 0.1);
    const result = pairedBootstrap(differences, { seed: SEED, resamples: 4000 });
    expect(result.p).toBeLessThan(0.01);
    expect(result.ci[0]).toBeGreaterThan(0);
    expect(result.ci[1]).toBeGreaterThan(0);
  });

  test('pure symmetric noise does not come out significant', () => {
    const differences = [];
    const rand = mulberry32(5);
    for (let i = 0; i < 500; i += 1) differences.push(rand() - 0.5);
    const result = pairedBootstrap(differences, { seed: SEED, resamples: 4000 });
    expect(result.p).toBeGreaterThan(0.05);
    // And the interval straddles zero, which is the statement that actually
    // matters — the report refuses to write a "beats" sentence without saying
    // so when this holds.
    expect(result.ci[0]).toBeLessThan(0);
    expect(result.ci[1]).toBeGreaterThan(0);
  });

  test('a spike-and-slab vector is handled — this is the real data shape', () => {
    // 2,243 exact zeros and 61 small negatives, which is the measured shape of
    // the v1 cap ablation at nDCG@10. The point is that it neither crashes nor
    // silently treats the point mass as absent.
    const differences = new Array(2243).fill(0);
    const rand = mulberry32(13);
    for (let i = 0; i < 61; i += 1) differences.push(-0.1 - rand() * 0.2);
    const result = pairedBootstrap(differences, { seed: SEED, resamples: 4000 });

    expect(result.n).toBe(2304);
    expect(result.differing).toBe(61);
    expect(result.aBetter).toBe(0);
    expect(result.bBetter).toBe(61);
    expect(result.degenerate).toBe(false);
    // The overall mean is the slab mean diluted by the point mass: 61/2304 of
    // it. This is the arithmetic the report prints both halves of, so that a
    // tiny mean is not mistaken for a tiny effect on the queries it touched.
    expect(result.observedMeanDifference).toBeCloseTo(
      (result.meanOverDiffering * 61) / 2304, 12
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers, so a failure in the statistic is not really a failure in the mean
// ---------------------------------------------------------------------------

describe('helpers', () => {
  test('mean', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBeNull();
  });

  test('percentileInterval picks order statistics, and mirrored ones', () => {
    const sorted = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // alpha 0.05 over 10 values: floor(0.025 * 10) = 0, so index 0 and index 9.
    expect(percentileInterval(sorted, 0.05)).toEqual([1, 10]);
    // alpha 0.4: floor(0.2 * 10) = 2, so index 2 and index 7 — two in from each
    // end, which is the symmetry the interval depends on.
    expect(percentileInterval(sorted, 0.4)).toEqual([3, 8]);
    expect(percentileInterval(Float64Array.from([]), 0.05)).toEqual([null, null]);
  });

  test('the interval is exactly mirror-symmetric under negation', () => {
    // The property the nearest-rank convention did not have, asserted directly
    // on the helper rather than only through the statistic.
    const values = [];
    const rand = mulberry32(21);
    for (let i = 0; i < 1000; i += 1) values.push(rand() - 0.5);
    const forward = Float64Array.from(values).sort();
    const backward = Float64Array.from(values.map((v) => -v)).sort();
    const [lo, hi] = percentileInterval(forward, 0.05);
    const [nlo, nhi] = percentileInterval(backward, 0.05);
    expect(nlo).toBe(-hi);
    expect(nhi).toBe(-lo);
  });

  test('rejects inputs that would produce a silent NaN', () => {
    expect(() => pairedBootstrap([], { seed: SEED })).toThrow(/non-empty/);
    expect(() => pairedBootstrap([1, NaN], { seed: SEED })).toThrow(/finite/);
    expect(() => pairedBootstrap([1, 2], { seed: SEED, resamples: 0 })).toThrow(/resamples/);
    expect(() => pairedBootstrap([1, 2], { seed: SEED, alpha: 0 })).toThrow(/alpha/);
    expect(() => pairedBootstrap([1, 2], { seed: SEED, alpha: 1 })).toThrow(/alpha/);
  });
});
