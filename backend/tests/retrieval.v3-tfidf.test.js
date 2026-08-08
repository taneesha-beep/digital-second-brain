'use strict';

/**
 * v3-tfidf (Phase 3.2).
 *
 * Three groups earn their place; the rest are guards.
 *
 *   1. THE TOP-10 ARM SELECTS EXACTLY WHAT v1 SELECTS. v2 got this by
 *      construction — it imports v1's buildIndex. v3 cannot: it needs term
 *      frequencies and norms, not keyword lists, so it re-implements the
 *      selection. Re-implemented, "the topN ablation moves one variable" is a
 *      CLAIM, and this is what turns it back into a checked fact.
 *
 *   2. THE LENGTH BONUS IS INERT AT FULL VOCABULARY. Asserted as identical
 *      output, not as an argument about slice().
 *
 *   3. SYMMETRY SURVIVES. v2 established it; a cosine over a common vector
 *      space keeps it, and the leave-one-out worry that would have broken it
 *      is the header's derivation. Proved here rather than inherited on trust.
 */

const fs = require('fs');
const path = require('path');

const retrieval = require('../retrieval');
const v1 = require('../retrieval/v1-overlap');
const v3 = require('../retrieval/v3-tfidf');

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

describe('the topN arm selects exactly what v1 selects', () => {
  // The ablation's whole validity rests on this. v3 re-implements v1's
  // selection because it needs different data structures, and the trap is
  // specific: v1 reads its ranking out of a PLAIN OBJECT, so integer-like
  // tokens ("350") enumerate before string keys and break ties between
  // equal-scoring terms. A Map is the natural refactor and produces a
  // different top-10 — which would make the topN ablation move two things.
  for (const lengthBonus of [true, false]) {
    test(`identical term sets on all 34 fixture documents, lengthBonus=${lengthBonus}`, () => {
      const v1Handle = retrieval.index('v1-overlap', DOCS, { lengthBonus });
      const v3Handle = retrieval.index('v3-tfidf', DOCS, { topN: 10, lengthBonus });

      const wordOf = [];
      for (const [word, id] of v3Handle._state.termIds) wordOf[id] = word;

      let checked = 0;
      for (const doc of DOCS) {
        const expected = v1.keywordsFor(v1Handle._state, doc.id);
        const i = v3Handle._state.indexById.get(doc.id);
        const actual = [...v3Handle._state.terms[i]].map((termId) => wordOf[termId]);
        // Sets, not sequences: v1's list is in selection-score order and v3's
        // is in the same order by construction, but only membership is what
        // the ablation depends on — a cosine does not read term order.
        expect(new Set(actual)).toEqual(new Set(expected));
        checked += 1;
      }
      expect(checked).toBe(34);
    });
  }

  test('the fixture still reaches documents with fewer than ten terms', () => {
    // §7.4: four fixture documents produce lists of 5 and 6. If a later edit
    // shrinks the fixture past that, the test above stops covering the case
    // where truncation does not bind, and it should fail loudly.
    const handle = retrieval.index('v1-overlap', DOCS);
    const short = DOCS.filter((d) => v1.keywordsFor(handle._state, d.id).length < 10);
    expect(short.length).toBeGreaterThanOrEqual(4);
  });
});

describe('the length bonus is inert at full vocabulary', () => {
  test('flipping it changes no score on any pair', () => {
    // Not "slice is not called, therefore nothing changes" — asserted as
    // output. PRIMER.md §3.3 predicted the bonus dies with the select-top-10
    // stage; this is that prediction as bytes.
    const on = retrieval.index('v3-tfidf', DOCS, { lengthBonus: true });
    const off = retrieval.index('v3-tfidf', DOCS, { lengthBonus: false });
    for (const doc of DOCS) {
      expect(retrieval.search(off, doc.id, 10)).toEqual(retrieval.search(on, doc.id, 10));
    }
  });

  test('and it is NOT inert at topN 10, which is why the ablation runs there', () => {
    const on = retrieval.index('v3-tfidf', DOCS, { topN: 10, lengthBonus: true });
    const off = retrieval.index('v3-tfidf', DOCS, { topN: 10, lengthBonus: false });
    const differs = DOCS.some(
      (doc) =>
        JSON.stringify(retrieval.search(on, doc.id, 10)) !==
        JSON.stringify(retrieval.search(off, doc.id, 10))
    );
    expect(differs).toBe(true);
  });

  test('the two configurations still carry different digests', () => {
    // Inert must not mean invisible: a run whose params say lengthBonus=false
    // has to be distinguishable from one that says true, or the ablation
    // cannot be traced back from its run file.
    const on = retrieval.describe(retrieval.index('v3-tfidf', DOCS, { lengthBonus: true }));
    const off = retrieval.describe(retrieval.index('v3-tfidf', DOCS, { lengthBonus: false }));
    expect(on.digest).not.toBe(off.digest);
  });
});

