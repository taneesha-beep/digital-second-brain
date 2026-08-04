'use strict';

/**
 * metrics.test.js — Phase 2.3
 *
 * Hand-worked examples with known answers.
 *
 * WHAT THIS CAN AND CANNOT ESTABLISH, stated up front because the difference
 * matters more than the tests do. Everything here shows the implementation
 * matches *a reading* of the definitions. Where nDCG has published variants
 * that genuinely disagree — the gain formula (2^g-1 versus linear g) and the
 * treatment of queries with no relevant documents — a hand-worked example
 * proves nothing, because the same misreading would produce both the example
 * and the code. Roadmap 2.4 is what closes that, by diffing against pytrec_eval
 * to 1e-6. Until it passes, no number from this file may be quoted.
 *
 * So the examples below are chosen to be the kind a misreading cannot survive.
 * Three sources, in ascending order of what they catch:
 *
 *   A. docs/PRIMER.md 5.2's worked nDCG example, transcribed with its own
 *      intermediate terms, so a failure names which stage broke rather than
 *      only that the total is wrong.
 *   B. Cases where the answer is forced by the definition rather than by
 *      arithmetic — a perfect ranking is exactly 1.0 whatever the grades are,
 *      a single grade-1 hit at rank r is exactly 1/log2(r+1). Arithmetic slips
 *      cannot hide behind these.
 *   C. The cases PRIMER's single example does not reach: ties, zero relevant,
 *      fewer results than k, grade 2 against grade 1, more judgments than k.
 */

const {
  gain,
  discount,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  dcgAtK,
  idcgAtK,
  ndcgAtK,
  scoreQuery,
  aggregate
} = require('../eval/metrics');

const close = (actual, expected, tolerance = 1e-9) => {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
};

// ---------------------------------------------------------------------------
// A. docs/PRIMER.md 5.2, transcribed
// ---------------------------------------------------------------------------

describe('PRIMER.md 5.2 worked example', () => {
  // Key: doc A grade 2, doc B grade 1. Returned: [X, A, Y, Z, B, W, V, U].
  const ranked = ['X', 'A', 'Y', 'Z', 'B', 'W', 'V', 'U'];
  const judgments = { A: 2, B: 1 };

  test('the gain formula gives 3 for grade 2 and 1 for grade 1', () => {
    expect(gain(2)).toBe(3);
    expect(gain(1)).toBe(1);
    expect(gain(0)).toBe(0);
  });

  test('each contributing term matches the document', () => {
    // A at rank 2: 3 / log2(3) = 1.893
    close(gain(2) * discount(2), 1.893, 5e-4);
    // B at rank 5: 1 / log2(6) = 0.387
    close(gain(1) * discount(5), 0.387, 5e-4);
  });

  test('DCG@8 = 2.280', () => {
    close(dcgAtK(ranked, judgments, 8), 2.28, 5e-3);
  });

  test('IDCG@8 = 3.631, from A at rank 1 and B at rank 2', () => {
    close(gain(2) * discount(1), 3.0, 1e-12);
    close(gain(1) * discount(2), 0.631, 5e-4);
    close(idcgAtK(judgments, 8), 3.631, 5e-4);
  });

  test('nDCG@8 = 0.628', () => {
    close(ndcgAtK(ranked, judgments, 8), 0.628, 5e-4);
  });

  test('P@8 = 0.25 and R@8 = 1.0, as PRIMER 5.1 works them', () => {
    close(precisionAtK(ranked, judgments, 8), 0.25);
    close(recallAtK(ranked, judgments, 8), 1.0);
  });

  test('MRR = 1/2, the first correct hit being A at rank 2', () => {
    close(reciprocalRank(ranked, judgments), 0.5);
  });
});

// ---------------------------------------------------------------------------
// B. Answers forced by the definition
// ---------------------------------------------------------------------------

