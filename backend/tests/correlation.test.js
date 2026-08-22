'use strict';

/**
 * correlation.test.js — Phase 5.7. PURE: no network, no key, no database,
 * nothing under data/. Needs no precondition, so CI's promised-skip ledger
 * does not move and ci.yml is untouched.
 *
 * §33.7's argument, reused because it is the same argument: a correlation
 * computed wrongly LOOKS exactly like a correlation. So the arithmetic is
 * pinned against examples computed by hand, and there is a test asserting the
 * tie-handling differs from the shortcut every reference prints.
 */

const {
  mean, sd, averageRanks, pearson, spearman, fisherCI, detectableR, pairedDiff, icc, mde
} = require('../scripts/lib/correlation');

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('mean and sd', () => {
  test('mean is the arithmetic mean', () => close(mean([1, 2, 3, 4]), 2.5));
  test('mean of an empty sample throws rather than returning NaN', () => {
    expect(() => mean([])).toThrow(/empty/);
  });

  // Hand-computed: mean 4, deviations -2,-1,1,2, squares 4+1+1+4 = 10,
  // divided by n-1 = 3 -> 10/3, sqrt = 1.8257418583505538.
  test('sd uses n-1, not n', () => {
    close(sd([2, 3, 5, 6]), Math.sqrt(10 / 3));
    // The n-divisor answer would be sqrt(10/4) = 1.5811..., a plausible number.
    expect(Math.abs(sd([2, 3, 5, 6]) - Math.sqrt(10 / 4))).toBeGreaterThan(0.2);
  });
  test('sd is undefined below n=2 and returns null, not 0', () => {
    expect(sd([5])).toBeNull();
    expect(sd([])).toBeNull();
  });
});

describe('averageRanks', () => {
  test('no ties is 1..n in value order', () => {
    expect(averageRanks([30, 10, 20])).toEqual([3, 1, 2]);
  });
  test('a tied pair shares the mean of the ranks it spans', () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });
  test('a tie group of three spans ranks 2,3,4 and shares 3', () => {
    expect(averageRanks([1, 5, 5, 5, 9])).toEqual([1, 3, 3, 3, 5]);
  });
  // The regime this data is actually in: most of the sample tied at zero.
  test('an all-but-one tie at zero — the shape 17 of 30 seeds are in', () => {
    const xs = [0, 0, 0, 0, 0.5];
    expect(averageRanks(xs)).toEqual([2.5, 2.5, 2.5, 2.5, 5]);
  });
  test('every value tied gives every rank the same value', () => {
    expect(averageRanks([7, 7, 7])).toEqual([2, 2, 2]);
  });
});

describe('pearson', () => {
  test('a perfect positive linear relation is exactly 1', () => close(pearson([1, 2, 3], [2, 4, 6]), 1));
  test('a perfect negative linear relation is exactly -1', () => close(pearson([1, 2, 3], [6, 4, 2]), -1));

  // Hand-computed. x = [1,2,3,4], y = [2,4,5,4]. mx = 2.5, my = 3.75.
  //   dev x  -1.5  -0.5   0.5   1.5
  //   dev y  -1.75  0.25  1.25  0.25
  //   num = 2.625 - 0.125 + 0.625 + 0.375 = 3.5
  //   dx  = 2.25+0.25+0.25+2.25 = 5
  //   dy  = 3.0625+0.0625+1.5625+0.0625 = 4.75
  //   r   = 3.5 / sqrt(23.75) = 0.7181848464596079
  test('a worked example computed by hand', () => {
    close(pearson([1, 2, 3, 4], [2, 4, 5, 4]), 3.5 / Math.sqrt(23.75));
  });

  test('a constant sample returns null — undefined, not zero', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [4, 4, 4])).toBeNull();
  });
  test('r is invariant to a positive affine rescale of either sample', () => {
    const x = [1, 4, 2, 8, 5];
    const y = [3, 1, 4, 1, 5];
    close(pearson(x, y), pearson(x.map((v) => 3 * v + 7), y));
  });
  test('r is symmetric in its arguments', () => {
    const x = [1, 4, 2, 8, 5];
    const y = [3, 1, 4, 1, 5];
    close(pearson(x, y), pearson(y, x));
  });
  test('a length mismatch throws rather than silently truncating', () => {
    expect(() => pearson([1, 2, 3], [1, 2])).toThrow(/length mismatch/);
  });
  test('below n=2 there is nothing to correlate', () => {
    expect(pearson([1], [2])).toBeNull();
  });
});