describe('symmetry, which a cosine over a common vector space keeps', () => {
  test('score(A->B) === score(B->A) at exact float equality, both directions checked', () => {
    // The leave-one-out worry that would have broken this: idf is nominally
    // per-document, and two vectors weighted by different tables have no
    // cosine between them. They do not — for terms a document CONTAINS,
    // df_loo = df - 1 always, so the table is global. This is that derivation
    // as a test.
    const handle = retrieval.index('v3-tfidf', DOCS);
    const byPair = new Map();
    for (const doc of DOCS) {
      for (const hit of retrieval.search(handle, doc.id, DOCS.length)) {
        byPair.set(`${doc.id}|${hit.docId}`, hit.score);
      }
    }
    let pairs = 0;
    for (const [key, score] of byPair) {
      const [from, to] = key.split('|');
      const reverse = byPair.get(`${to}|${from}`);
      // Reachability first: B must be reachable from A exactly when A is
      // reachable from B. Checking only the scores is a common way to miss a
      // real asymmetry.
      expect(reverse).toBeDefined();
      expect(reverse).toBe(score); // toBe, not toBeCloseTo
      pairs += 1;
    }
    expect(pairs).toBeGreaterThan(100);
  });

  test('the canonical accumulation order that makes it exact', () => {
    // Symmetry here is bit-exact only because both directions sum the shared
    // terms in the SAME order. Before this, score(A->B) was
    // 0.14845859879756534 against 0.14845859879756532 — floating-point
    // addition is not associative, and the two directions walk different
    // vectors. Two properties hold it in place, and both are load-bearing.
    const handle = retrieval.index('v3-tfidf', DOCS);

    // 1. every document's vector is stored in ascending term id
    for (const vector of handle._state.terms) {
      expect([...vector]).toEqual([...vector].sort((a, b) => a - b));
    }

    // 2. term ids follow the SORTED vocabulary, not first-seen order — so a
    //    reversed corpus cannot permute them and move the last bits.
    const words = [...handle._state.termIds.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
    expect(words).toEqual([...words].sort());
    const reversed = retrieval.index('v3-tfidf', [...DOCS].reverse());
    expect([...reversed._state.termIds.keys()].sort()).toEqual([...handle._state.termIds.keys()].sort());
    for (const doc of DOCS) {
      const i = handle._state.indexById.get(doc.id);
      const j = reversed._state.indexById.get(doc.id);
      expect(reversed._state.norms[j]).toBe(handle._state.norms[i]); // toBe: same bits
    }
  });

  test('and holds on deliberately unequal-length documents', () => {
    const handle = retrieval.index('v3-tfidf', [
      { id: 'x', title: 'salt', body: 'salt' },
      { id: 'y', title: 'salt pepper', body: 'salt pepper cumin paprika oregano thyme basil' },
      { id: 'z', title: 'salt pepper cumin', body: 'salt' }
    ]);
    const ab = retrieval.search(handle, 'x', 5).find((h) => h.docId === 'y');
    const ba = retrieval.search(handle, 'y', 5).find((h) => h.docId === 'x');
    expect(ab.score).toBe(ba.score);
  });
});

describe('the admission rule, and what v3 declares it is', () => {
  test('minShared 1 admits every candidate sharing a term', () => {
    const handle = retrieval.index('v3-tfidf', SMALL);
    // c shares nothing with a; b and d share sourdough/starter.
    expect(retrieval.search(handle, 'a', 10).map((h) => h.docId).sort()).toEqual(['b', 'd']);
  });

  test('minShared 2 is a real rule, not a vacuous one', () => {
    const one = retrieval.index('v3-tfidf', DOCS, { minShared: 1 });
    const two = retrieval.index('v3-tfidf', DOCS, { minShared: 2 });
    let removed = 0;
    for (const doc of DOCS) {
      removed += retrieval.search(one, doc.id, 10).length - retrieval.search(two, doc.id, 10).length;
    }
    expect(removed).toBeGreaterThan(0);
  });

  test('explain carries the shared-term COUNT, and it agrees with minShared', () => {
    const handle = retrieval.index('v3-tfidf', DOCS, { minShared: 3 });
    for (const doc of DOCS) {
      for (const hit of retrieval.search(handle, doc.id, 10)) {
        expect(hit.explain.shared).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('v3 declares no cap, and is therefore uncapped rather than rejected', () => {
    // Pre-registered at 3.1 (§14.3, types.js): "v3 and v4 will carry no cap".
    expect('cap' in retrieval.index('v3-tfidf', DOCS).params).toBe(false);
    expect(retrieval.search(retrieval.index('v3-tfidf', DOCS), DOCS[0].id, 10).length).toBe(10);
  });

  test('threshold and scorePrecision are not params of this rung', () => {
    // Dropped rather than carried inert: a continuous score has no achievable
    // lattice, so §13.2's exhaustiveness argument does not transfer and no
    // value is defensible. An unknown param is a hard error, which is what
    // makes "this rung has no threshold" checkable instead of remembered.
    expect(() => retrieval.index('v3-tfidf', DOCS, { threshold: 0.1 })).toThrow(/unknown param/);
    expect(() => retrieval.index('v3-tfidf', DOCS, { scorePrecision: 4 })).toThrow(/unknown param/);
  });
});

describe('parameters that would silently produce a plausible wrong run', () => {
  test('topN null is full vocabulary; topN 0 or a non-integer is rejected', () => {
    // `slice(0, null)` returns [], so a null reaching a truncation path empties
    // every vector and every score becomes 0/0 — a run of zeroes that looks
    // like a finding. Rejected at index().
    expect(retrieval.index('v3-tfidf', DOCS).params.topN).toBe(null);
    expect(() => retrieval.index('v3-tfidf', DOCS, { topN: 0 })).toThrow(/topN/);
    expect(() => retrieval.index('v3-tfidf', DOCS, { topN: 2.5 })).toThrow(/topN/);
    expect(() => retrieval.index('v3-tfidf', DOCS, { topN: '10' })).toThrow(/topN/);
  });

  test('full vocabulary really is larger than the top-10 arm', () => {
    const full = retrieval.index('v3-tfidf', DOCS);
    const top10 = retrieval.index('v3-tfidf', DOCS, { topN: 10 });
    const size = (h) => [...h._state.terms].reduce((a, t) => a + t.length, 0);
    expect(size(full)).toBeGreaterThan(size(top10));
  });

  test('an idfCorpus, minShared or lengthBonus it cannot honour is rejected', () => {
    expect(() => retrieval.index('v3-tfidf', DOCS, { idfCorpus: 'some' })).toThrow(/idfCorpus/);
    expect(() => retrieval.index('v3-tfidf', DOCS, { minShared: 0 })).toThrow(/minShared/);
    expect(() => retrieval.index('v3-tfidf', DOCS, { lengthBonus: 'true' })).toThrow(/lengthBonus/);
  });

  test('idfCorpus none collapses the weighting to a pure TF cosine', () => {
    // §12.2's re-scoped ablation. Every idf equal means the weight is tf alone,
    // so this is the arm that answers "does the rarity signal help".
    const none = retrieval.index('v3-tfidf', DOCS, { idfCorpus: 'none' });
    const loo = retrieval.index('v3-tfidf', DOCS);
    const differs = DOCS.some(
      (d) =>
        JSON.stringify(retrieval.search(none, d.id, 10)) !==
        JSON.stringify(retrieval.search(loo, d.id, 10))
    );
    expect(differs).toBe(true);
  });
});

describe('invariants the formula forces', () => {
  test('every score is in [0, 1] and a near-duplicate approaches 1', () => {
    const handle = retrieval.index('v3-tfidf', [
      ...DOCS,
      { id: 'twin-1', title: 'brining a turkey', body: 'how long should I brine a turkey for' },
      { id: 'twin-2', title: 'brining a turkey', body: 'how long should I brine a turkey for' }
    ]);
    for (const doc of DOCS) {
      for (const hit of retrieval.search(handle, doc.id, 10)) {
        expect(hit.score).toBeGreaterThan(0);
        expect(hit.score).toBeLessThanOrEqual(1);
      }
    }
    const twin = retrieval.search(handle, 'twin-1', 1)[0];
    expect(twin.docId).toBe('twin-2');
    expect(twin.score).toBeCloseTo(1, 10);
  });

  test('a document sharing no term is never returned', () => {
    const handle = retrieval.index('v3-tfidf', SMALL);
    expect(retrieval.search(handle, 'c', 10).map((h) => h.docId)).not.toContain('a');
  });

  test('the scratch accumulator is reset even when collect() throws', () => {
    // rank() reuses one Float64Array across every query. A throw inside
    // collect() mid-rank would leave it dirty and the NEXT query would score
    // against residue — a wrong run with no error. The reset is in a finally,
    // and this is what checks it.
    const handle = retrieval.index('v3-tfidf', DOCS);
    const clean = retrieval.search(handle, DOCS[0].id, 10);

    // rank() is called directly, because no route through search() can make
    // collect() throw on this fixture — and a test that cannot reach the code
    // it names is not a test of it.
    const exploding = {
      k: 10,
      excludeId: DOCS[0].id,
      collect() { throw new Error('boom'); }
    };
    expect(() => v3.rank(handle._state, DOCS[0], exploding)).toThrow(/boom/);

    expect(handle._state._acc.every((v) => v === 0)).toBe(true);
    expect(handle._state._shared.every((v) => v === 0)).toBe(true);
    expect(retrieval.search(handle, DOCS[0].id, 10)).toEqual(clean);
  });

  test('results do not depend on the order documents were indexed in', () => {
    const forward = retrieval.index('v3-tfidf', DOCS);
    const backward = retrieval.index('v3-tfidf', [...DOCS].reverse());
    for (const doc of DOCS) {
      expect(retrieval.search(backward, doc.id, 10)).toEqual(retrieval.search(forward, doc.id, 10));
    }
  });
});
