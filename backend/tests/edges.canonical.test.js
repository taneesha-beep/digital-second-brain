'use strict';

/**
 * Canonical edge storage (Phase 4.2).
 *
 * WHAT IS AND IS NOT TESTED HERE, because the split is the whole design.
 *
 * These tests run on scripts/lib/fake-note-store.js, so they cover the SHAPE of
 * what the linker issues and the CONTENT of what it stores: the normal form,
 * the clear-then-upsert-then-delete order, the operation count, and — the
 * property 4.2 exists for — that a pair ends up in the same state regardless of
 * which note was saved last.
 *
 * They do NOT cover the unique index, and deliberately: a fake that enforces
 * uniqueness proves only that the fake enforces uniqueness. "One edge per pair
 * BY CONSTRUCTION" is a claim about a database constraint, and the only thing
 * that can support it is a real server rejecting a real duplicate with E11000.
 * That is scripts/verify-migration.js against a pinned mongo:7, and
 * results/migration-verification.txt is its output.
 *
 * Both models are mocked, not one. linker.service.js requires Note and NoteLink
 * at module scope, and substituting only the first leaves the second a real
 * mongoose model with no connection behind it.
 */

jest.mock('../models/Note', () => require('../scripts/lib/fake-note-store').FakeNote);
jest.mock('../models/NoteLink', () => require('../scripts/lib/fake-note-store').FakeNoteLink);

const parityV1 = require('../scripts/parity-v1');
const parityApp = require('../scripts/parity-app');
const notePair = require('../utils/notePair');
const { FakeNoteStore, setStore, linkRows, setLinkRows, resetOps, totalOps, opBreakdown } = require('../scripts/lib/fake-note-store');
const { computeAndSaveLinks, getLinkedNotes } = require('../services/linker.service');

const USER = parityApp.USER;
const docs = parityV1.loadFixture();
const idOrder = [...docs.map((d) => d.id)].sort();

const seed = () => setStore(new FakeNoteStore(parityApp.asNotes(docs), idOrder));
const pairKey = (x, y) => {
  const { noteA, noteB } = notePair.canonicalPair(x, y);
  return `${noteA}|${noteB}`;
};

describe('the normal form', () => {
  test('orders a pair the same way from either end', () => {
    expect(notePair.canonicalPair('b', 'a')).toEqual({ noteA: 'a', noteB: 'b', forward: false });
    expect(notePair.canonicalPair('a', 'b')).toEqual({ noteA: 'a', noteB: 'b', forward: true });
  });

  test('`forward` says which field holds the from->to direction', () => {
    expect(notePair.directionFields(true).score).toBe('scoreAB');
    expect(notePair.directionFields(false).score).toBe('scoreBA');
    // The reverse pointers matter as much: the linker's $setOnInsert uses them
    // to initialise the direction it is NOT writing.
    expect(notePair.directionFields(true).reverseScore).toBe('scoreBA');
    expect(notePair.directionFields(false).reverseScore).toBe('scoreAB');
  });

  test('a self-pair throws rather than producing a row', () => {
    // A self-edge reaching storage would mean retrieval/index.js's
    // self-retrieval exclusion had already failed. Storing it would hide that.
    expect(() => notePair.canonicalPair('a', 'a')).toThrow(/cannot link to itself/);
  });

  test('ids that are objects are compared by their string form', () => {
    const objectish = (hex) => ({ toString: () => hex });
    const pair = notePair.canonicalPair(objectish('bbb'), objectish('aaa'));
    expect(String(pair.noteA)).toBe('aaa');
    expect(pair.forward).toBe(false);
  });
});

