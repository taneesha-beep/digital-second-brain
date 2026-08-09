'use strict';

/**
 * v6-hybrid — RRF over BM25 and dense (Phase 3.5).
 *
 * THE TWO TESTS THAT CARRY THE RUNG, and everything else is support:
 *
 *   1. THE COMPONENT RANKS ARE THE COMPONENTS' OWN RANKS. v6 orders two lists
 *      internally before it can score anything. If it ordered them by any
 *      comparator other than the one index.js applies, it would be fusing
 *      rankings that no standalone run produces and the rung would be a fusion
 *      of two things that exist nowhere else in this repo. Asserted against
 *      real standalone search() calls, not against a reimplementation.
 *
 *   2. RRF OVER ONE LIST IS THAT LIST. This is the premise §17.5's successor
 *      argument rests on — it is WHY v6 gets no chain, because the chain's
 *      intermediate objects turn out to be v4 and v5 themselves. A premise
 *      argued in a header and never run is exactly the kind of claim CLAUDE.md
 *      says needs a file behind it.
 *
 * Vectors are the deterministic synthetic ones from tests/helpers — the suite
 * must run on a clean clone without an 86 MiB model. §17.4's reasoning,
 * unchanged.
 */

const parity = require('../scripts/parity-v1');
const retrieval = require('../retrieval');
const v6 = require('../retrieval/v6-hybrid');
const { retrieverSource } = require('../eval/source-digest');
const { withVectors } = require('./helpers/fixture-vectors');

const docs = withVectors(parity.loadFixture());
const ALL = docs.length;

const handleFor = (params = {}) => retrieval.index('v6-hybrid', docs, params);
const idsOf = (hits) => hits.map((h) => h.docId);

describe('what v6 is', () => {
  test('it resolves eleven params: three of its own, v4s five, v5s three', () => {
    const params = retrieval.resolvedParamsFor('v6-hybrid');
    expect(params).toEqual({
      rrfK: 60,
      fusion: 'rrf',
      depth: null,
      k1: 1.2,
      b: 0.75,
      idfVariant: 'lucene',
      qtfMode: 'linear',
      titleWeight: 2,
      vectors: 'minilm-l6-v2-fp32-256',
      dim: 384,
      normalise: true
    });
  });

  test('the component defaults are v4s and v5s exactly, not a copy that can drift', () => {
    const hybrid = retrieval.resolvedParamsFor('v6-hybrid');
    for (const key of v6.BM25_PARAM_KEYS) {
      expect(hybrid[key]).toEqual(retrieval.resolvedParamsFor('v4-bm25')[key]);
    }
    for (const key of v6.DENSE_PARAM_KEYS) {
      expect(hybrid[key]).toEqual(retrieval.resolvedParamsFor('v5-embeddings')[key]);
    }
  });

  test('`vectors` stays TOP-LEVEL, which is what lets run-eval.js attach them unchanged', () => {
    // run-eval.js:537 fires on `resolved.vectors !== undefined`. Nesting the
    // dense params would have needed the runner to learn about nesting — a
    // second place that knows the shape of params.
    expect(retrieval.resolvedParamsFor('v6-hybrid').vectors).toBe('minilm-l6-v2-fp32-256');
  });

  test('the two component key sets are disjoint, so flattening is lossless', () => {
    const overlap = v6.BM25_PARAM_KEYS.filter((k) => v6.DENSE_PARAM_KEYS.includes(k));
    expect(overlap).toEqual([]);
  });

  test('the source digest names BOTH components as dependencies', () => {
    // The property 3.2 built source-digest.js for: an edit to either component
    // moves v6's numbers with no change to its param digest.
    const files = retrieverSource('v6-hybrid').files.map((f) => f.path.split('/').pop()).sort();
    expect(files).toEqual([
      'index.js', 'types.js', 'v1-overlap.js', 'v4-bm25.js', 'v5-embeddings.js', 'v6-hybrid.js'
    ]);
    // Six files where v5's is three and v4's is four. v1-overlap.js is reached
    // THROUGH v4, for tokenise() — v6 imports it no more directly than v5 does.
    expect(retrieverSource('v5-embeddings').files).toHaveLength(3);
    expect(retrieverSource('v4-bm25').files).toHaveLength(4);
  });

  test('no `explain`, keeping the ladder at three shapes', () => {
    for (const hit of retrieval.search(handleFor(), docs[0].id, 8)) {
      expect(hit.explain).toBeUndefined();
    }
  });
});

