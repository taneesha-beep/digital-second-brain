'use strict';

/**
 * The interface contract (Phase 2.1).
 *
 * The self-retrieval cases are the reason this file exists. CLAUDE.md names
 * the query sitting in its own candidate pool as the most common way an IR
 * evaluation goes quietly wrong, so it is enforced by construction and the
 * enforcement is tested with a retriever that deliberately tries to defeat it.
 */

const fs = require('fs');
const path = require('path');

const retrieval = require('../retrieval');
const { assertHits, resolveParams, canonicalJson } = require('../retrieval/types');

const DOCS = [
  { id: 'a', title: 'sourdough starter', body: 'sourdough starter feeding schedule' },
  { id: 'b', title: 'sourdough loaf', body: 'sourdough starter and a dense loaf' },
  { id: 'c', title: 'knife sharpening', body: 'whetstone angle knife sharpening' },
  { id: 'd', title: 'sourdough hydration', body: 'sourdough starter hydration dough' }
];

describe('self-retrieval is excluded by construction', () => {
  test('a retriever that tries to collect its own query id is silently dropped', () => {
    retrieval.register({
      version: 'test-cheat',
      defaultParams: {},
      buildIndex: (docs) => docs,
      rank(state, queryDoc, ctx) {
        ctx.collect(queryDoc.id, 999); // the perfect self-match
        for (const doc of state) if (doc.id !== queryDoc.id) ctx.collect(doc.id, 1);
      }
    });
    const handle = retrieval.index('test-cheat', DOCS);
    const hits = retrieval.search(handle, 'a', 10);
    expect(hits.map((h) => h.docId)).toEqual(['b', 'c', 'd']);
    expect(hits.some((h) => h.docId === 'a')).toBe(false);
  });

  test('assertHits throws if a self-hit reaches the caller by any other route', () => {
    expect(() => assertHits([{ docId: 'a', score: 1 }], { k: 10, excludeId: 'a' })).toThrow(
      /self-retrieval/
    );
  });

  test('there is no anonymous query — a document with no id is rejected', () => {
    const handle = retrieval.index('v1-overlap', DOCS);
    expect(() => retrieval.search(handle, { title: 'no id here' }, 8)).toThrow(/non-empty id/);
    expect(() => retrieval.search(handle, '', 8)).toThrow(/non-empty id/);
  });

  test('a query outside the index is rejected rather than scored', () => {
    const handle = retrieval.index('v1-overlap', DOCS);
    expect(() => retrieval.search(handle, 'not-in-corpus', 8)).toThrow(/not in the index/);
  });

  test('a retriever may not export its own search()', () => {
    expect(() =>
      retrieval.register({
        version: 'test-own-search',
        defaultParams: {},
        buildIndex: (d) => d,
        rank: () => {},
        search: () => []
      })
    ).toThrow(/must not export search/);
  });
});

