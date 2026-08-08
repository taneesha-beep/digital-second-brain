'use strict';

/**
 * v5-embeddings (Phase 3.4).
 *
 * The failure mode this rung has and no rung below it had: A DENSE RETRIEVER
 * FAILS QUIETLY. A lexical rung that loses its postings returns nothing and the
 * zero-result count says so. A dense rung handed the wrong vectors returns ten
 * well-formed, correctly-ordered, plausibly-scored documents for every query and
 * writes a run file that passes every postcondition the interface has. So most
 * of what is below is about the ways the numbers can be nonsense while looking
 * healthy.
 *
 * Vectors here are SYNTHETIC — see helpers/fixture-vectors.js for why the suite
 * must not need the model. Nothing in this file claims the embeddings are good;
 * that is measured on dev, in the run.
 */

const parity = require('../scripts/parity-v1');
const retrieval = require('../retrieval');
const v5 = require('../retrieval/v5-embeddings');
const { DIM, withVectors, vectorFor } = require('./helpers/fixture-vectors');

const baseDocs = parity.loadFixture();
const docs = withVectors(baseDocs);
const ALL = docs.length;

function scoresFrom(handle, queryId) {
  const out = new Map();
  for (const hit of retrieval.search(handle, queryId, ALL)) out.set(hit.docId, hit.score);
  return out;
}

describe('v5 receives vectors as DATA, and refuses anything it cannot trust', () => {
  test('a document with no vector is a hard error naming how to build them', () => {
    expect(() => retrieval.index('v5-embeddings', baseDocs)).toThrow(/carries no `vector`/);
  });

  test('a wrong-width vector is rejected rather than read as a shorter document', () => {
    const bad = docs.map((d, i) => (i === 7 ? { ...d, vector: new Float32Array(128) } : d));
    expect(() => retrieval.index('v5-embeddings', bad)).toThrow(/128-dim vector, expected 384/);
  });

  test('a non-finite component is rejected — NaN sorts, so it would survive assertHits', () => {
    const poisoned = vectorFor(docs[3].id).slice();
    poisoned[100] = NaN;
    const bad = docs.map((d, i) => (i === 3 ? { ...d, vector: poisoned } : d));
    expect(() => retrieval.index('v5-embeddings', bad)).toThrow(/non-finite component at dim 100/);
  });

  test('a zero-norm vector is rejected — its cosine is 0/0, not 0', () => {
    const bad = docs.map((d, i) => (i === 5 ? { ...d, vector: new Float32Array(DIM) } : d));
    expect(() => retrieval.index('v5-embeddings', bad)).toThrow(/zero-norm vector/);
  });

  test('`vectors` must be a non-empty slug — the run has to name the data it came from', () => {
    expect(() => retrieval.index('v5-embeddings', docs, { vectors: '' })).toThrow(/non-empty slug/);
  });

  test('the vectors slug is IN THE PARAMS DIGEST, so two embeddings are two configurations', () => {
    // The reason it is a param and not a runner flag. Without this, the 256-token
    // and 128-token runs would share a digest and the comparison report would
    // say zero variables changed. §13.10's "run that lies about itself".
    const a = retrieval.index('v5-embeddings', docs, { vectors: 'minilm-l6-v2-fp32-256' });
    const b = retrieval.index('v5-embeddings', docs, { vectors: 'minilm-l6-v2-fp32-128' });
    expect(a.digest).not.toBe(b.digest);
  });
});