describe('spearman', () => {
  test('a monotone NON-linear relation is exactly 1 where pearson is not', () => {
    const x = [1, 2, 3, 4];
    const y = [1, 4, 9, 16];
    close(spearman(x, y), 1);
    expect(pearson(x, y)).toBeLessThan(1);
  });

  // THE MUTATION THIS SUITE EXISTS FOR, AND THE EXAMPLE IS THIS DATA'S OWN
  // SHAPE: most of the sample tied at the bottom. On the 30 golden seeds
  // between 11 and 22 of them score nDCG@8 = 0 depending on the rung.
  //
  //   x = [1, 1, 1, 1, 5], y = [1, 2, 3, 4, 5]
  //   average ranks   x -> [2.5, 2.5, 2.5, 2.5, 5]   y -> [1, 2, 3, 4, 5]
  //   dev x  -0.5 -0.5 -0.5 -0.5  2      dev y  -2 -1 0 1 2
  //   num = 1 + 0.5 + 0 - 0.5 + 4 = 5;  dx = 5;  dy = 10
  //   correct rho = 5 / sqrt(50) = 0.7071067811865475
  //   the shortcut, d = [1.5, 0.5, -0.5, -1.5, 0], sum d^2 = 5:
  //     1 - 6(5)/(5*24) = 0.75   — wrong by 0.043
  test('ties: average ranks, not the 6*sum(d^2) shortcut', () => {
    const rho = spearman([1, 1, 1, 1, 5], [1, 2, 3, 4, 5]);
    const shortcut = 1 - (6 * 5) / (5 * (25 - 1));
    close(rho, 5 / Math.sqrt(50));
    close(rho, pearson([2.5, 2.5, 2.5, 2.5, 5], [1, 2, 3, 4, 5]));
    close(shortcut, 0.75);
    expect(Math.abs(rho - shortcut)).toBeGreaterThan(0.04);
  });

  test('the shortcut and the definition agree when there are NO ties', () => {
    const x = [10, 20, 30, 40];
    const y = [20, 10, 40, 30];
    // d = [1,-1,-1,1], sum d^2 = 4 -> 1 - 24/60 = 0.6
    close(spearman(x, y), 0.6, 1e-12);
  });

  test('a sample tied end to end returns null, not zero', () => {
    expect(spearman([5, 5, 5], [1, 2, 3])).toBeNull();
  });
  test('rho is invariant to any monotone transform of either sample', () => {
    const x = [1, 4, 2, 8, 5];
    const y = [3, 1, 4, 1, 5];
    close(spearman(x, y), spearman(x.map((v) => Math.log(v)), y));
  });
});

describe('fisherCI', () => {
  // Hand-computed: r = 0.5, n = 28 -> z = atanh(0.5) = 0.5493061443340549,
  // se = 1/5 = 0.2, so [tanh(0.1573...), tanh(0.9413...)].
  test('the interval is built in z space and transformed back', () => {
    const ci = fisherCI(0.5, 28);
    close(ci.se, 0.2);
    close(ci.lo, Math.tanh(Math.atanh(0.5) - 1.96 * 0.2));
    close(ci.hi, Math.tanh(Math.atanh(0.5) + 1.96 * 0.2));
  });
  test('the interval is ASYMMETRIC around r — the naive version is not', () => {
    const ci = fisherCI(0.8, 30);
    const below = 0.8 - ci.lo;
    const above = ci.hi - 0.8;
    expect(below).toBeGreaterThan(above);
  });
  test('the interval never overhangs +/-1', () => {
    const ci = fisherCI(0.97, 20);
    expect(ci.hi).toBeLessThan(1);
    expect(ci.lo).toBeGreaterThan(-1);
  });
  test('n < 4 has no standard error and returns null', () => {
    expect(fisherCI(0.5, 3)).toBeNull();
  });
  test('a null r carries through as null rather than throwing', () => {
    expect(fisherCI(null, 30)).toBeNull();
  });
});

describe('detectableR', () => {
  test('the sample sizes 5.7 actually has', () => {
    expect(detectableR(23)).toBeCloseTo(0.412, 3);
    expect(detectableR(46)).toBeCloseTo(0.290, 3);
  });
  test('it falls as n rises', () => {
    expect(detectableR(100)).toBeLessThan(detectableR(23));
  });
  test('n < 4 is undefined', () => expect(detectableR(3)).toBeNull());
});