describe('the derived pair weight', () => {
  test('is the max over the observed directions', () => {
    expect(notePair.weight({ scoreAB: 3, scoreBA: 7 })).toBe(7);
    expect(notePair.weight({ scoreAB: 7, scoreBA: 3 })).toBe(7);
  });

  test('a single observed direction is its own max', () => {
    expect(notePair.weight({ scoreAB: 3, scoreBA: null })).toBe(3);
    expect(notePair.weight({ scoreAB: null, scoreBA: 3 })).toBe(3);
  });

  test('null when nothing is observed — a row that should not exist', () => {
    expect(notePair.weight({ scoreAB: null, scoreBA: null })).toBeNull();
  });

  test('zero is an observation, not an absence', () => {
    // The distinction the schema's `default: null` exists for. A retriever that
    // scored a pair at exactly 0 said something; a pair nobody has scored has
    // not. Treating them alike would make max() over {0, null} ambiguous.
    expect(notePair.weight({ scoreAB: 0, scoreBA: null })).toBe(0);
  });
});

describe('what the linker writes', () => {
  test('one canonical row per pair, and the source direction carries the score', async () => {
    seed();
    const links = await computeAndSaveLinks(docs[0].id, USER);
    const rows = linkRows();

    expect(rows).toHaveLength(links.length);
    for (const link of links) {
      const { noteA, noteB, forward } = notePair.canonicalPair(docs[0].id, link.noteId);
      const row = rows.find((r) => String(r.noteA) === String(noteA) && String(r.noteB) === String(noteB));
      expect(row).toBeDefined();
      expect(row[notePair.directionFields(forward).score]).toBe(link.strength);
      expect(row[notePair.directionFields(forward).reverseScore]).toBeNull();
    }
  });

  test('every row is in the normal form', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    for (const row of linkRows()) expect(String(row.noteA) < String(row.noteB)).toBe(true);
  });

  test('no row is a self-edge and no pair appears twice', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    const rows = linkRows();
    const keys = rows.map((r) => `${r.noteA}|${r.noteB}`);
    expect(rows.every((r) => String(r.noteA) !== String(r.noteB))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a pair scored from both ends holds both scores', async () => {
    seed();
    const forward = await computeAndSaveLinks(docs[0].id, USER);
    const partner = forward[0].noteId;
    await computeAndSaveLinks(partner, USER);

    const row = linkRows().find((r) => `${r.noteA}|${r.noteB}` === pairKey(docs[0].id, partner));
    expect(row.scoreAB).not.toBeNull();
    expect(row.scoreBA).not.toBeNull();
  });

  test('v4 is asymmetric, so the two directions usually differ — measured, not assumed', async () => {
    // §14.5's amendment measures 190 of 197 reachable fixture pairs disagreeing
    // between directions. If this came out symmetric, the storage decision in
    // models/NoteLink.js would have no subject.
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    const both = linkRows().filter((r) => r.scoreAB !== null && r.scoreBA !== null);
    expect(both.length).toBeGreaterThan(0);
    expect(both.filter((r) => r.scoreAB !== r.scoreBA).length).toBeGreaterThan(both.length / 2);
  });
});

describe('save order no longer decides what is stored — the point of 4.2', () => {
  test('the final row set is identical under a reversed save order', async () => {
    const digest = (rows) =>
      rows
        .map((r) => `${r.noteA}|${r.noteB}|${r.scoreAB}|${r.scoreBA}`)
        .sort()
        .join('\n');

    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    const ascending = digest(linkRows());

    seed();
    for (const doc of [...docs].reverse()) await computeAndSaveLinks(doc.id, USER);
    const descending = digest(linkRows());

    expect(descending).toBe(ascending);
    expect(ascending.split('\n').length).toBeGreaterThan(50);
  });

  test('and the pre-4.2 storage did NOT have that property', async () => {
    // The claim above is only worth making if the thing it replaced failed it.
    // §7.6 quantified the old bidirectional write at 15 differing lines between
    // two store orderings; this asserts the direction of the difference rather
    // than the count, which is parity-v1.js's to report.
    const { computeAndSaveLinks: shipped } = require('../scripts/lib/linker-v1-shipped');
    const stored = (store) =>
      [...store.docs.values()]
        .map((d) => `${d._id} ${(d.linkedNotes || []).map((l) => `${l.noteId}:${l.strength}`).sort().join(',')}`)
        .sort()
        .join('\n');

    const runIn = async (order) => {
      const store = setStore(new FakeNoteStore(parityApp.asNotes(docs), idOrder));
      const { extractKeywords } = require('../utils/keywords');
      const { loadUserCorpus } = require('../utils/corpus');
      for (const id of store.order) {
        const note = store.raw(id);
        note.keywords = extractKeywords(note.title, note.contentText, await loadUserCorpus(USER, { excludeId: note._id }));
      }
      for (const id of order) await shipped(id, USER);
      return stored(store);
    };

    const ascending = await runIn(idOrder);
    const descending = await runIn([...idOrder].reverse());
    expect(descending).not.toBe(ascending);
  });
});

