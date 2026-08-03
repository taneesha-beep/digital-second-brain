'use strict';

/**
 * v1-overlap parity (Phase 2.1).
 *
 * The Done criterion is byte-identical output on a fixture corpus. Shipped v1
 * is not a deterministic function of (query, corpus) — it is a function of
 * (query, corpus, save history, database return order) — so what is proved
 * here is byte-identity under a stated freeze of the three unspecified inputs,
 * plus evidence that the freeze is load-bearing rather than decorative.
 *
 * Everything on the shipped side runs the real, unmodified modules:
 * utils/keywords.js, utils/corpus.js and services/linker.service.js. See
 * scripts/lib/fake-note-store.js for how they run without a database.
 */

// Jest maintains its own module registry, so the require.cache priming that
// serves `npm run parity:v1` under plain node does not reach it. Same fake,
// same shipped files, installed the way this runtime installs things.
jest.mock('../models/Note', () => require('../scripts/lib/fake-note-store').FakeNote);

const fs = require('fs');
const path = require('path');

const parity = require('../scripts/parity-v1');
const { extractKeywords } = require('../utils/keywords');
const { loadUserCorpus } = require('../utils/corpus');
const { FakeNoteStore, setStore } = require('../scripts/lib/fake-note-store');
const retrieval = require('../retrieval');
const v1 = require('../retrieval/v1-overlap');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.join(REPO, 'results', 'parity');
const USER = 'fixture-user';

const docs = parity.loadFixture();
const idOrder = [...docs.map((d) => d.id)].sort();

describe('v1-overlap reproduces the shipped algorithm', () => {
  test('the fixture is large enough to reach the paths that matter', () => {
    // A fixture that never reaches slice(0, 8) leaves the cap untested in both
    // implementations, and a fixture with no keyword list at or below six
    // never exercises the point where a single shared word clears 0.15.
    const { perDoc } = parity.runHarness(docs);
    expect(perDoc.length).toBeGreaterThanOrEqual(30);
    expect(perDoc.filter((d) => d.hits.length === parity.CAP).length).toBeGreaterThanOrEqual(5);
    expect(perDoc.filter((d) => d.keywords.length <= 6).length).toBeGreaterThanOrEqual(2);
    // Digits tokenise to integer-like object keys, which JavaScript enumerates
    // ahead of string keys — the behaviour extractKeywords' tie-breaking rests
    // on. If no fixture document contains one, that is untested.
    expect(perDoc.some((d) => d.keywords.some((k) => /^[0-9]+$/.test(k)))).toBe(true);
  });

  test('byte-identical: shipped composition vs. harness', async () => {
    const shipped = await parity.runShipped(docs, { order: idOrder });
    const harness = parity.runHarness(docs);
    const shippedText = parity.render(shipped.perDoc, 'mini-corpus.jsonl');
    const harnessText = parity.render(harness.perDoc, 'mini-corpus.jsonl');
    expect(harnessText).toBe(shippedText);
    expect(parity.sha256(harnessText)).toBe(parity.sha256(shippedText));
    expect(shippedText.split('\n').filter((l) => l.startsWith('LINK')).length).toBeGreaterThan(100);
  });

  test('keyword parity, per document, against the real extractKeywords', async () => {
    // The halves are proved separately as well as in composition: the harness
    // rebuilds the document-frequency table once for the whole corpus, where
    // keywords.js rebuilds it per call, so this is two implementations of one
    // function rather than one implementation called twice.
    const store = setStore(
      new FakeNoteStore(
        docs.map((d) => ({ _id: d.id, user: USER, title: d.title, contentText: d.body })),
        idOrder
      )
    );
    const handle = retrieval.index('v1-overlap', docs);
    for (const doc of docs) {
      const corpus = await loadUserCorpus(USER, { excludeId: doc.id });
      expect(corpus.length).toBe(docs.length - 1); // leave-one-out, cap not reached
      expect(v1.keywordsFor(handle._state, doc.id)).toEqual(
        extractKeywords(store.raw(doc.id).title, store.raw(doc.id).contentText, corpus)
      );
    }
  });

  test('idfCorpus: none reproduces the empty-corpus path', async () => {
    const handle = retrieval.index('v1-overlap', docs, { idfCorpus: 'none' });
    for (const doc of docs) {
      expect(v1.keywordsFor(handle._state, doc.id)).toEqual(
        extractKeywords(doc.title, doc.body, [], 10)
      );
    }
  });

  test('the committed evidence matches what the code produces now', () => {
    // Committed output that is regenerated and compared, so drift fails here
    // rather than being discovered when a number is quoted from it.
    const shippedFile = fs.readFileSync(path.join(EVIDENCE, 'v1-shipped.txt'), 'utf8');
    const harnessFile = fs.readFileSync(path.join(EVIDENCE, 'v1-harness.txt'), 'utf8');
    expect(harnessFile).toBe(shippedFile);
    expect(parity.render(parity.runHarness(docs).perDoc, 'mini-corpus.jsonl')).toBe(harnessFile);
  });
});

