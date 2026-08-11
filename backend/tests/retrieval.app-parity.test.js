'use strict';

/**
 * App/harness parity (Phase 4.1).
 *
 * The 4.1 Done criterion is "a test asserts app-side and harness-side results
 * are identical for the same corpus". Two things have to be true for that
 * sentence to mean anything, and both are asserted here rather than one:
 *
 *   1. THE COMPARISON IS NOT A TAUTOLOGY. Both sides share backend/retrieval/
 *      — that IS the deliverable — and share nothing else. The app side runs
 *      Note.find().select().sort().limit().lean(), the ObjectId->string
 *      conversion and services/noteCorpus.service.js's projection; the harness
 *      side reads {id, title, body} off disk as run-eval.js does.
 *   2. "THE SAME CORPUS" IS A DEFINITION. Two corpora are the same when their
 *      ordered {id, title, body} triples render identically under
 *      renderCorpus(). The tests below check that definition is not vacuous
 *      before relying on it — a digest that never differs proves nothing.
 *
 * Jest keeps its own module registry, so the require.cache priming that serves
 * `npm run parity:app` under plain node does not reach it. Same fake, same
 * shipped files, installed the way this runtime installs things.
 */

jest.mock('../models/Note', () => require('../scripts/lib/fake-note-store').FakeNote);

const fs = require('fs');
const path = require('path');

const parityApp = require('../scripts/parity-app');
const parityV1 = require('../scripts/parity-v1');
const noteCorpus = require('../services/noteCorpus.service');
const retrieval = require('../retrieval');
const { FakeNoteStore, setStore } = require('../scripts/lib/fake-note-store');

const REPO = path.resolve(__dirname, '..', '..');
const EVIDENCE = path.join(REPO, 'results', 'parity');
const USER = parityApp.USER;

const docs = parityV1.loadFixture();
const idOrder = [...docs.map((d) => d.id)].sort();

describe('the app and the harness produce identical results for the same corpus', () => {
  test('byte-identical: app path vs harness path', async () => {
    const app = await parityApp.runApp(docs, { order: idOrder });
    const harness = parityApp.runHarness(docs);
    const appText = parityApp.render(app, 'mini-corpus.jsonl');
    const harnessText = parityApp.render(harness, 'mini-corpus.jsonl');
    expect(appText).toBe(harnessText);
    expect(parityApp.sha256(appText)).toBe(parityApp.sha256(harnessText));
    // A fixture that produced no links would pass the equality above trivially.
    expect(appText.split('\n').filter((l) => l.startsWith('LINK')).length).toBeGreaterThan(200);
  });

  test('the corpora are the same corpus, by the stated definition', async () => {
    const app = await parityApp.runApp(docs, { order: idOrder });
    expect(noteCorpus.corpusDigest(app.corpus)).toBe(noteCorpus.corpusDigest(docs));
  });

  test('the committed evidence matches what the code produces now', () => {
    // Regenerated and compared, so drift fails here rather than surfacing when
    // a hash is quoted from it. §7.6's convention.
    const adapterFile = fs.readFileSync(path.join(EVIDENCE, 'app-adapter.txt'), 'utf8');
    const harnessFile = fs.readFileSync(path.join(EVIDENCE, 'app-harness.txt'), 'utf8');
    expect(adapterFile).toBe(harnessFile);
    expect(parityApp.render(parityApp.runHarness(docs), 'mini-corpus.jsonl')).toBe(harnessFile);
  });

  test('Phase 2.1\'s parity proof still holds — v1 is untouched by 4.1', () => {
    // The one committed artifact tying this repo's harness to the algorithm it
    // shipped. 4.1 edits no file it depends on, and this asserts that rather
    // than assuming it.
    const shipped = fs.readFileSync(path.join(EVIDENCE, 'v1-shipped.txt'), 'utf8');
    expect(parityApp.sha256(shipped)).toBe(
      '83f9e35e834b7e1f5422a1ffbbf61de90feb25aa7895632ee75c1daab35ecc5e'
    );
  });
});

describe('"the same corpus" is a definition that can fail', () => {
  // A digest that never differs would make every assertion above vacuous.

  test('a changed body, title or id moves the digest', () => {
    const base = noteCorpus.corpusDigest(docs);
    expect(noteCorpus.corpusDigest(docs.map((d, i) => (i === 3 ? { ...d, body: `${d.body} x` } : d)))).not.toBe(base);
    expect(noteCorpus.corpusDigest(docs.map((d, i) => (i === 3 ? { ...d, title: `${d.title} x` } : d)))).not.toBe(base);
    expect(noteCorpus.corpusDigest(docs.map((d, i) => (i === 3 ? { ...d, id: `${d.id}x` } : d)))).not.toBe(base);
  });

  test('a reordered corpus is a different corpus', () => {
    expect(noteCorpus.corpusDigest([...docs].reverse())).not.toBe(noteCorpus.corpusDigest(docs));
  });

  test('a field cannot forge a row boundary', () => {
    // The reason renderCorpus escapes rather than joining raw. Without it these
    // two corpora — one document whose title carries a tab, versus a title and
    // body split across the separator — would render to the same bytes.
    const a = [{ id: 'x', title: 'one\ttwo', body: 'b' }];
    const b = [{ id: 'x', title: 'one', body: 'two\tb' }];
    expect(noteCorpus.corpusDigest(a)).not.toBe(noteCorpus.corpusDigest(b));
    const c = [{ id: 'x', title: 'a\nLINK y', body: 'b' }];
    expect(noteCorpus.renderCorpus(c).split('\n')).toHaveLength(3); // header, one row, trailing
  });
});