describe('a link the retriever no longer returns is removed', () => {
  test('a stale edge is cleared, and the emptied row is deleted', async () => {
    seed();
    const source = docs[0].id;

    // A partner the retriever demonstrably does NOT return for this source, so
    // the planted edge is genuinely stale rather than merely re-scored.
    const current = new Set((await computeAndSaveLinks(source, USER)).map((l) => String(l.noteId)));
    const stale = docs.find((d) => d.id !== source && !current.has(d.id));
    expect(stale).toBeDefined();

    const { noteA, noteB, forward } = notePair.canonicalPair(source, stale.id);
    const f = notePair.directionFields(forward);
    setLinkRows([{ user: USER, noteA, noteB, scoreAB: null, scoreBA: null, sharedAB: [], sharedBA: [], [f.score]: 99 }]);
    expect(linkRows()).toHaveLength(1);

    await computeAndSaveLinks(source, USER);

    // Nothing holds the pair any more — the source dropped it and the partner
    // never claimed it — so the row is gone rather than left at (null, null).
    expect(linkRows().some((r) => `${r.noteA}|${r.noteB}` === `${noteA}|${noteB}`)).toBe(false);
  });

  test('a stale edge the OTHER note still claims survives as a one-sided row', async () => {
    seed();
    const source = docs[0].id;
    const current = new Set((await computeAndSaveLinks(source, USER)).map((l) => String(l.noteId)));
    const stale = docs.find((d) => d.id !== source && !current.has(d.id));

    const { noteA, noteB, forward } = notePair.canonicalPair(source, stale.id);
    const f = notePair.directionFields(forward);
    // Both directions present: the source's (about to go stale) and the
    // partner's (which no save of the source may touch).
    setLinkRows([{
      user: USER, noteA, noteB, sharedAB: [], sharedBA: [],
      [f.score]: 99, [f.reverseScore]: 42
    }]);

    await computeAndSaveLinks(source, USER);

    const row = linkRows().find((r) => `${r.noteA}|${r.noteB}` === `${noteA}|${noteB}`);
    expect(row).toBeDefined();
    expect(row[f.score]).toBeNull();      // cleared
    expect(row[f.reverseScore]).toBe(42); // untouched
  });

  test("the other note's direction survives the clear", async () => {
    seed();
    const source = docs[0].id;
    const links = await computeAndSaveLinks(source, USER);
    const partner = links[0].noteId;
    await computeAndSaveLinks(partner, USER);

    // Now re-save the source. Its own direction is rewritten; the partner's
    // must be untouched, or the clear step is clearing too much.
    const before = linkRows().find((r) => `${r.noteA}|${r.noteB}` === pairKey(source, partner));
    const { forward } = notePair.canonicalPair(source, partner);
    const reverseField = notePair.directionFields(forward).reverseScore;
    const partnerScore = before[reverseField];

    await computeAndSaveLinks(source, USER);
    const after = linkRows().find((r) => `${r.noteA}|${r.noteB}` === pairKey(source, partner));
    expect(after[reverseField]).toBe(partnerScore);
  });

  test('rows with neither direction never survive a write', async () => {
    seed();
    setLinkRows([{ user: USER, noteA: '001', noteB: '002', scoreAB: null, scoreBA: null, sharedAB: [], sharedBA: [] }]);
    await computeAndSaveLinks(docs[0].id, USER);
    expect(linkRows().every((r) => r.scoreAB !== null || r.scoreBA !== null)).toBe(true);
  });
});