describe('the freeze is load-bearing, not decorative', () => {
  test('shipped output changes when only the store return order changes', async () => {
    const asc = await parity.runShipped(docs, { order: idOrder });
    const desc = await parity.runShipped(docs, { order: [...idOrder].reverse() });
    const ascText = parity.render(asc.perDoc, 'mini-corpus.jsonl');
    const descText = parity.render(desc.perDoc, 'mini-corpus.jsonl');
    expect(descText).not.toBe(ascText);

    // Not merely reordered within the eight: the returned SET changes, so a
    // document that the shipped app links to under one database ordering is
    // absent under another.
    const setOf = (run, id) => run.perDoc.find((d) => d.id === id).hits.map((h) => h.docId).sort().join(',');
    const membershipChanges = idOrder.filter((id) => setOf(asc, id) !== setOf(desc, id));
    expect(membershipChanges.length).toBeGreaterThan(0);
  });

  test('the harness gives one answer regardless of input order', () => {
    const forward = parity.runHarness(docs);
    const backward = parity.runHarness([...docs].reverse());
    expect(parity.render(backward.perDoc, 'mini-corpus.jsonl')).toBe(
      parity.render(forward.perDoc, 'mini-corpus.jsonl')
    );
  });

  test('above 500 documents, which 500 the database returns changes the keywords', async () => {
    // The fixture is deliberately under the cap, so this is the only place
    // loadUserCorpus's unsorted limit(500) is exercised.
    const capDocs = parity.capFixture();
    const ids = capDocs.map((d) => d.id);
    const asc = await parity.keywordsUnderOrder(capDocs, ids);
    const desc = await parity.keywordsUnderOrder(capDocs, [...ids].reverse());
    expect(asc.corpusSize).toBe(500);
    expect(capDocs.length).toBeGreaterThan(501);
    expect([...asc.keywords].sort()).not.toEqual([...desc.keywords].sort());
  });
});

describe('what the re-expression exposed about the shipped algorithm', () => {
  test('a document with six or fewer keywords links on a single shared word', () => {
    // strength = shared / |source keywords|, rounded to four places, kept when
    // strictly above 0.15. So the threshold means "share two words in ten" for
    // a normal note and "share one word" for a short one.
    const single = [];
    for (let d = 1; d <= 12; d += 1) {
      if (Number((1 / d).toFixed(4)) > 0.15) single.push(d);
    }
    expect(single).toEqual([1, 2, 3, 4, 5, 6]);

    const { perDoc } = parity.runHarness(docs);
    const short = perDoc.filter((d) => d.keywords.length <= 6 && d.hits.length > 0);
    expect(short.length).toBeGreaterThan(0);
    expect(short.some((d) => d.hits.some((h) => h.sharedKeywords.length === 1))).toBe(true);
  });

  test('sharedKeywords come out in target order, not query order', () => {
    // linker.service.js:13 filters the TARGET's list against the source's set.
    // Building them from the query side is the natural thing to do from a
    // postings list and would silently differ.
    const { perDoc } = parity.runHarness(docs);
    const handle = retrieval.index('v1-overlap', docs);
    let checked = 0;
    for (const doc of perDoc) {
      for (const hit of doc.hits) {
        if (hit.sharedKeywords.length < 2) continue;
        const targetKeywords = v1.keywordsFor(handle._state, hit.docId);
        const positions = hit.sharedKeywords.map((k) => targetKeywords.indexOf(k));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
