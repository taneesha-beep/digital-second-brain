'use strict';

/**
 * v2-jaccard (Phase 3.1).
 *
 * SYMMETRY IS THE POINT OF THIS RUNG, so it is proved here rather than
 * asserted in prose — and v1 is put through the identical check so that
 * "symmetric by construction" is a measured difference between the two rungs
 * and not a property nobody looked for in the baseline.
 *
 * The second group is the one that makes the rung a ONE-VARIABLE change. v2
 * does not inherit v1's 0.15, because Jaccard silently redefines what that
 * number demands (2 shared words becomes 3). What v2 inherits instead is the
 * BEHAVIOUR, expressed as the length-independent integer the threshold was
 * always encoding — and "the admitted sets are identical wherever the rule is
 * expressible in both coordinate systems" is a checkable claim, so it is
 * checked.
 */

const parity = require('../scripts/parity-v1');
const retrieval = require('../retrieval');
const v2 = require('../retrieval/v2-jaccard');

const docs = parity.loadFixture();
const ALL = docs.length; // 34 — k large enough that nothing is truncated

/** Uncapped handles, so these tests see the ADMITTED set rather than a prefix. */
const v1Full = retrieval.index('v1-overlap', docs, { cap: null });
const v2Full = retrieval.index('v2-jaccard', docs, { cap: null });

/** docId -> Map(otherId -> hit), for every fixture document. */
function scoreTable(handle) {
  const table = new Map();
  for (const doc of docs) {
    const row = new Map();
    for (const hit of retrieval.search(handle, doc.id, ALL)) row.set(hit.docId, hit);
    table.set(doc.id, row);
  }
  return table;
}

const v1Table = scoreTable(v1Full);
const v2Table = scoreTable(v2Full);

const keywordCount = new Map(
  docs.map((doc) => [doc.id, v2Full._state.keywordsById.get(doc.id).length])
);

describe('v2 is symmetric by construction, and v1 is not', () => {
  test('score(A->B) equals score(B->A) at EXACT float equality, on every pair', () => {
    let compared = 0;
    for (const [a, row] of v2Table) {
      for (const [b, hit] of row) {
        const back = v2Table.get(b).get(a);
        // Symmetry has two halves and only checking the second is a common way
        // to miss a real asymmetry: B must be REACHABLE from A exactly when A
        // is reachable from B, and then the scores must agree.
        expect(back).toBeDefined();
        expect(hit.score).toBe(back.score); // toBe, not toBeCloseTo
        compared += 1;
      }
    }
    // The fixture must actually exercise this rather than passing vacuously.
    expect(compared).toBeGreaterThan(100);
  });

  test('the shared terms are the same SET both ways (order is target-order, not symmetric)', () => {
    for (const [a, row] of v2Table) {
      for (const [b, hit] of row) {
        const back = v2Table.get(b).get(a);
        expect([...hit.explain.sharedKeywords].sort()).toEqual(
          [...back.explain.sharedKeywords].sort()
        );
      }
    }
  });

  test('v1 FAILS the same check — the asymmetry it removes is real, not hypothetical', () => {
    const asymmetric = [];
    for (const [a, row] of v1Table) {
      for (const [b, hit] of row) {
        const back = v1Table.get(b).get(a);
        if (!back || back.score !== hit.score) asymmetric.push(`${a}->${b}`);
      }
    }
    // PRIMER.md §3.5: the denominator is the SOURCE's keyword count, so any
    // pair whose keyword lists differ in length scores differently each way.
    expect(asymmetric.length).toBeGreaterThan(0);
  });

  test('symmetry is a property of the formula, not of this fixture', () => {
    // Two documents whose keyword lists are deliberately different lengths.
    const pair = [
      { id: 'x', title: 'braising short ribs', body: 'braising short ribs wine stock oven' },
      { id: 'y', title: 'braising', body: 'braising wine' },
      { id: 'z', title: 'sharpening whetstone', body: 'sharpening whetstone angle bevel' }
    ];
    const handle = retrieval.index('v2-jaccard', pair, { cap: null, minShared: 1 });
    const xy = retrieval.search(handle, 'x', 3).find((h) => h.docId === 'y');
    const yx = retrieval.search(handle, 'y', 3).find((h) => h.docId === 'x');
    expect(xy).toBeDefined();
    expect(xy.score).toBe(yx.score);

    const v1Handle = retrieval.index('v1-overlap', pair, { cap: null, threshold: 0 });
    const v1xy = retrieval.search(v1Handle, 'x', 3).find((h) => h.docId === 'y');
    const v1yx = retrieval.search(v1Handle, 'y', 3).find((h) => h.docId === 'x');
    expect(v1xy.score).not.toBe(v1yx.score); // same pair, different both ways
  });
});

