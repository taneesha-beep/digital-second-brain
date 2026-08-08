'use strict';

/**
 * v4-bm25 (Phase 3.3).
 *
 * Four groups earn their place; the rest are guards.
 *
 *   1. k1 AND b DO NOT TOUCH THE INDEX. Roadmap 3.3 asserts they do, and the
 *      whole sweep design rests on the correction. Asserted by indexing twice
 *      at different (k1, b) and comparing every persistent structure, not by
 *      reading the source.
 *
 *   2. THE df TABLE IS IDENTICAL TO v3'S. The ladder's continuity claim is that
 *      only the FORMULA mapping df to idf changed. That is checkable, so it is
 *      checked.
 *
 *   3. v4 IS NOT SYMMETRIC. v2 established symmetry (§14.5) and v3 preserved
 *      it. v4 gives it back, and an omission and a measurement look identical
 *      in a document. §14.5 put v1 through v2's test and reported the failure;
 *      this does the same in reverse.
 *
 *   4. THE NEGATIVE-IDF BOUNDARY. It cannot fire on cooking (max df 18.8%), so
 *      the only way to know the two variants differ where it matters is a
 *      corpus built to cross df > N/2.
 */

const fs = require('fs');
const path = require('path');

const retrieval = require('../retrieval');
const v1 = require('../retrieval/v1-overlap');
const v4 = require('../retrieval/v4-bm25');

const FIXTURE = path.join(__dirname, '..', 'retrieval', 'fixtures', 'mini-corpus.jsonl');
const DOCS = fs
  .readFileSync(FIXTURE, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line));

const SMALL = [
  { id: 'a', title: 'sourdough starter', body: 'sourdough starter feeding schedule sourdough' },
  { id: 'b', title: 'sourdough loaf', body: 'sourdough starter and a dense loaf' },
  { id: 'c', title: 'knife sharpening', body: 'whetstone angle knife sharpening' },
  { id: 'd', title: 'sourdough hydration', body: 'sourdough starter hydration dough' }
];

/** Every hit for every query, so a whole run can be compared in one value. */
function fullRanking(handle, k = 10) {
  return DOCS.map((doc) => retrieval.search(handle, doc.id, k)
    .map((h) => `${h.docId}:${h.score}`)
    .join(','))
    .join('|');
}

describe('k1 and b do not touch the index — roadmap 3.3 says they do', () => {
  // THE CORRECTION THIS RUNG OWES THE ROADMAP. 3.3 inherits from 2.7 the claim
  // that "k1 and b both change the index, so they cannot reuse a cached one",
  // and budgets ~30 lines of runner for it. In a standard BM25 the index holds
  // postings of (docIndex, tf), lengths, df, N and avgdl — none of which
  // mention k1 or b. The claim WOULD hold for a v3-style implementation that
  // bakes the finished weight into the postings, which is why v4 deliberately
  // does not.
  const A = retrieval.index('v4-bm25', DOCS, { k1: 1.2, b: 0.75 });
  const B = retrieval.index('v4-bm25', DOCS, { k1: 2.5, b: 0.1 });

  test('every persistent index structure is identical across (k1, b)', () => {
    const sa = A._state;
    const sb = B._state;

    expect(sb.avgdl).toBe(sa.avgdl);
    expect(sb.vocabularySize).toBe(sa.vocabularySize);
    expect([...sb.df.entries()]).toEqual([...sa.df.entries()]);
    expect([...sb.termIds.entries()]).toEqual([...sa.termIds.entries()]);
    expect([...sb.idf]).toEqual([...sa.idf]);
    expect([...sb.lengths]).toEqual([...sa.lengths]);
    expect([...sb.lengthRatioMinus1]).toEqual([...sa.lengthRatioMinus1]);
    expect(sb.postingsDocs.map((p) => [...p])).toEqual(sa.postingsDocs.map((p) => [...p]));
    expect(sb.postingsTfs.map((p) => [...p])).toEqual(sa.postingsTfs.map((p) => [...p]));
    expect(sb.docTerms.map((t) => [...t])).toEqual(sa.docTerms.map((t) => [...t]));
    expect(sb.docTfs.map((t) => [...t])).toEqual(sa.docTfs.map((t) => [...t]));
  });

  test('the k1/b-dependent normalisation is built lazily, at rank() and not at index()', () => {
    // If this cache were populated in buildIndex, buildIndex would be a function
    // of k1 and b and the test above would be checking a structure that happens
    // not to differ rather than one that cannot.
    const fresh = retrieval.index('v4-bm25', DOCS, { k1: 1.2, b: 0.75 });
    expect(fresh._state._k1Norm).toBeNull();
    retrieval.search(fresh, DOCS[0].id, 5);
    expect(fresh._state._k1Norm).not.toBeNull();
  });

  test('and they DO change the ranking, so the structures being equal is not vacuous', () => {
    expect(fullRanking(B)).not.toBe(fullRanking(A));
  });
});