describe('cases where the definition forces the answer', () => {
  test('a perfect ranking is exactly 1.0, for any mix of grades', () => {
    // Not approximately: DCG and IDCG are summed in the same order over the
    // same terms, so the quotient is exact. A wrong IDCG breaks this.
    expect(ndcgAtK(['A', 'B', 'C'], { A: 2, B: 2, C: 1 }, 8)).toBe(1);
    expect(ndcgAtK(['A', 'B'], { A: 1, B: 1 }, 8)).toBe(1);
    expect(ndcgAtK(['A'], { A: 2 }, 1)).toBe(1);
    expect(ndcgAtK(['A', 'B', 'C', 'D'], { A: 2, B: 1, C: 1, D: 1 }, 4)).toBe(1);
  });

  test('one grade-1 hit at rank r gives nDCG = 1/log2(r+1) and MRR = 1/r', () => {
    // Ten independent checks of the discount. This is where the classic
    // off-by-one lives: log2(rank) instead of log2(rank+1) divides by zero at
    // rank 1 and returns 1.0 instead of 0.6309 at rank 2.
    for (let r = 1; r <= 10; r += 1) {
      const ranked = [];
      for (let i = 1; i <= 10; i += 1) ranked.push(i === r ? 'HIT' : `miss${i}`);
      close(ndcgAtK(ranked, { HIT: 1 }, 10), 1 / Math.log2(r + 1));
      close(reciprocalRank(ranked, { HIT: 1 }), 1 / r);
    }
  });

  test('reversing a two-document ranking strictly lowers nDCG', () => {
    const judgments = { A: 2, B: 1 };
    const best = ndcgAtK(['A', 'B'], judgments, 8);
    const worse = ndcgAtK(['B', 'A'], judgments, 8);
    expect(best).toBe(1);
    expect(worse).toBeLessThan(best);
    // And by a known amount: DCG = 1 + 3/log2(3) = 2.8928, IDCG = 3.6309.
    close(worse, (1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3)), 1e-12);
  });

  test('inserting irrelevant documents ahead of a hit lowers nDCG monotonically', () => {
    let previous = Infinity;
    for (let pad = 0; pad < 6; pad += 1) {
      const ranked = [];
      for (let i = 0; i < pad; i += 1) ranked.push(`pad${i}`);
      ranked.push('HIT');
      const value = ndcgAtK(ranked, { HIT: 2 }, 8);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });
});

// ---------------------------------------------------------------------------
// C1. Grade 2 against grade 1
// ---------------------------------------------------------------------------