describe('the threshold is NOT inherited, and the arithmetic is why', () => {
  /**
   * Two ten-keyword documents sharing exactly s words. Built rather than found,
   * because the claim is about the formula and the fixture only has whatever
   * pairs it happens to have.
   */
  function pairSharing(s) {
    const shared = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett']
      .slice(0, s);
    const aOnly = ['kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
    const bOnly = ['uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', 'zebra', 'walrus', 'quokka', 'narwhal'];
    return [
      { id: 'a', title: '', body: [...shared, ...aOnly].slice(0, 10).join(' ') },
      { id: 'b', title: '', body: [...shared, ...bOnly].slice(0, 10).join(' ') }
    ];
  }

  test('the fixture generator really does produce ten keywords sharing s', () => {
    for (const s of [1, 2, 3]) {
      const handle = retrieval.index('v2-jaccard', pairSharing(s), { minShared: 1, cap: null });
      const kw = handle._state.keywordsById;
      expect(kw.get('a').length).toBe(10);
      expect(kw.get('b').length).toBe(10);
      expect(kw.get('a').filter((w) => kw.get('b').includes(w)).length).toBe(s);
    }
  });

  test('at 0.15, v1 admits 2 shared words and Jaccard demands 3', () => {
    const admits = (version, params, s) =>
      retrieval.search(retrieval.index(version, pairSharing(s), params), 'a', 10).length === 1;

    // v1, threshold 0.15: s/10 > 0.15 <=> s >= 2.
    expect(admits('v1-overlap', { cap: null }, 1)).toBe(false);
    expect(admits('v1-overlap', { cap: null }, 2)).toBe(true);

    // v2 at the SAME 0.15 with minShared inert: s/(20-s) > 0.15 <=> s >= 3.
    const naive = { cap: null, minShared: 1, threshold: 0.15 };
    expect(admits('v2-jaccard', naive, 2)).toBe(false);
    expect(admits('v2-jaccard', naive, 3)).toBe(true);

    // Which is why the numeral is not carried across.
    const held = { cap: null };
    expect(admits('v2-jaccard', held, 1)).toBe(false);
    expect(admits('v2-jaccard', held, 2)).toBe(true);
  });

  test('the exact scores are the ones the writeup quotes', () => {
    const score = (version, params, s) =>
      retrieval.search(retrieval.index(version, pairSharing(s), params), 'a', 10)[0].score;
    expect(score('v1-overlap', { cap: null, threshold: 0 }, 2)).toBe(0.2);
    expect(score('v2-jaccard', { cap: null, minShared: 1 }, 1)).toBe(0.0526); // 1/19
    expect(score('v2-jaccard', { cap: null, minShared: 1 }, 2)).toBe(0.1111); // 2/18
    expect(score('v2-jaccard', { cap: null, minShared: 1 }, 3)).toBe(0.1765); // 3/17
  });
});

describe('holding the behaviour constant — what it does and does not buy', () => {
  const admitted = (table, id) => new Set(table.get(id).keys());

  test('the fixture reaches both strata, so neither branch passes vacuously', () => {
    const short = docs.filter((d) => keywordCount.get(d.id) <= 6);
    const long = docs.filter((d) => keywordCount.get(d.id) >= 7);
    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
  });

  test('for queries with >= 7 keywords the admitted sets are IDENTICAL to v1', () => {
    // v1 at 0.15 needs s >= 2 for d >= 7, independent of the target's length;
    // v2 at minShared 2 needs s >= 2 for every length on both sides. So this is
    // exact rather than approximate — EVALUATION.md §14.2.
    for (const doc of docs) {
      if (keywordCount.get(doc.id) < 7) continue;
      expect([...admitted(v2Table, doc.id)].sort()).toEqual([...admitted(v1Table, doc.id)].sort());
    }
  });

  test('for queries with <= 6 keywords v2 is a strict subset — the residual, bounded', () => {
    // v1 links on a SINGLE shared word once d <= 6 (§7.7); v2 never does. The
    // divergence is one-directional, which is what makes it reportable as a
    // stratum rather than a confound.
    let sawDifference = false;
    for (const doc of docs) {
      if (keywordCount.get(doc.id) > 6) continue;
      const v1Set = admitted(v1Table, doc.id);
      const v2Set = admitted(v2Table, doc.id);
      for (const id of v2Set) expect(v1Set.has(id)).toBe(true);
      if (v2Set.size < v1Set.size) sawDifference = true;
      // and everything v1 has that v2 does not is exactly an s=1 link
      for (const id of v1Set) {
        if (!v2Set.has(id)) {
          expect(v1Table.get(doc.id).get(id).explain.sharedKeywords.length).toBe(1);
        }
      }
    }
    expect(sawDifference).toBe(true);
  });

  test('a scalar Jaccard threshold could NOT have done this', () => {
    // The reason minShared exists rather than a threshold in [1/19, 2/18): a
    // Jaccard threshold leaks the TARGET's length into the admission rule,
    // which v1's never did. Enumerated over every (a, b, s) with a, b <= 10.
    const r4 = (x) => Number(x.toFixed(4));
    let minSharedDiffers = 0;
    let scalarDiffers = 0;
    for (let a = 7; a <= 10; a += 1) {
      for (let b = 1; b <= 10; b += 1) {
        for (let s = 1; s <= Math.min(a, b); s += 1) {
          const v1Admit = r4(s / a) > 0.15;
          if ((s >= 2) !== v1Admit) minSharedDiffers += 1;
          if ((r4(s / (a + b - s)) > 0.1) !== v1Admit) scalarDiffers += 1;
        }
      }
    }
    expect(minSharedDiffers).toBe(0);
    expect(scalarDiffers).toBe(6);
  });
});

describe('the score lattice', () => {
  const r4 = (x) => Number(x.toFixed(4));

  test('v2 admits 64 distinct scores against v1\'s 32', () => {
    const v1Lattice = new Set();
    for (let d = 1; d <= 10; d += 1) for (let s = 1; s <= d; s += 1) v1Lattice.add(r4(s / d));

    const v2Lattice = new Set();
    for (let a = 1; a <= 10; a += 1) {
      for (let b = 1; b <= 10; b += 1) {
        for (let s = 1; s <= Math.min(a, b); s += 1) v2Lattice.add(r4(s / (a + b - s)));
      }
    }
    expect(v1Lattice.size).toBe(32);
    expect(v2Lattice.size).toBe(64);
    expect(Math.min(...v2Lattice)).toBe(0.0526); // 1/19, the floor
  });

  test('derived from the algebra, then checked against what the retriever emits', () => {
    // §13.2 did exactly this for v1 and it is the step that turns a derivation
    // into a fact about the code.
    const lattice = new Set();
    for (let a = 1; a <= 10; a += 1) {
      for (let b = 1; b <= 10; b += 1) {
        for (let s = 1; s <= Math.min(a, b); s += 1) lattice.add(r4(s / (a + b - s)));
      }
    }
    const emitted = new Set();
    for (const row of v2Table.values()) for (const hit of row.values()) emitted.add(hit.score);
    expect(emitted.size).toBeGreaterThan(0);
    for (const score of emitted) expect(lattice.has(score)).toBe(true);
  });
});

describe('v2 params', () => {
  test('the inherited keyword stage is v1\'s, so both rungs index identical lists', () => {
    // Not a claim about the source text: the same buildIndex is called.
    for (const doc of docs) {
      expect(v2Full._state.keywordsById.get(doc.id)).toEqual(v1Full._state.keywordsById.get(doc.id));
    }
  });

  test('minShared must be a positive integer', () => {
    expect(() => retrieval.index('v2-jaccard', docs, { minShared: 0 })).toThrow(/minShared/);
    expect(() => retrieval.index('v2-jaccard', docs, { minShared: 1.5 })).toThrow(/minShared/);
    expect(() => retrieval.index('v2-jaccard', docs, { minShared: '2' })).toThrow(/minShared/);
  });

  test('the defaults are the ones the run file will record', () => {
    expect(retrieval.describe(retrieval.index('v2-jaccard', docs)).params).toEqual({
      idfCorpus: 'leave-one-out',
      topN: 10,
      lengthBonus: true,
      scorePrecision: 4,
      cap: 8,
      threshold: 0,
      minShared: 2
    });
  });

  test('threshold 0 is inert, and that is measured rather than asserted', () => {
    // With minShared 2 the smallest achievable score is 2/18 = 0.1111 (s = 2
    // against the largest possible union, 10 + 10 - 2). So every threshold in
    // [0, 0.1111) admits exactly what minShared admits, and 0 is one of them.
    let lowest = Infinity;
    for (const row of v2Table.values()) {
      for (const hit of row.values()) lowest = Math.min(lowest, hit.score);
    }
    expect(lowest).toBeGreaterThanOrEqual(0.1111);

    const raised = retrieval.index('v2-jaccard', docs, { cap: null, threshold: 0.1 });
    for (const doc of docs) {
      expect(retrieval.search(raised, doc.id, ALL)).toEqual(retrieval.search(v2Full, doc.id, ALL));
    }
  });
});