describe('the write cost', () => {
  test('three operations, whatever the link count', async () => {
    // The 4.2 Done criterion's second [MEASURED]. results/write-cost.txt is the
    // artifact; this is the regression guard, so a reintroduced per-link loop
    // fails a test rather than being found by re-reading a committed file —
    // §21.6's lesson, applied to a number instead of a hash.
    seed();
    for (const doc of docs.slice(0, 5)) {
      resetOps();
      const links = await computeAndSaveLinks(doc.id, USER);
      expect(links.length).toBeGreaterThan(0);
      expect(totalOps()).toBe(3);
      expect(Object.fromEntries(opBreakdown())).toEqual({ findOne: 1, find: 1, bulkWrite: 1 });
    }
  });

  test('one ordered bulkWrite, and unordered is refused', async () => {
    // Order is load-bearing: clear, then upsert, then delete. An unordered
    // batch could delete the rows it was about to write.
    const { FakeNoteLink } = require('../scripts/lib/fake-note-store');
    await expect(FakeNoteLink.bulkWrite([], { ordered: false })).rejects.toThrow(/only ordered/);
  });
});

describe('the read path', () => {
  test('returns the shape LinkedNotesPanel already reads', async () => {
    seed();
    await computeAndSaveLinks(docs[0].id, USER);
    const links = await getLinkedNotes(docs[0].id, USER);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveProperty('noteId');
      expect(typeof link.strength).toBe('number');
      expect(Array.isArray(link.sharedKeywords)).toBe(true);
      expect(link.noteId).toHaveProperty('title');
    }
  });

  test('outgoing links come first and are ordered by the note\'s OWN score', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    const links = await getLinkedNotes(docs[0].id, USER);

    const out = links.filter((l) => l.direction === 'out');
    const incoming = links.filter((l) => l.direction === 'in');
    expect(out.length).toBeGreaterThan(0);
    expect(links.slice(0, out.length).every((l) => l.direction === 'out')).toBe(true);
    expect(out.map((l) => l.strength)).toEqual([...out.map((l) => l.strength)].sort((a, b) => b - a));
    expect(incoming.map((l) => l.strength)).toEqual([...incoming.map((l) => l.strength)].sort((a, b) => b - a));
  });

  test("the outgoing order is exactly what the retriever returned", async () => {
    // This is what keeping two scores bought, and it is the reason a single
    // stored max/min/mean was rejected: any of those would re-sort this list by
    // a number partly determined by the other note.
    seed();
    const written = await computeAndSaveLinks(docs[0].id, USER);
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);

    const links = await getLinkedNotes(docs[0].id, USER);
    const out = links.filter((l) => l.direction === 'out').map((l) => String(l.noteId._id));
    expect(out).toEqual(written.map((l) => String(l.noteId)));
  });

  test('a note can end up with more links than the cap, and that is the union', async () => {
    // The stated cost of canonical storage: an edge set is "notes it ranked"
    // UNION "notes that ranked it". Not new — the pre-4.2 write pushed into the
    // target's array with no cap at all — but now it is deliberate.
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    const degrees = [];
    for (const doc of docs) degrees.push((await getLinkedNotes(doc.id, USER)).length);
    expect(Math.max(...degrees)).toBeGreaterThan(8);
  });

  test('one user cannot read another user\'s edges', async () => {
    seed();
    await computeAndSaveLinks(docs[0].id, USER);
    expect(await getLinkedNotes(docs[0].id, 'somebody-else')).toEqual([]);
  });

  test('an edge whose far endpoint has vanished is skipped, not returned as null', async () => {
    seed();
    setLinkRows([{ user: USER, noteA: '001', noteB: 'zzz-deleted', scoreAB: 5, scoreBA: null, sharedAB: [], sharedBA: [] }]);
    const links = await getLinkedNotes('001', USER);
    expect(links).toEqual([]);
  });
});