describe('grade 2 and grade 1 are weighted differently', () => {
  test('putting the grade-1 document first costs a computed amount', () => {
    const judgments = { DUP: 2, LINK: 1 };
    const idcg = 3 / Math.log2(2) + 1 / Math.log2(3); // 3.63093
    const good = 3 / Math.log2(2) + 1 / Math.log2(3); // DUP first
    const bad = 1 / Math.log2(2) + 3 / Math.log2(3); // LINK first

    close(ndcgAtK(['DUP', 'LINK'], judgments, 8), good / idcg, 1e-12);
    close(ndcgAtK(['LINK', 'DUP'], judgments, 8), bad / idcg, 1e-12);
    // Not merely lower: lower by exactly this, which a linear gain would miss.
    close(good / idcg - bad / idcg, (good - bad) / idcg, 1e-12);
    close(good - bad, 2 - 2 / Math.log2(3), 1e-12);
  });

  test('IDCG sorts grades descending, not by insertion order', () => {
    // Inserted worst-first. If IDCG followed insertion order it would compute
    // 1/1 + 3/log2(3) = 2.8928 instead of 3.6309.
    close(idcgAtK({ LINK: 1, DUP: 2 }, 8), 3 + 1 / Math.log2(3), 1e-12);
  });

  test('a linear gain would give a different answer, so the choice is visible', () => {
    // Guards the convention rather than the arithmetic: if gain() were ever
    // changed to linear g, this is the test that says so out loud.
    const judgments = { DUP: 2, LINK: 1 };
    const exponential = ndcgAtK(['LINK', 'DUP'], judgments, 8);
    const linear = (1 / Math.log2(2) + 2 / Math.log2(3)) / (2 / Math.log2(2) + 1 / Math.log2(3));
    expect(Math.abs(exponential - linear)).toBeGreaterThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// C2. Fewer results than k — the case v1's cap creates on ~96% of dev queries
// ---------------------------------------------------------------------------

describe('fewer results than k', () => {
  const judgments = { A: 2, B: 1, C: 1 };

  test('DCG truncates at what was returned, IDCG at k', () => {
    const short = ['A', 'B'];
    // DCG@10 of a two-item list equals its DCG@2 — there is nothing at ranks 3-10.
    close(dcgAtK(short, judgments, 10), dcgAtK(short, judgments, 2), 1e-12);
    // IDCG@10 does NOT equal IDCG@2: the ideal ranking has three judged
    // documents and room for all of them.
    expect(idcgAtK(judgments, 10)).toBeGreaterThan(idcgAtK(judgments, 2));
  });

  test('so the same short list scores lower at a larger k', () => {
    const short = ['A', 'B'];
    expect(ndcgAtK(short, judgments, 10)).toBeLessThan(ndcgAtK(short, judgments, 2));
  });

  test('a list of 8 scored at 10 is exactly the cap case, and is not 1.0', () => {
    // v1-overlap returns at most 8. A query with 9 judged documents therefore
    // cannot reach nDCG@10 = 1 however well it ranks, and that ceiling is the
    // measured artifact this session had to decide about rather than absorb.
    const eightPerfect = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
    const nineJudged = {};
    for (const id of eightPerfect) nineJudged[id] = 1;
    nineJudged.d9 = 1;

    expect(ndcgAtK(eightPerfect, nineJudged, 8)).toBe(1);
    expect(ndcgAtK(eightPerfect, nineJudged, 10)).toBeLessThan(1);
    // The exact ceiling: the ninth ideal slot is unreachable.
    const idcg10 = idcgAtK(nineJudged, 10);
    close(ndcgAtK(eightPerfect, nineJudged, 10), (idcg10 - 1 / Math.log2(10)) / idcg10, 1e-12);
  });

  test('precision divides by k, not by the number returned', () => {
    // Returning two results and getting both right is not P@8 = 1.0. Dividing
    // by the number returned would reward returning less.
    close(precisionAtK(['A', 'B'], judgments, 8), 2 / 8);
    close(precisionAtK(['A', 'B'], judgments, 2), 1.0);
  });
});

// ---------------------------------------------------------------------------
// C3. More judgments than k
// ---------------------------------------------------------------------------

describe('more judged documents than k', () => {
  test('IDCG@8 uses the best 8 grades, not all 12', () => {
    const judgments = {};
    for (let i = 1; i <= 12; i += 1) judgments[`d${i}`] = i <= 4 ? 2 : 1;

    // Best 8: four at grade 2, then four at grade 1.
    let expected = 0;
    for (let i = 1; i <= 8; i += 1) {
      expected += (i <= 4 ? 3 : 1) / Math.log2(i + 1);
    }
    close(idcgAtK(judgments, 8), expected, 1e-12);
    // Summing all 12 would inflate the denominator and deflate every nDCG on
    // hub queries — this corpus has hubs at 245, 209 and 103 judgments.
    expect(idcgAtK(judgments, 12)).toBeGreaterThan(idcgAtK(judgments, 8));
  });

  test('recall at k below the judgment count cannot reach 1', () => {
    const judgments = {};
    for (let i = 1; i <= 12; i += 1) judgments[`d${i}`] = 1;
    const ranked = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
    close(recallAtK(ranked, judgments, 8), 8 / 12);
    expect(recallAtK(ranked, judgments, 8)).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// C4. Zero relevant, zero returned, zero judgeable
// ---------------------------------------------------------------------------

describe('the zero cases, which are three different things', () => {
  test('nothing relevant retrieved: 0 everywhere, no NaN', () => {
    const ranked = ['x', 'y', 'z'];
    const judgments = { A: 2 };
    expect(precisionAtK(ranked, judgments, 8)).toBe(0);
    expect(recallAtK(ranked, judgments, 8)).toBe(0);
    expect(reciprocalRank(ranked, judgments)).toBe(0);
    expect(dcgAtK(ranked, judgments, 8)).toBe(0);
    expect(ndcgAtK(ranked, judgments, 8)).toBe(0);
    expect(Number.isNaN(ndcgAtK(ranked, judgments, 8))).toBe(false);
  });

  test('nothing returned at all: still 0, still not NaN', () => {
    // The retriever's threshold produced no candidates. This is a retrieval
    // failure and scores 0; it is not the same as having nothing to find.
    const judgments = { A: 2 };
    expect(precisionAtK([], judgments, 8)).toBe(0);
    expect(recallAtK([], judgments, 8)).toBe(0);
    expect(reciprocalRank([], judgments)).toBe(0);
    expect(ndcgAtK([], judgments, 8)).toBe(0);
  });

  test('nothing judgeable: null, not 0, because 0/0 is not 0', () => {
    const ranked = ['x', 'y'];
    expect(idcgAtK({}, 8)).toBe(0);
    expect(ndcgAtK(ranked, {}, 8)).toBeNull();
    expect(recallAtK(ranked, {}, 8)).toBeNull();
    // Precision has a real denominator (k) and so is still defined.
    expect(precisionAtK(ranked, {}, 8)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C5. Ties — a property of the caller's ordering, not of the metric
// ---------------------------------------------------------------------------

describe('ties', () => {
  test('the metric is a pure function of the order it is handed', () => {
    // Two documents at an identical retriever score, one relevant. Whichever
    // order the caller produced is what gets scored — the metric has no access
    // to the scores and cannot break the tie itself.
    const judgments = { REL: 1 };
    close(ndcgAtK(['REL', 'OTHER'], judgments, 8), 1);
    close(ndcgAtK(['OTHER', 'REL'], judgments, 8), 1 / Math.log2(3));
    // Fixing that order is retrieval/index.js's job: descending score, then
    // lexicographic on the id. Asserting tie-independence here would claim a
    // guarantee this file cannot make.
  });

  test('permuting equally graded documents does not change nDCG', () => {
    // What IS tie-independent: the ideal ranking. Three documents at the same
    // grade are interchangeable in the denominator.
    const judgments = { A: 1, B: 1, C: 1 };
    const value = ndcgAtK(['A', 'B', 'C'], judgments, 8);
    close(ndcgAtK(['C', 'A', 'B'], judgments, 8), value, 1e-12);
    close(ndcgAtK(['B', 'C', 'A'], judgments, 8), value, 1e-12);
    expect(value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C6. Aggregation across queries — the two populations
// ---------------------------------------------------------------------------

describe('aggregation', () => {
  const ks = [1, 5, 8, 10];

  test('a zero-result query is scored 0 and counted in the mean', () => {
    const good = scoreQuery(['A'], { A: 1 }, ks);
    const empty = scoreQuery([], { B: 1 }, ks);
    const agg = aggregate([good, empty], ks);

    expect(agg.queries).toBe(2);
    expect(agg.scored).toBe(2);
    expect(agg.zeroResult).toBe(1);
    // Mean of 1.0 and 0.0 over two queries. Dropping the failure would report
    // 1.0 and inflate the result by exactly the failure rate.
    close(agg.ndcg[8], 0.5);
    close(agg.mrr, 0.5);
  });

  test('an unjudgeable query is excluded from every column, and counted', () => {
    const good = scoreQuery(['A'], { A: 1 }, ks);
    const unjudgeable = scoreQuery(['x', 'y'], {}, ks);
    const agg = aggregate([good, unjudgeable], ks);

    expect(agg.queries).toBe(2);
    expect(agg.scored).toBe(1);
    expect(agg.unjudgeable).toBe(1);
    // Every column over the same population of 1, not nDCG over 1 and P over 2.
    close(agg.ndcg[8], 1.0);
    close(agg.mrr, 1.0);
    close(agg.p[1], 1.0);
    close(agg.r[8], 1.0);
  });

  test('every column uses one denominator', () => {
    // The failure this guards: metrics returning null exclude a query while
    // metrics returning 0 include it, so a single printed row silently mixes
    // populations. Constructed so an unjudgeable query would drag P down if it
    // leaked in.
    const queries = [
      scoreQuery(['A'], { A: 1 }, ks),
      scoreQuery(['B'], { B: 1 }, ks),
      scoreQuery(['x'], {}, ks)
    ];
    const agg = aggregate(queries, ks);
    expect(agg.scored).toBe(2);
    close(agg.p[1], 1.0); // 2/2, not 2/3
    close(agg.ndcg[1], 1.0);
    close(agg.r[1], 1.0);
    close(agg.mrr, 1.0);
  });

  test('scoreQuery reports what the aggregator needs to tell them apart', () => {
    expect(scoreQuery([], { A: 1 }, ks)).toMatchObject({ judged: 1, retrieved: 0 });
    expect(scoreQuery(['x'], {}, ks)).toMatchObject({ judged: 0, retrieved: 1 });
  });

  test('accepts a Map as well as a plain object', () => {
    // The runner builds qrels as a Map of Maps; the worked examples above are
    // objects. Both paths have to agree or the tests test a path nothing uses.
    const asMap = new Map([['A', 2], ['B', 1]]);
    const ranked = ['X', 'A', 'Y', 'Z', 'B', 'W', 'V', 'U'];
    close(ndcgAtK(ranked, asMap, 8), 0.628, 5e-4);
    close(ndcgAtK(ranked, { A: 2, B: 1 }, 8), ndcgAtK(ranked, asMap, 8), 1e-12);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('k validation', () => {
  test('k must be a positive integer', () => {
    for (const bad of [0, -1, 1.5, '8', null, undefined, NaN]) {
      expect(() => precisionAtK(['A'], { A: 1 }, bad)).toThrow(TypeError);
      expect(() => idcgAtK({ A: 1 }, bad)).toThrow(TypeError);
    }
  });
});
