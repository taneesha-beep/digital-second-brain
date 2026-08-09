'use strict';

/**
 * The generated sentence's confidence interval — the regression test for a bug
 * that reached two committed artifacts (3.6).
 *
 * `compare-runs.js` ends every primary result with one line meant to be quoted:
 *
 *     v6-hybrid-combsum beats v6-hybrid by 0.0006 nDCG@8,
 *     95% CI [...] (p not reported).
 *
 * The sentence names the winner first, so a negative difference swaps A and B,
 * and the interval must be re-expressed in that swapped direction — a negation
 * and a swap of the endpoints, [lo, hi] -> [-hi, -lo]. The original code wrote
 * [min(|lo|,|hi|), max(|lo|,|hi|)] instead. That is the same thing whenever the
 * endpoints share a sign, and it is a conclusion-inverting lie the moment the
 * interval straddles zero: a true [-0.004541, +0.005812] printed as
 * [0.0045, 0.0058], an interval that appears to EXCLUDE zero.
 *
 * The failure mode is worth stating because it explains why it survived two
 * rungs. It struck NULLS ONLY. Every interval clear of zero printed correctly,
 * so the reports that carried real findings were all fine — and the reports it
 * corrupted were the ones saying "no effect here", in the single line a reader
 * is most likely to lift. The grid and the §5 header above it were correct the
 * whole time, which is why the prose in EVALUATION.md quoting them was never
 * wrong.
 *
 * The straddling cases are therefore the point of this file, not an edge case
 * appended to it.
 */

const { sentenceInterval } = require('../scripts/compare-runs');

describe('sentenceInterval — the swap is a mirror, not an absolute value', () => {
  test('a positive difference leaves the interval alone', () => {
    expect(sentenceInterval(+0.0351, [+0.0255, +0.0449])).toEqual([+0.0255, +0.0449]);
  });

  test('a negative difference negates AND swaps the endpoints', () => {
    // v6-hybrid-d100 vs v6-hybrid: the sentence swaps to "v6-hybrid beats
    // v6-hybrid-d100", so the interval must come out entirely positive.
    expect(sentenceInterval(-0.000646, [-0.001381, -0.000048]))
      .toEqual([+0.000048, +0.001381]);
  });

  test('THE BUG: a straddling interval keeps its negative endpoint', () => {
    // §18.5a, verbatim from the committed report's §5 header. The old code
    // printed [0.0045, 0.0058] here — an interval excluding zero for what the
    // rung's own writeup calls "a null, and the load-bearing ablation".
    const [lo, hi] = sentenceInterval(+0.000604, [-0.004541, +0.005812]);
    expect(lo).toBeCloseTo(-0.004541, 12);
    expect(hi).toBeCloseTo(+0.005812, 12);
    expect(lo).toBeLessThan(0);
  });

  test('THE BUG, second occurrence: v6-hybrid-tuned vs v5-embeddings', () => {
    // §18.6's "clean null". The old code printed [0.0068, 0.0071], which reads
    // as the tuned hybrid beating the winner with an interval clear of zero —
    // the exact opposite of what the comparison found.
    const [lo, hi] = sentenceInterval(+0.000149, [-0.006823, +0.007067]);
    expect(lo).toBeCloseTo(-0.006823, 12);
    expect(hi).toBeCloseTo(+0.007067, 12);
    expect(lo).toBeLessThan(0);
  });

  test('a straddling interval on a NEGATIVE difference also keeps its sign', () => {
    // The other half of the straddling case, which no real comparison in this
    // repo has produced yet. Under the swap [-0.005, +0.003] must become
    // [-0.003, +0.005] — still straddling, still honest.
    expect(sentenceInterval(-0.001, [-0.005, +0.003])).toEqual([-0.003, +0.005]);
  });

  test('the straddling property survives the swap, which is the invariant', () => {
    // Whatever the direction, an interval containing zero must still contain
    // zero after re-expression. The old code broke exactly this.
    const straddles = ([lo, hi]) => lo <= 0 && hi >= 0;
    for (const ci of [[-0.004541, +0.005812], [-0.006823, +0.007067], [-0.005, +0.003], [0, +0.0006]]) {
      expect(straddles(sentenceInterval(+0.001, ci))).toBe(true);
      expect(straddles(sentenceInterval(-0.001, ci))).toBe(true);
    }
  });

  test('applying it twice returns the original, so it is an involution', () => {
    // Mirroring twice is the identity. Holds for the swap branch and is what
    // makes "the registry accepts a pair in either direction" (§11.2) true of
    // the printed line and not only of the bootstrap that produced it.
    const ci = [-0.004541, +0.005812];
    expect(sentenceInterval(-1, sentenceInterval(-1, ci))).toEqual(ci);
  });
});