describe('the ObjectId -> string conversion, mutation-checked', () => {
  test('an unstringified id is rejected at index time', () => {
    const oid = parityApp.fakeObjectId(docs[0].id);
    expect(() => retrieval.index(noteCorpus.APP_RETRIEVER, [{ id: oid, title: 'x', body: 'y' }])).toThrow(
      /must be a non-empty string/
    );
  });

  test('an unstringified id at QUERY time fails silently, which is why relatedNotes stringifies', async () => {
    // The failure worth the line of code. It is NOT self-retrieval — §7.3's two
    // mechanisms hold — it is a note that quietly stops having related notes,
    // inside an un-awaited background job with nothing to log.
    const app = await parityApp.runApp(docs, { order: idOrder });
    const oid = parityApp.fakeObjectId(docs[0].id);

    expect(noteCorpus.relatedNotes(app.handle, oid, 8)).toHaveLength(8);
    expect(app.handle._byId.has(oid)).toBe(false); // what the missing String() would test
    // And if the raw object reached search() instead, it throws — an ObjectId's
    // `.id` is a Buffer, not a string.
    expect(() => retrieval.search(app.handle, oid, 8)).toThrow(/non-empty id/);
  });

  test('a note that is not in the corpus gets no links rather than an exception', async () => {
    const app = await parityApp.runApp(docs, { order: idOrder });
    expect(noteCorpus.relatedNotes(app.handle, 'deleted-mid-flight', 8)).toEqual([]);
  });
});