describe('postconditions', () => {
  test('k is respected and the cap is applied on top of it', () => {
    const handle = retrieval.index('v1-overlap', DOCS);
    expect(retrieval.search(handle, 'a', 1).length).toBeLessThanOrEqual(1);
    const capped = retrieval.index('v1-overlap', DOCS, { cap: 1 });
    expect(retrieval.search(capped, 'a', 10).length).toBeLessThanOrEqual(1);
  });

  test('hits come back in descending score order', () => {
    const handle = retrieval.index('v1-overlap', DOCS);
    const scores = retrieval.search(handle, 'a', 8).map((h) => h.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  test('collecting the same document twice throws', () => {
    retrieval.register({
      version: 'test-dupe',
      defaultParams: {},
      buildIndex: (d) => d,
      rank(state, queryDoc, ctx) {
        ctx.collect('b', 1);
        ctx.collect('b', 1);
      }
    });
    const handle = retrieval.index('test-dupe', DOCS);
    expect(() => retrieval.search(handle, 'a', 8)).toThrow(/collected twice/);
  });

  test('k must be a positive integer', () => {
    const handle = retrieval.index('v1-overlap', DOCS);
    expect(() => retrieval.search(handle, 'a', 0)).toThrow(/positive integer/);
    expect(() => retrieval.search(handle, 'a', 2.5)).toThrow(/positive integer/);
  });
});

describe('params and provenance', () => {
  test('an unknown param is a hard error, not a silent no-op', () => {
    // A typo'd param produces a run that looks like a one-variable change and
    // is not one, and nothing in the output reveals it.
    expect(() => retrieval.index('v1-overlap', DOCS, { treshold: 0.2 })).toThrow(/unknown param/);
    expect(() => resolveParams('x', { a: 1 }, { b: 2 })).toThrow(/unknown param/);
  });

  test('the handle is self-describing and the digest tracks the params', () => {
    const base = retrieval.describe(retrieval.index('v1-overlap', DOCS));
    const moved = retrieval.describe(retrieval.index('v1-overlap', DOCS, { threshold: 0.2 }));
    expect(base.version).toBe('v1-overlap');
    expect(base.docCount).toBe(4);
    expect(base.digest).not.toBe(moved.digest);
    expect(retrieval.describe(retrieval.index('v1-overlap', DOCS)).digest).toBe(base.digest);
  });

  test('params are frozen once indexed', () => {
    const handle = retrieval.index('v1-overlap', DOCS);
    expect(Object.isFrozen(handle.params)).toBe(true);
  });

  test('the digest ignores key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  test('v1 rejects an idfCorpus or threshold it cannot honour', () => {
    expect(() => retrieval.index('v1-overlap', DOCS, { idfCorpus: 'some' })).toThrow(/idfCorpus/);
    expect(() => retrieval.index('v1-overlap', DOCS, { threshold: -1 })).toThrow(/threshold/);
  });

  describe('cap is validated, because the interface is what reads it', () => {
    // Opened by 2.7 (EVALUATION.md §13.10) and fixed at 3.1. index.js used to
    // test the cap with Number.isFinite, which does not coerce — so a cap
    // arriving as the STRING "8" fell through to Infinity and produced an
    // UNCAPPED run whose digest recorded cap:"8". A run that lies about itself.

    test('a cap that is not a number is rejected rather than silently ignored', () => {
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: '8' })).toThrow(/cap must be null/);
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: true })).toThrow(/cap must be null/);
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: 'Infinity' })).toThrow(/cap must be null/);
    });

    test('the specific defect: a string cap used to uncap the run', () => {
      // The regression this fix exists for, stated as the behaviour rather
      // than as the predicate. Three documents can be returned at k=3; a real
      // cap of 1 returns one. Before the fix, "1" also returned three.
      const capped = retrieval.index('v1-overlap', DOCS, { cap: 1, threshold: 0 });
      expect(retrieval.search(capped, 'a', 3).length).toBe(1);
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: '1', threshold: 0 })).toThrow();
    });

    test('a non-integer or non-positive cap is rejected too', () => {
      // slice truncates, so cap 8.5 behaves as 8 while the digest says 8.5 —
      // the same defect in a quieter form.
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: 8.5 })).toThrow(/cap must be null/);
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: 0 })).toThrow(/cap must be null/);
      expect(() => retrieval.index('v1-overlap', DOCS, { cap: -1 })).toThrow(/cap must be null/);
    });

    test('the two spellings that must keep working, do', () => {
      // Every committed run uses one of these: cap 8 (v1 as shipped) and
      // cap null (the uncapped ablation, `--param cap=null`). Neither moves.
      expect(retrieval.index('v1-overlap', DOCS, { cap: 8 }).params.cap).toBe(8);
      expect(retrieval.search(retrieval.index('v1-overlap', DOCS, { cap: null }), 'a', 3)).toHaveLength(
        retrieval.search(retrieval.index('v1-overlap', DOCS, {}), 'a', 3).length
      );
    });

    test('a retriever declaring no cap at all is uncapped, not rejected', () => {
      retrieval.register({
        version: 'test-no-cap',
        defaultParams: {},
        buildIndex: (d) => d,
        rank(state, queryDoc, ctx) {
          for (const doc of state) if (doc.id !== queryDoc.id) ctx.collect(doc.id, 1);
        }
      });
      const handle = retrieval.index('test-no-cap', DOCS);
      expect(retrieval.search(handle, 'a', 3)).toHaveLength(3);
    });
  });
});

describe('corpus validation', () => {
  test('a duplicate doc id is rejected', () => {
    // A duplicate makes one document unreachable and inflates every document
    // frequency it touches — a silent corruption of the IDF.
    expect(() => retrieval.index('v1-overlap', [...DOCS, { id: 'a', title: 'x', body: 'y' }])).toThrow(
      /duplicate doc id/
    );
  });

  test('a missing or non-string id is rejected', () => {
    expect(() => retrieval.index('v1-overlap', [{ title: 'x', body: 'y' }])).toThrow(/non-empty string/);
    expect(() => retrieval.index('v1-overlap', [{ id: 7, title: 'x' }])).toThrow(/non-empty string/);
  });
});

describe('determinism', () => {
  test('results do not depend on the order documents were handed to index()', () => {
    const forward = retrieval.index('v1-overlap', DOCS);
    const backward = retrieval.index('v1-overlap', [...DOCS].reverse());
    for (const doc of DOCS) {
      expect(retrieval.search(backward, doc.id, 8)).toEqual(retrieval.search(forward, doc.id, 8));
    }
  });
});

describe('no I/O', () => {
  test('backend/retrieval requires nothing but itself and crypto', () => {
    // The property that lets Phase 4.1 give the app and the eval harness the
    // same import path. Checked statically so it does not depend on which
    // modules a previous test happened to load.
    const dir = path.join(__dirname, '..', 'retrieval');
    const files = [];
    (function walk(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    })(dir);
    expect(files.length).toBeGreaterThan(0);

    const offenders = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = match[1];
        if (spec === 'crypto') continue;
        const resolved = spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : spec;
        if (!resolved.startsWith(dir + path.sep)) {
          offenders.push(`${path.relative(dir, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