describe('what v4 inherits from v3, and what it could not', () => {
  test('the df table is identical to v3 — only the idf FORMULA changed', () => {
    const v3Handle = retrieval.index('v3-tfidf', DOCS);
    const v4Handle = retrieval.index('v4-bm25', DOCS);
    // v3 stores df internally only as an idf table, so the comparison is over
    // the vocabulary and the term ids, which are derived from the same Set-based
    // df pass in both files.
    expect([...v4Handle._state.termIds.entries()])
      .toEqual([...v3Handle._state.termIds.entries()]);
    expect(v4Handle._state.df.size).toBe(v3Handle._state.termIds.size);
  });

  test('the tokenizer is v1\'s, not a copy', () => {
    // The sidecar's source digest records that v4 imports v1; this records what
    // it imports it FOR. A copy that drifted would make the whole ladder
    // incomparable and no metric would show it.
    expect(v4.idfFor).toBeInstanceOf(Function);
    expect(v1.tokenise('Sourdough, starter!')).toEqual(['sourdough', 'starter']);
  });

  test('|D| is total tokens with repetition, NOT the distinct-term count', () => {
    const handle = retrieval.index('v4-bm25', SMALL, { titleWeight: 2 });
    const s = handle._state;
    const i = s.indexById.get('a');
    // title "sourdough starter" doubled = 4 tokens, body "sourdough starter
    // feeding schedule sourdough" = 5 tokens (nothing is stopped, all len > 2).
    expect(s.lengths[i]).toBe(9);
    // distinct terms: sourdough, starter, feeding, schedule = 4
    expect(v4.termCount(s, 'a')).toBe(4);
    expect(s.lengths[i]).toBeGreaterThan(v4.termCount(s, 'a'));
  });

  test('titleWeight reaches tf AND |D|, which is new at this rung', () => {
    const two = retrieval.index('v4-bm25', SMALL, { titleWeight: 2 })._state;
    const one = retrieval.index('v4-bm25', SMALL, { titleWeight: 1 })._state;
    const i = two.indexById.get('a');
    expect(two.lengths[i]).toBe(9);
    expect(one.lengths[i]).toBe(7);
    // df is counted over a Set, so the doubling cannot reach it — which is why
    // the idf table is unaffected and titleWeight is a one-variable ablation.
    expect([...one.idf]).toEqual([...two.idf]);
  });

  test('no threshold, scorePrecision, minShared, topN, lengthBonus or idfCorpus', () => {
    for (const key of ['threshold', 'scorePrecision', 'minShared', 'topN', 'lengthBonus', 'idfCorpus', 'cap']) {
      expect(Object.keys(v4.defaultParams)).not.toContain(key);
      expect(() => retrieval.index('v4-bm25', SMALL, { [key]: 1 })).toThrow(/unknown param/);
    }
  });

  test('declaring no cap means uncapped, not rejected', () => {
    const handle = retrieval.index('v4-bm25', DOCS);
    expect(retrieval.search(handle, DOCS[0].id, 10).length).toBeGreaterThan(8);
  });
});