describe('the component rankings are the components own', () => {
  // Rebuild the internal lists the way rank() does, then compare them to what a
  // standalone handle returns. This is test 1 of the two the rung rests on.
  function componentTop(version, subKeys, queryId, k) {
    const params = retrieval.resolvedParamsFor('v6-hybrid');
    const module_ = require(`../retrieval/${version}`);
    const state = module_.buildIndex(docs, v6.subParams(params, subKeys));
    const into = [];
    module_.rank(state, docs.find((d) => d.id === queryId), v6.componentCtx(into, queryId, k));
    into.sort(require('../retrieval/types').compareHits);
    return into.slice(0, k).map((h) => h.docId);
  }

  test.each(['v4-bm25', 'v5-embeddings'])('%s ranks identically inside v6 and standalone', (version) => {
    const keys = version === 'v4-bm25' ? v6.BM25_PARAM_KEYS : v6.DENSE_PARAM_KEYS;
    const standalone = retrieval.index(version, docs);
    let compared = 0;
    for (const doc of docs) {
      const inside = componentTop(version, keys, doc.id, ALL);
      const outside = idsOf(retrieval.search(standalone, doc.id, ALL));
      expect(inside).toEqual(outside);
      compared += 1;
    }
    expect(compared).toBe(ALL);
  });
});

describe('RRF over one list is that list — the premise the no-chain decision rests on', () => {
  // Test 2 of the two. 1/(rrfK + rank) is strictly decreasing in rank and ranks
  // within one list are distinct, so the induced order IS the rank order.
  function fuseOneComponent(version, subKeys, rrfK) {
    const params = { ...retrieval.resolvedParamsFor('v6-hybrid'), rrfK };
    const module_ = require(`../retrieval/${version}`);
    const state = module_.buildIndex(docs, v6.subParams(params, subKeys));
    return (queryId) => {
      const into = [];
      module_.rank(state, docs.find((d) => d.id === queryId), v6.componentCtx(into, queryId, ALL));
      into.sort(require('../retrieval/types').compareHits);
      // The fused score for a single component, then re-sorted the way index.js
      // would. If the identity holds, re-sorting changes nothing.
      const fused = into.map((h, i) => ({ docId: h.docId, score: 1 / (rrfK + i + 1) }));
      fused.sort(require('../retrieval/types').compareHits);
      return fused.map((h) => h.docId);
    };
  }

  test.each([0, 1, 60, 1000])('at rrfK=%i, single-component RRF reproduces v4 and v5 exactly', (rrfK) => {
    for (const [version, keys] of [['v4-bm25', v6.BM25_PARAM_KEYS], ['v5-embeddings', v6.DENSE_PARAM_KEYS]]) {
      const fuse = fuseOneComponent(version, keys, rrfK);
      const standalone = retrieval.index(version, docs);
      for (const doc of docs) {
        expect(fuse(doc.id)).toEqual(idsOf(retrieval.search(standalone, doc.id, ALL)));
      }
    }
  });
});

describe('the fusion arithmetic', () => {
  test('a document in both lists scores the sum of its two reciprocals', () => {
    const rrfK = retrieval.resolvedParamsFor('v6-hybrid').rrfK;
    const queryId = docs[0].id;

    const bm25 = idsOf(retrieval.search(retrieval.index('v4-bm25', docs), queryId, ALL));
    const dense = idsOf(retrieval.search(retrieval.index('v5-embeddings', docs), queryId, ALL));
    const hits = retrieval.search(handleFor(), queryId, ALL);

    let checkedInBoth = 0;
    for (const hit of hits) {
      const bi = bm25.indexOf(hit.docId);
      const di = dense.indexOf(hit.docId);
      const expected =
        (bi === -1 ? 0 : 1 / (rrfK + bi + 1)) + (di === -1 ? 0 : 1 / (rrfK + di + 1));
      expect(hit.score).toBeCloseTo(expected, 15);
      if (bi !== -1 && di !== -1) checkedInBoth += 1;
    }
    // The interesting case has to actually occur, or this test passes vacuously.
    expect(checkedInBoth).toBeGreaterThan(0);
  });

  test('ranks are 1-BASED, so rrfK=0 does not divide by zero', () => {
    const hits = retrieval.search(handleFor({ rrfK: 0 }), docs[0].id, 8);
    for (const hit of hits) expect(Number.isFinite(hit.score)).toBe(true);
    // The dense component reaches every document, so nothing is ever empty.
    expect(hits).toHaveLength(8);
  });

  test('a document BM25 cannot reach still ranks, on its dense contribution alone', () => {
    // The mechanism the rung exists for, in its smallest form: BM25 reaches only
    // documents sharing a term, and RRF lets the other component carry the rest.
    const queryId = docs[0].id;
    const bm25 = new Set(idsOf(retrieval.search(retrieval.index('v4-bm25', docs), queryId, ALL)));
    const fused = idsOf(retrieval.search(handleFor(), queryId, ALL));
    expect(fused.some((id) => !bm25.has(id))).toBe(true);
  });
});