describe('pairedDiff', () => {
  // Hand-computed. a-b = [1, -1, 3, 1]. mean 1, deviations 0,-2,2,0,
  // squares 0+4+4+0 = 8, /3 -> sd = sqrt(8/3) = 1.632993161855452.
  // t = 1 / (sqrt(8/3)/2) = 2/sqrt(8/3) = 1.224744871391589
  test('t is computed on the DIFFERENCES, not on the two means', () => {
    const d = pairedDiff([4, 2, 6, 5], [3, 3, 3, 4]);
    close(d.mean, 1);
    close(d.sd, Math.sqrt(8 / 3));
    close(d.t, 1 / (Math.sqrt(8 / 3) / 2));
    expect(d.n).toBe(4);
  });
  test('it counts each direction and the ties separately', () => {
    const d = pairedDiff([1, 5, 3, 3], [2, 1, 3, 9]);
    expect(d.positive).toBe(1);
    expect(d.negative).toBe(2);
    expect(d.zero).toBe(1);
  });
  test('identical samples give t null rather than 0/0 = NaN', () => {
    const d = pairedDiff([1, 2, 3], [1, 2, 3]);
    close(d.mean, 0);
    expect(d.t).toBeNull();
    expect(d.zero).toBe(3);
  });
  test('the sign convention is a minus b', () => {
    expect(pairedDiff([5], [3]).mean).toBe(2);
  });
  test('a length mismatch throws', () => {
    expect(() => pairedDiff([1, 2], [1])).toThrow(/length mismatch/);
  });
});

describe('icc and the design effect', () => {
  test('groups that are internally identical and mutually different give ICC 1', () => {
    const r = icc([[1, 1, 1], [5, 5, 5], [9, 9, 9]]);
    close(r.icc, 1);
    close(r.designEffect, 3);
  });
  test('a design effect of 1 means no clustering correction is bought', () => {
    // Groups drawn from one distribution: between-group variance ~ within.
    const r = icc([[1, 5, 9], [9, 1, 5], [5, 9, 1]]);
    close(r.icc, -0.5);
    expect(r.designEffect).toBe(1);
  });
  test('a NEGATIVE icc is reported as measured but floored where it feeds deff', () => {
    const r = icc([[0, 10], [10, 0], [0, 10]]);
    expect(r.icc).toBeLessThan(0);
    expect(r.designEffect).toBe(1);
  });
  test('it reports the group count and items per group it used', () => {
    const r = icc([[1, 2], [3, 4], [5, 6]]);
    expect(r.groups).toBe(3);
    expect(r.n).toBe(6);
    close(r.itemsPerGroup, 2);
  });
  test('one group, or one item per group, is undefined', () => {
    expect(icc([[1, 2, 3]])).toBeNull();
    expect(icc([[1], [2], [3]])).toBeNull();
  });
  test('empty groups are dropped rather than counted as zero-variance', () => {
    expect(icc([[1, 2], [3, 4], []]).groups).toBe(2);
  });
});

describe('mde', () => {
  // Hand-computed: 2.8016 * 0.5 * sqrt(2/100) = 2.8016*0.5*0.1414213562373095
  test('the two-sample form at deff 1', () => {
    close(mde(0.5, 100, 1), 2.8016 * 0.5 * Math.sqrt(2 / 100));
  });
  test('clustering inflates the MDE by sqrt(design effect)', () => {
    close(mde(0.5, 100, 4) / mde(0.5, 100, 1), 2);
  });
  test('it falls as 1/sqrt(n)', () => {
    close(mde(1, 100, 1) / mde(1, 400, 1), 2);
  });
  test('a zero or missing sd has no MDE', () => {
    expect(mde(0, 100)).toBeNull();
    expect(mde(null, 100)).toBeNull();
  });
});

describe('the properties the 5.7 report depends on', () => {
  // If this broke, every correlation in the report would be computed on the
  // wrong pairing and would still print a plausible number.
  test('pearson pairs by index, so a shuffled y is a different answer', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 1, 5, 3, 4];
    const shuffled = [5, 3, 4, 2, 1];
    expect(pearson(x, y)).not.toBeCloseTo(pearson(x, shuffled), 6);
  });
  test('transposing the arguments flips a paired difference and leaves r alone', () => {
    const a = [1, 3, 5, 4];
    const b = [2, 2, 7, 1];
    close(pairedDiff(a, b).mean, -pairedDiff(b, a).mean);
    close(pearson(a, b), pearson(b, a));
    close(spearman(a, b), spearman(b, a));
  });
});