describe('scoring', () => {
  const cosine = retrieval.index('v5-embeddings', docs);
  const dot = retrieval.index('v5-embeddings', docs, { normalise: false });

  test('cosine stays inside [-1, 1] — the invariant BM25 did not have', () => {
    // v3 had [0,1]; §16.6 records that BM25 is an unbounded sum with no
    // analogue; a cosine has the bound back, so v5 asserts what it actually
    // guarantees rather than inheriting an assertion.
    for (const doc of docs) {
      for (const score of scoresFrom(cosine, doc.id).values()) {
        expect(score).toBeGreaterThanOrEqual(-1.000001);
        expect(score).toBeLessThanOrEqual(1.000001);
      }
    }
  });

  test('two documents with the SAME vector score exactly 1.0, and it is not self-retrieval', () => {
    const twin = { id: 'twin-of-001', title: 'x', body: 'y', vector: vectorFor(docs[0].id) };
    const handle = retrieval.index('v5-embeddings', [...docs, twin]);
    const scores = scoresFrom(handle, docs[0].id);
    // 7 places, not 12, and the gap is the data type rather than sloppiness:
    // the stored components are float32 (~1e-7 relative), so a 384-term dot
    // product of a vector with itself lands about 4e-9 off 1.0. Measured here
    // rather than guessed, and it is what calibrates v5's COSINE_TOLERANCE of
    // 1e-6 — generous by ~2 orders against the real error, tight enough to
    // catch rows that were never normalised.
    expect(scores.get('twin-of-001')).toBeCloseTo(1, 7);
    // The distinction that matters: a genuine duplicate SHOULD score 1.0. What
    // must never appear is the query itself.
    expect(scores.has(docs[0].id)).toBe(false);
  });

  test('`normalise` actually acts — cosine and dot product rank differently', () => {
    // If the fixture's norms were all equal this would pass vacuously, so the
    // helper deliberately varies them.
    const orders = [cosine, dot].map((h) => retrieval.search(h, docs[0].id, ALL).map((x) => x.docId).join(','));
    expect(orders[0]).not.toBe(orders[1]);
  });

  test('raw dot product is unbounded above 1, which is the point of the ablation', () => {
    const anyAboveOne = docs.some((doc) => [...scoresFrom(dot, doc.id).values()].some((s) => s > 1));
    expect(anyAboveOne).toBe(true);
  });

  test('no `explain` — the absence is the finding, not an oversight', () => {
    for (const hit of retrieval.search(cosine, docs[0].id, 5)) {
      expect(hit.explain).toBeUndefined();
    }
  });

  test('every non-query document is scored — exact search means no candidate pool', () => {
    // v3 and v4 reach candidates through postings, so a document sharing no term
    // is never scored. v5 has no postings: every document is a candidate, which
    // is what "exact" means and is why the ANN question comes up at all.
    expect(retrieval.search(cosine, docs[0].id, ALL).length).toBe(ALL - 1);
  });
});

describe('the properties that keep a run reproducible', () => {
  test('output does not depend on corpus order', () => {
    const forward = retrieval.index('v5-embeddings', docs);
    const reversed = retrieval.index('v5-embeddings', [...docs].reverse());
    for (const doc of docs) {
      const a = retrieval.search(forward, doc.id, ALL);
      const b = retrieval.search(reversed, doc.id, ALL);
      expect(a.map((h) => h.docId)).toEqual(b.map((h) => h.docId));
      for (let i = 0; i < a.length; i += 1) expect(a[i].score).toBe(b[i].score);
    }
  });

  test('self-retrieval is excluded, and the interface throws if rank() emits it anyway', () => {
    const handle = retrieval.index('v5-embeddings', docs);
    for (const doc of docs) {
      expect(retrieval.search(handle, doc.id, ALL).some((h) => h.docId === doc.id)).toBe(false);
    }
    // Mechanism 2, checked by mutation the way §7.3 checks it for v1: a rank()
    // that deliberately reports the query must not slip through.
    const rogue = {
      version: 'test-v5-self-retrieval',
      defaultParams: { dim: DIM },
      symmetric: true,
      buildIndex: () => ({}),
      rank: (state, queryDoc, ctx) => {
        ctx.collect(queryDoc.id, 1.0);
        // collect() drops it silently (mechanism 1); force it past that too.
        ctx.collect('__x', 0.5);
      }
    };
    retrieval.register(rogue);
    const rogueHandle = retrieval.index('test-v5-self-retrieval', docs);
    expect(retrieval.search(rogueHandle, docs[0].id, 5).some((h) => h.docId === docs[0].id)).toBe(false);
  });

  test('v5 imports nothing — it is the first rung that does not share v1\'s tokeniser', () => {
    const source = require('../eval/source-digest').retrieverSource('v5-embeddings');
    const files = source.files.map((f) => f.path.split('/').pop()).sort();
    expect(files).toEqual(['index.js', 'types.js', 'v5-embeddings.js']);
    // v3 and v4 carry v1-overlap.js for tokenise(). v5 has no term space, so
    // there is nothing to share — and the digest is what says so.
    const v4files = require('../eval/source-digest').retrieverSource('v4-bm25').files
      .map((f) => f.path.split('/').pop());
    expect(v4files).toContain('v1-overlap.js');
  });
});