describe('depth', () => {
  test('null fuses every candidate; the fused list is the union of the two pools', () => {
    const queryId = docs[0].id;
    const bm25 = idsOf(retrieval.search(retrieval.index('v4-bm25', docs), queryId, ALL));
    const dense = idsOf(retrieval.search(retrieval.index('v5-embeddings', docs), queryId, ALL));
    const fused = idsOf(retrieval.search(handleFor(), queryId, ALL));
    expect(new Set(fused)).toEqual(new Set([...bm25, ...dense]));
  });

  test('an integer truncates BOTH component lists before fusion', () => {
    const queryId = docs[0].id;
    const bm25 = idsOf(retrieval.search(retrieval.index('v4-bm25', docs), queryId, ALL));
    const dense = idsOf(retrieval.search(retrieval.index('v5-embeddings', docs), queryId, ALL));
    const fused = new Set(idsOf(retrieval.search(handleFor({ depth: 3 }), queryId, ALL)));
    expect(fused).toEqual(new Set([...bm25.slice(0, 3), ...dense.slice(0, 3)]));
  });

  test('a depth at or above both pool sizes is identical to null', () => {
    const a = retrieval.search(handleFor({ depth: ALL + 10 }), docs[0].id, 8);
    const b = retrieval.search(handleFor(), docs[0].id, 8);
    expect(a).toEqual(b);
  });

  test('a non-integer depth fails at index(), not after 2,304 queries', () => {
    expect(() => handleFor({ depth: 0 })).toThrow(/depth must be null or a positive integer/);
    expect(() => handleFor({ depth: 8.5 })).toThrow(/depth must be null or a positive integer/);
    expect(() => handleFor({ depth: '100' })).toThrow(/depth must be null or a positive integer/);
  });
});

describe('fusion: minmax-sum — the §16.11 ablation axis', () => {
  test('scores are the sum of two per-query min-max normalised component scores', () => {
    const queryId = docs[0].id;
    const norm = (hits) => {
      const max = hits[0].score;
      const min = hits[hits.length - 1].score;
      const spread = max - min;
      const table = new Map();
      for (const h of hits) table.set(h.docId, spread > 0 ? (h.score - min) / spread : 1);
      return table;
    };
    const bm25 = norm(retrieval.search(retrieval.index('v4-bm25', docs), queryId, ALL));
    const dense = norm(retrieval.search(retrieval.index('v5-embeddings', docs), queryId, ALL));

    for (const hit of retrieval.search(handleFor({ fusion: 'minmax-sum' }), queryId, ALL)) {
      expect(hit.score).toBeCloseTo((bm25.get(hit.docId) || 0) + (dense.get(hit.docId) || 0), 12);
    }
  });

  test('it changes the ranking, so the ablation is not vacuous', () => {
    const rrf = idsOf(retrieval.search(handleFor(), docs[0].id, 8));
    const combsum = idsOf(retrieval.search(handleFor({ fusion: 'minmax-sum' }), docs[0].id, 8));
    expect(combsum).not.toEqual(rrf);
  });

  test('an unknown fusion is rejected rather than silently defaulting', () => {
    expect(() => handleFor({ fusion: 'combmnz' })).toThrow(/fusion must be one of/);
  });
});

describe('the interface contract', () => {
  test('a bad rrfK fails at index()', () => {
    expect(() => handleFor({ rrfK: -1 })).toThrow(/rrfK must be a finite number/);
    expect(() => handleFor({ rrfK: '60' })).toThrow(/rrfK must be a finite number/);
  });

  test('an unknown param is a hard error, as it is for every rung', () => {
    expect(() => handleFor({ rffK: 60 })).toThrow(/unknown param rffK/);
  });

  test('the query never retrieves itself, from either component', () => {
    for (const doc of docs) {
      expect(idsOf(retrieval.search(handleFor(), doc.id, ALL))).not.toContain(doc.id);
    }
  });

  test('a document with no vector fails, because the dense component needs one', () => {
    const bare = parity.loadFixture();
    expect(() => retrieval.index('v6-hybrid', bare)).toThrow(/carries no `vector`/);
  });

  test('describe() reports symmetric false and a digest over all eleven params', () => {
    const described = retrieval.describe(handleFor());
    expect(described.symmetric).toBe(false);
    expect(described.digest).not.toBe(retrieval.describe(handleFor({ rrfK: 61 })).digest);
    expect(described.digest).not.toBe(retrieval.describe(handleFor({ depth: 100 })).digest);
    // Inert under minmax-sum and still in the digest — a param that vanishes
    // from a configuration is §13.10's "run that lies about itself".
    expect(retrieval.describe(handleFor({ fusion: 'minmax-sum' })).digest)
      .not.toBe(retrieval.describe(handleFor({ fusion: 'minmax-sum', rrfK: 61 })).digest);
  });

  test('output is deterministic and independent of corpus order', () => {
    const reversed = retrieval.index('v6-hybrid', [...docs].reverse());
    for (const doc of docs) {
      expect(idsOf(retrieval.search(reversed, doc.id, 8)))
        .toEqual(idsOf(retrieval.search(handleFor(), doc.id, 8)));
    }
  });
});