describe('the adapter specifies what utils/corpus.js leaves unspecified', () => {
  test('the store return order does not change the app\'s output', async () => {
    // The opposite result to §7.6(B), and deliberately so: the same experiment
    // on shipped v1 changed 87 of 151 lines, including which documents came
    // back. This is what the .sort({_id: 1}) in the adapter buys.
    const asc = await parityApp.runApp(docs, { order: idOrder });
    const desc = await parityApp.runApp(docs, { order: [...idOrder].reverse() });
    expect(parityApp.render(desc, 'x')).toBe(parityApp.render(asc, 'x'));
  });

  test('above the limit, which documents form the corpus is specified', async () => {
    // §7.6(C)'s fixture, which utils/corpus.js still resolves two different
    // ways. 4.6 owns that; this asserts the adapter does not inherit it.
    const capDocs = parityV1.capFixture();
    const notes = capDocs.map((d) => ({ _id: d.id, user: USER, title: d.title, contentText: d.body }));
    const ids = notes.map((n) => n._id);

    setStore(new FakeNoteStore(notes, ids));
    const asc = await noteCorpus.loadNoteCorpus(USER);
    setStore(new FakeNoteStore(notes, [...ids].reverse()));
    const desc = await noteCorpus.loadNoteCorpus(USER);

    expect(asc).toHaveLength(noteCorpus.CORPUS_LIMIT);
    expect(capDocs.length).toBeGreaterThan(noteCorpus.CORPUS_LIMIT + 1);
    expect(noteCorpus.corpusDigest(desc)).toBe(noteCorpus.corpusDigest(asc));
  });

  test('the fake store really sorts, or the test above proves nothing', async () => {
    // A sort() that returned the builder unchanged would make every
    // order-independence assertion here vacuous.
    const notes = [
      { _id: 'c', user: USER, title: 'c', contentText: 'c' },
      { _id: 'a', user: USER, title: 'a', contentText: 'a' },
      { _id: 'b', user: USER, title: 'b', contentText: 'b' }
    ];
    setStore(new FakeNoteStore(notes, ['c', 'a', 'b']));
    expect((await noteCorpus.loadNoteCorpus(USER)).map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  test('sort is applied before limit, so it decides WHICH documents survive', async () => {
    // Backwards, this would silently change which 500 notes a large corpus
    // holds while still looking sorted.
    const notes = ['d', 'c', 'b', 'a'].map((id) => ({ _id: id, user: USER, title: id, contentText: id }));
    setStore(new FakeNoteStore(notes, ['d', 'c', 'b', 'a']));
    expect((await noteCorpus.loadNoteCorpus(USER, { limit: 2 })).map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('the boundary holds in the direction Phase 2.1 requires', () => {
  test('nothing under backend/retrieval/ knows the adapter exists', () => {
    // tests/retrieval.interface.test.js proves retrieval requires nothing
    // outside itself. This proves the weaker-but-different thing the 4.1
    // architecture rests on: the arrow points app -> retrieval and the
    // retrieval layer carries no reference back, not even in a comment that
    // would invite one.
    const dir = path.join(__dirname, '..', 'retrieval');
    const offenders = [];
    (function walk(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && /require\([^)]*(services|models|routes)\//.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(dir, full));
        }
      }
    })(dir);
    expect(offenders).toEqual([]);
  });

  test('the adapter reaches retrieval through the public entry point only', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'noteCorpus.service.js'), 'utf8');
    // Importing a rung directly would let the app skip index.js — which owns
    // self-retrieval exclusion, the ordering and the postconditions (§7.3).
    expect(source).toMatch(/require\('\.\.\/retrieval'\)/);
    expect(source).not.toMatch(/require\('\.\.\/retrieval\//);
  });
});

describe('what the adapter does and does not read from a Note', () => {
  test('all three historical content shapes arrive as contentText', async () => {
    // normalizeContent() and blockNoteToPlainText() are upstream: routes/
    // notes.js derives contentText at write time and FROZEN.md keeps that path
    // untouched. The adapter never calls either.
    const shaped = [
      { _id: 'blocks', user: USER, title: 't1', contentText: 'sear the steak', content: [{ type: 'p', content: [{ text: 'sear the steak' }] }] },
      { _id: 'quill', user: USER, title: 't2', contentText: 'brine the turkey', content: { ops: [{ insert: 'brine the turkey' }] } },
      { _id: 'string', user: USER, title: 't3', contentText: 'proof the dough', content: { text: 'proof the dough' } }
    ];
    setStore(new FakeNoteStore(shaped, ['blocks', 'quill', 'string']));
    const corpus = await noteCorpus.loadNoteCorpus(USER);
    expect(corpus.map((d) => d.body)).toEqual(['sear the steak', 'brine the turkey', 'proof the dough']);
  });

  test('a note with no contentText is empty rather than an error', async () => {
    // The pre-existing gap: routes/notes.js POST stores `contentText:
    // req.body.contentText || ''` without deriving it. Such a note was already
    // empty to extractKeywords via loadUserCorpus. 4.1 neither causes nor fixes
    // it; this pins the behaviour so a later fix is a visible change.
    setStore(new FakeNoteStore([{ _id: 'n', user: USER, title: 'has a title', content: { ops: [{ insert: 'never normalised' }] } }], ['n']));
    expect(await noteCorpus.loadNoteCorpus(USER)).toEqual([{ id: 'n', title: 'has a title', body: '' }]);
  });

  test('a missing title is empty rather than undefined', async () => {
    setStore(new FakeNoteStore([{ _id: 'n', user: USER, contentText: 'body only' }], ['n']));
    expect(noteCorpus.toCorpusDoc({ _id: 'n', contentText: 'body only' })).toEqual({ id: 'n', title: '', body: 'body only' });
  });
});

describe('what the linker now stores', () => {
  test('strength is the raw retriever score and sharedKeywords is empty', async () => {
    // The field meanings changed at 4.1 and nothing in the schema records it.
    // strength was an overlap coefficient in [0,1]; it is now a BM25 score,
    // unbounded above. sharedKeywords has no source because v4 explains a hit
    // with a COUNT (§17.12). Pinned here so a silent revert is a failing test.
    const { computeAndSaveLinks } = require('../services/linker.service');
    setStore(new FakeNoteStore(parityApp.asNotes(docs), idOrder));
    const links = await computeAndSaveLinks(docs[0].id, USER);

    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(noteCorpus.LINK_CAP);
    expect(links.some((l) => l.strength > 1)).toBe(true); // not a [0,1] coefficient any more
    expect(links.every((l) => l.strength >= 0)).toBe(true); // Note.linkedNotes.strength has min: 0
    expect(links.every((l) => Array.isArray(l.sharedKeywords) && l.sharedKeywords.length === 0)).toBe(true);
    // Descending, so LinkedNotesPanel's rank-based badge reads a real ordering.
    expect(links.map((l) => l.strength)).toEqual([...links.map((l) => l.strength)].sort((a, b) => b - a));
  });

  test('the linker returns [] for a note that is not the user\'s', async () => {
    const { computeAndSaveLinks } = require('../services/linker.service');
    setStore(new FakeNoteStore(parityApp.asNotes(docs), idOrder));
    expect(await computeAndSaveLinks(docs[0].id, 'somebody-else')).toEqual([]);
  });
});