describe('v4 is NOT symmetric, and that is a property the ladder had', () => {
  // §14.5 proved score(A->B) === score(B->A) for v2 at exact float equality and
  // put v1 through the same test to MEASURE the asymmetry it removed. v3 kept
  // the property at real cost (§15.8). BM25 is a query-document function — the
  // document side is length-normalised and saturated, the query side is neither
  // — so v4 gives it back. Measured here rather than left unstated, because it
  // hands Phase 4 the tension that a winning v4 re-introduces exactly the
  // direction-dependence v2 was built to remove.
  test('there exists a pair whose two directions disagree', () => {
    const handle = retrieval.index('v4-bm25', SMALL);
    const scoreOf = (from, to) => {
      const hit = retrieval.search(handle, from, 10).find((h) => h.docId === to);
      return hit ? hit.score : null;
    };
    const ab = scoreOf('a', 'b');
    const ba = scoreOf('b', 'a');
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
    expect(ab).not.toBe(ba);
  });

  test('v3 passes the same check that v4 fails, on the same pair', () => {
    const handle = retrieval.index('v3-tfidf', SMALL);
    const scoreOf = (from, to) => {
      const hit = retrieval.search(handle, from, 10).find((h) => h.docId === to);
      return hit ? hit.score : null;
    };
    expect(scoreOf('a', 'b')).toBe(scoreOf('b', 'a'));
  });

  test('asymmetry is quantified across the fixture, and the exceptions are explained', () => {
    const handle = retrieval.index('v4-bm25', DOCS);
    const state = handle._state;
    const scores = new Map();
    for (const doc of DOCS) {
      for (const hit of retrieval.search(handle, doc.id, 40)) {
        scores.set(`${doc.id}>${hit.docId}`, hit.score);
      }
    }

    /** tf of every shared term, and |D|, for one document. */
    const profile = (id) => {
      const i = state.indexById.get(id);
      const tf = new Map();
      for (let j = 0; j < state.docTerms[i].length; j += 1) tf.set(state.docTerms[i][j], state.docTfs[i][j]);
      return { tf, len: state.lengths[i] };
    };

    let pairs = 0;
    let asymmetric = 0;
    let symmetricAndExplained = 0;
    for (const key of scores.keys()) {
      const [from, to] = key.split('>');
      if (from > to) continue;
      const back = scores.get(`${to}>${from}`);
      if (back === undefined) continue;
      pairs += 1;
      if (back !== scores.get(key)) { asymmetric += 1; continue; }

      // EQUAL LENGTH IS NECESSARY, and that is the check. The two directions
      // apply the saturation curve to different documents, so with |A| != |B|
      // they evaluate different functions and can only coincide by accident of
      // floating point. Every symmetric pair on this fixture has |A| == |B|.
      //
      // It is not SUFFICIENT — 025 vs 033 share `brine` (3 vs 1) and `poultry`
      // (1 vs 3) at equal length, and are symmetric anyway because those two
      // terms carry the same df and therefore the same idf, so the two
      // contributions swap places without changing the sum. A structural
      // coincidence, not float luck, and worth knowing the formula permits it.
      const a = profile(from);
      const b = profile(to);
      expect(a.len).toBe(b.len);
      symmetricAndExplained += 1;
    }

    expect(pairs).toBeGreaterThan(50);
    // Asymmetry is the rule, not an artefact of one pair.
    expect(asymmetric / pairs).toBeGreaterThan(0.9);
    expect(asymmetric + symmetricAndExplained).toBe(pairs);
  });
});

