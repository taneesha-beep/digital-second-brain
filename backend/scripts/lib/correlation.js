'use strict';

/**
 * correlation.js — Phase 5.7. The statistics the retriever comparison rests on.
 *
 * PURE. No I/O, no network, no key, no data/. Everything here is a function of
 * its arguments.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PINNED AGAINST HAND-COMPUTED EXAMPLES, WHICH IS §33.7's ARGUMENT
 * ---------------------------------------------------------------------------
 *
 * §33.7 makes the case for Cohen's kappa and it applies here word for word: a
 * conformance rate computed wrongly usually LOOKS wrong, and a correlation
 * computed wrongly looks exactly like a correlation — one number in [-1, 1]
 * with no external referent. The common wrong implementations all produce
 * plausible values:
 *
 *   - dividing by n instead of n-1 in the sd (shrinks nothing, r is invariant,
 *     but the SAME slip in a t statistic inflates it by sqrt(n/(n-1)))
 *   - Spearman via the 6*sum(d^2) shortcut, which is WRONG under ties, and
 *     this data is full of ties: 17 of 30 seeds share nDCG@8 = 0
 *   - a paired t computed on the two means rather than on the differences
 *   - Fisher's z back-transformed without the 1/sqrt(n-3) scale
 *
 * So every function below has a worked example computed by hand in
 * tests/correlation.test.js, and the tie-handling has its own.
 *
 * ---------------------------------------------------------------------------
 * SPEARMAN USES AVERAGE RANKS AND THAT IS NOT A DETAIL HERE
 * ---------------------------------------------------------------------------
 *
 * The 6*sum(d^2)/(n(n^2-1)) form every reference prints assumes NO TIES. On the
 * 30 golden seeds the qrels are sparse — median 1 relevant document — so
 * between 11 and 22 seeds score exactly 0 depending on the rung, and a tie
 * group of 22 is most of the sample. The shortcut would report a confidently
 * wrong number on the phase's headline statistic. Spearman here is Pearson on
 * average ranks, which is the definition the shortcut is a special case of.
 */

/** Sample mean. Throws on empty rather than returning NaN quietly. */
function mean(xs) {
  if (!xs.length) throw new Error('mean of an empty sample');
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation, n-1. Undefined for n < 2 and says so. */
function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Average ranks, 1-based, ties sharing the mean of the ranks they span.
 * [10, 20, 20, 30] -> [1, 2.5, 2.5, 4].
 */
function averageRanks(xs) {
  const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k][1]] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * Pearson's r. Returns null when either sample is constant — the correlation
 * is UNDEFINED there (0/0), not 0, and returning 0 would assert independence
 * where there is no information. Same shape as cohensKappa's undefined case.
 */
function pearson(xs, ys) {
  if (xs.length !== ys.length) throw new Error(`pearson: length mismatch ${xs.length} vs ${ys.length}`);
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Spearman's rho = Pearson on average ranks. Correct under ties by construction. */
function spearman(xs, ys) {
  if (xs.length !== ys.length) throw new Error(`spearman: length mismatch ${xs.length} vs ${ys.length}`);
  if (xs.length < 2) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/**
 * Fisher z confidence interval for Pearson's r.
 *
 * The interval is computed in z space and transformed BACK, which is why it is
 * asymmetric around r — transforming a symmetric interval around r instead is
 * the common wrong version and it overhangs +/-1 for large |r|.
 *
 * Needs n >= 4: the standard error is 1/sqrt(n-3).
 */
function fisherCI(r, n, z = 1.96) {
  if (r === null || n < 4 || Math.abs(r) >= 1) return null;
  const zr = Math.atanh(r);
  const se = 1 / Math.sqrt(n - 3);
  return { lo: Math.tanh(zr - z * se), hi: Math.tanh(zr + z * se), se };
}

/** The |r| a sample of size n can distinguish from zero at this z. */
function detectableR(n, z = 1.96) {
  if (n < 4) return null;
  return Math.tanh(z / Math.sqrt(n - 3));
}

/**
 * Paired difference summary: mean, sd, t, and the count each way.
 *
 * t IS COMPUTED ON THE DIFFERENCES, not on the two means. The two-sample form
 * applied to paired data throws away the pairing, which is the entire reason
 * the seeds are shared between arms — it would inflate the standard error by
 * whatever the between-arm correlation is worth.
 */
function pairedDiff(a, b) {
  if (a.length !== b.length) throw new Error(`pairedDiff: length mismatch ${a.length} vs ${b.length}`);
  const d = a.map((v, i) => v - b[i]);
  const s = sd(d);
  return {
    n: d.length,
    mean: d.length ? mean(d) : null,
    sd: s,
    t: s && s > 0 ? mean(d) / (s / Math.sqrt(d.length)) : null,
    positive: d.filter((v) => v > 0).length,
    negative: d.filter((v) => v < 0).length,
    zero: d.filter((v) => v === 0).length
  };
}

/**
 * One-way ANOVA intraclass correlation, and the design effect it implies.
 *
 * WHY THIS IS HERE AT ALL. Items are nested in calls — ~14 items come from one
 * generation call over one cluster — so 322 items are not 322 independent
 * observations. Quoting an item-level standard error as if they were is the
 * shape of error that makes an underpowered comparison look powered, and 5.7
 * declares its power in advance, so the correction has to be measured rather
 * than waved at.
 *
 * `groups` is an array of arrays. Returns null when there is one group or one
 * item per group, because the statistic is undefined there.
 */
function icc(groups) {
  const usable = groups.filter((g) => g.length > 0);
  const k = usable.length;
  const all = [].concat(...usable);
  const N = all.length;
  if (k < 2 || N <= k) return null;
  const gm = mean(all);
  const msb = usable.reduce((a, g) => a + g.length * (mean(g) - gm) ** 2, 0) / (k - 1);
  const msw = usable.reduce((a, g) => a + g.reduce((x, y) => x + (y - mean(g)) ** 2, 0), 0) / (N - k);
  const m = N / k;
  if (msb + (m - 1) * msw === 0) return null;
  const r = (msb - msw) / (msb + (m - 1) * msw);
  // A NEGATIVE ICC is a real result of this estimator (within-group spread
  // exceeding between-group spread) and is reported as measured. It is FLOORED
  // AT ZERO only where it feeds the design effect, because a design effect
  // below 1 would claim clustering BOUGHT precision, which this correction is
  // not entitled to assume.
  return { icc: r, groups: k, n: N, itemsPerGroup: m, designEffect: 1 + (m - 1) * Math.max(0, r) };
}

/**
 * Minimum detectable effect for a two-sample comparison of means.
 *
 * Two-sided alpha .05 and 80% power is (1.96 + 0.8416) = 2.8016 standard
 * errors. `designEffect` inflates the variance for clustering; pass 1 for
 * genuinely independent observations.
 *
 * THE POINT OF PRINTING THIS IS THE NULL RESULT. A difference smaller than the
 * MDE is not evidence of no difference, and 5.7 predicts two such nulls in
 * advance precisely so neither can be written up as a finding afterwards.
 */
function mde(sdValue, nPerArm, designEffect = 1, z = 2.8016) {
  if (!sdValue || nPerArm < 2) return null;
  return z * sdValue * Math.sqrt((2 * designEffect) / nPerArm);
}

module.exports = {
  mean, sd, averageRanks, pearson, spearman, fisherCI, detectableR, pairedDiff, icc, mde
};