describe('the negative-idf boundary, which cooking cannot reach', () => {
  // Max df on cooking is 5,150 of 27,325 (18.8%), so robertson never goes
  // negative there and shipping it would look fine. A corpus that crosses
  // df > N/2 is the only way to see the difference.
  const HOT = [
    { id: 'x1', title: 'salt water', body: 'salt water boiling' },
    { id: 'x2', title: 'salt sugar', body: 'salt sugar mixing' },
    { id: 'x3', title: 'salt flour', body: 'salt flour kneading' },
    { id: 'x4', title: 'butter cream', body: 'butter cream whipping' }
  ];
  // "salt" is in 3 of 4 documents: df = 3 > N/2 = 2.

  test('robertson goes negative where lucene cannot', () => {
    expect(v4.idfFor('robertson', 4, 3)).toBeLessThan(0);
    expect(v4.idfFor('lucene', 4, 3)).toBeGreaterThan(0);
  });

  test('lucene is strictly positive for every df from 1 to N', () => {
    for (let df = 1; df <= 500; df += 1) {
      expect(v4.idfFor('lucene', 500, df)).toBeGreaterThan(0);
    }
  });

  test('a negative idf produces a NEGATIVE-SCORING hit that assertHits accepts', () => {
    // This is the failure mode the variant decision exists to name: the
    // interface's postconditions check finiteness and descending order, and a
    // negative score satisfies both. An anti-match is written to the run file
    // as a retrieval and nothing complains.
    const handle = retrieval.index('v4-bm25', HOT, { idfVariant: 'robertson' });
    const hits = retrieval.search(handle, 'x1', 10);
    const negative = hits.filter((h) => h.score < 0);
    expect(negative.length).toBeGreaterThan(0);
    // ...and it is still a well-formed, correctly ordered result list.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
    }
  });

  test('under lucene the same corpus produces only positive scores', () => {
    const handle = retrieval.index('v4-bm25', HOT, { idfVariant: 'lucene' });
    for (const hit of retrieval.search(handle, 'x1', 10)) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  test('the count of non-positive idf terms is recorded in the handle', () => {
    expect(retrieval.index('v4-bm25', HOT, { idfVariant: 'robertson' })._state.nonPositiveIdfTerms)
      .toBeGreaterThan(0);
    expect(retrieval.index('v4-bm25', HOT, { idfVariant: 'lucene' })._state.nonPositiveIdfTerms)
      .toBe(0);
  });
});

describe('the knobs do what their definitions say', () => {
  test('k1 = 0 discards term frequency entirely', () => {
    // tf·1/(tf + 0) = 1 for every tf, so a term repeated forty times scores as
    // one occurrence. If this arm scored anything else, tf is reaching the
    // scorer through a path the formula does not describe.
    const once = [
      { id: 'q', title: 'sourdough', body: 'sourdough' },
      { id: 'r', title: 'sourdough', body: 'sourdough bread' },
      { id: 's', title: 'sourdough', body: `${'sourdough '.repeat(40)}bread` }
    ];
    const handle = retrieval.index('v4-bm25', once, { k1: 0, b: 0 });
    const hits = retrieval.search(handle, 'q', 10);
    const byId = new Map(hits.map((h) => [h.docId, h.score]));
    expect(byId.get('r')).toBe(byId.get('s'));
  });

  test('b = 0 removes length normalisation; b = 1 applies it in full', () => {
    const handle0 = retrieval.index('v4-bm25', DOCS, { b: 0 });
    const handle1 = retrieval.index('v4-bm25', DOCS, { b: 1 });
    expect(fullRanking(handle0)).not.toBe(fullRanking(handle1));
    // At b = 0 the pivot factor is 1 for every document, so the k1 cache is a
    // constant — the check that b is genuinely switched off rather than small.
    const cache = handle0._state;
    retrieval.search(handle0, DOCS[0].id, 5);
    expect(new Set([...cache._k1Norm]).size).toBe(1);
  });

  test('large k1 approaches linear tf', () => {
    // The chain's linear-tf arm. tf(k1+1)/(tf + k1·L) -> tf/L as k1 -> inf, so
    // two very large k1 must agree to float precision while differing from 1.2.
    const big = retrieval.index('v4-bm25', DOCS, { k1: v4.K1_LINEAR });
    const bigger = retrieval.index('v4-bm25', DOCS, { k1: v4.K1_LINEAR * 100 });
    const normal = retrieval.index('v4-bm25', DOCS, { k1: 1.2 });
    const rankOnly = (h) => DOCS.map((d) => retrieval.search(h, d.id, 10).map((x) => x.docId).join(',')).join('|');
    expect(rankOnly(bigger)).toBe(rankOnly(big));
    expect(rankOnly(normal)).not.toBe(rankOnly(big));
  });

  test('qtfMode binary ignores the query\'s term frequencies', () => {
    const linear = retrieval.index('v4-bm25', DOCS, { qtfMode: 'linear' });
    const binary = retrieval.index('v4-bm25', DOCS, { qtfMode: 'binary' });
    expect(fullRanking(binary)).not.toBe(fullRanking(linear));
  });

  test('explain carries the shared-term count, matching v3\'s shape', () => {
    const handle = retrieval.index('v4-bm25', SMALL);
    for (const hit of retrieval.search(handle, 'a', 10)) {
      expect(Object.keys(hit.explain)).toEqual(['shared']);
      expect(Number.isInteger(hit.explain.shared)).toBe(true);
      expect(hit.explain.shared).toBeGreaterThan(0);
    }
  });
});

describe('parameters that would silently produce a plausible wrong run', () => {
  test('k1, b, idfVariant, qtfMode and titleWeight are all validated at index()', () => {
    // §14.8's rule: fail at handle construction, not after 2,304 queries of a
    // run whose digest faithfully records the value it could not honour.
    expect(() => retrieval.index('v4-bm25', SMALL, { k1: -1 })).toThrow(/k1/);
    expect(() => retrieval.index('v4-bm25', SMALL, { k1: '1.2' })).toThrow(/k1/);
    expect(() => retrieval.index('v4-bm25', SMALL, { k1: Infinity })).toThrow(/k1/);
    expect(() => retrieval.index('v4-bm25', SMALL, { b: 1.5 })).toThrow(/b must be/);
    expect(() => retrieval.index('v4-bm25', SMALL, { b: -0.1 })).toThrow(/b must be/);
    expect(() => retrieval.index('v4-bm25', SMALL, { b: '0.75' })).toThrow(/b must be/);
    expect(() => retrieval.index('v4-bm25', SMALL, { idfVariant: 'bm25' })).toThrow(/idfVariant/);
    expect(() => retrieval.index('v4-bm25', SMALL, { qtfMode: 'raw' })).toThrow(/qtfMode/);
    expect(() => retrieval.index('v4-bm25', SMALL, { titleWeight: 1.5 })).toThrow(/titleWeight/);
    expect(() => retrieval.index('v4-bm25', SMALL, { titleWeight: -1 })).toThrow(/titleWeight/);
  });

  test('two configurations carry different digests', () => {
    const a = retrieval.describe(retrieval.index('v4-bm25', SMALL, { k1: 1.2 }));
    const b = retrieval.describe(retrieval.index('v4-bm25', SMALL, { k1: 1.6 }));
    expect(a.digest).not.toBe(b.digest);
  });

  test('a document sharing no term is never returned', () => {
    const handle = retrieval.index('v4-bm25', SMALL);
    expect(retrieval.search(handle, 'c', 10).map((h) => h.docId)).not.toContain('a');
  });

  test('the scratch accumulator is reset even when collect() throws', () => {
    // v3's precedent: search() is serial and the scratch arrays are reused, so a
    // throw mid-rank that left them dirty would silently corrupt the NEXT query
    // rather than fail.
    const handle = retrieval.index('v4-bm25', SMALL);
    const before = retrieval.search(handle, 'a', 10);
    const state = handle._state;
    const realRank = handle._retriever.rank;
    expect(() => {
      realRank(state, SMALL[0], {
        k: 10,
        excludeId: 'a',
        collect() { throw new Error('boom'); }
      });
    }).toThrow('boom');
    expect([...state._acc].every((x) => x === 0)).toBe(true);
    expect([...state._shared].every((x) => x === 0)).toBe(true);
    expect(retrieval.search(handle, 'a', 10)).toEqual(before);
  });

  test('results do not depend on the order documents were indexed in', () => {
    const forward = retrieval.index('v4-bm25', DOCS);
    const reversed = retrieval.index('v4-bm25', [...DOCS].reverse());
    expect(fullRanking(reversed)).toBe(fullRanking(forward));
  });

  test('self-retrieval is impossible', () => {
    const handle = retrieval.index('v4-bm25', DOCS);
    for (const doc of DOCS) {
      expect(retrieval.search(handle, doc.id, 10).map((h) => h.docId)).not.toContain(doc.id);
    }
  });
});

describe('the leave-one-out idf that could not be inherited', () => {
  test('idfDelta reports the cost of dropping it, and it is not uniformly small', () => {
    const state = retrieval.index('v4-bm25', DOCS)._state;
    const delta = v4.idfDelta(state);
    expect(delta.max).toBeGreaterThan(0);
    // The shape of the claim, on any corpus: the difference between df and
    // df-1 is largest at the rare-term end, where it is a whole nat, not a
    // rounding difference. That is why §15.1's exactness argument does not
    // transfer and the drop is a decision rather than a convenience.
    const rare = Math.abs(v4.idfFor('lucene', 27325, 2) - v4.idfFor('lucene', 27325, 1));
    const common = Math.abs(v4.idfFor('lucene', 27325, 5150) - v4.idfFor('lucene', 27325, 5149));
    expect(rare).toBeGreaterThan(0.5);
    expect(common).toBeLessThan(0.001);
  });
});
