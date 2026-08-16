'use strict';

/**
 * Retriever provenance on every edge (Phase 4.3).
 *
 * WHAT THIS CAN AND CANNOT SHOW, on the same split 4.2 established. These run
 * on scripts/lib/fake-note-store.js, which simulates NO index, so they cover
 * what is WRITTEN and what a query RETURNS — and they cannot show that the two
 * new indexes are USED, because a filter that scans every row returns the same
 * answer. Index selection is scripts/verify-migration.js (shape) and
 * scripts/measure-provenance-query.js (cost), both against a real server.
 *
 * EVERY ASSERTION HERE WAS CHECKED BY BREAKING THE CODE IT GUARDS. §22.6 found
 * two checks in this repo whose passing condition was too weak to distinguish
 * the states they existed to distinguish, and named that nothing looks for the
 * pattern systematically. Nothing here is that mechanism. What it is instead is
 * the local discipline the repo already uses in edges.canonical.test.js — which
 * asserts the PRESERVED PRE-4.1 LINKER FAILS the canonical check, so the
 * property is demonstrated rather than announced — applied deliberately: where
 * a claim has a negative case, the negative case is asserted too.
 */

jest.mock('../models/Note', () => require('../scripts/lib/fake-note-store').FakeNote);
jest.mock('../models/NoteLink', () => require('../scripts/lib/fake-note-store').FakeNoteLink);

const path = require('path');

const parityV1 = require('../scripts/parity-v1');
const parityApp = require('../scripts/parity-app');
const retrieval = require('../retrieval');
const notePair = require('../utils/notePair');
const { FakeNoteStore, setStore, linkRows, setLinkRows, resetOps, totalOps } = require('../scripts/lib/fake-note-store');
const { computeAndSaveLinks, getLinkedNotes, edgesForVersion } = require('../services/linker.service');

const USER = parityApp.USER;
const docs = parityV1.loadFixture();
const idOrder = [...docs.map((d) => d.id)].sort();

const seed = () => setStore(new FakeNoteStore(parityApp.asNotes(docs), idOrder));

/** The shape every registered rung's version string satisfies. */
const RUNG_SHAPE = /^v\d+-[a-z0-9]+$/;

describe('the recorded unknown is not a version, and that is checked twice', () => {
  test('it is not a registered retriever', () => {
    expect(retrieval.versions()).not.toContain(notePair.UNKNOWN_PROVENANCE);
  });

  test('it fails the shape every rung satisfies — and the shape is not vacuous', () => {
    // The second half is the point. A regex that matched nothing would make the
    // first assertion pass for the wrong reason, which is exactly the "too weak
    // to fail" family §22.6 names. So the same regex is asserted to ACCEPT all
    // six registered versions before it is trusted to reject the sentinel.
    const versions = retrieval.versions();
    expect(versions.length).toBeGreaterThanOrEqual(6);
    for (const version of versions) expect(version).toMatch(RUNG_SHAPE);
    expect(notePair.UNKNOWN_PROVENANCE).not.toMatch(RUNG_SHAPE);
  });

  test('it is one constant, reachable without mongoose', () => {
    // utils/notePair.js is the shared home precisely so the migration, the
    // model, the linker and the harness cannot spell it four ways.
    expect(require('../models/NoteLink').UNKNOWN_PROVENANCE).toBe(notePair.UNKNOWN_PROVENANCE);
    expect(typeof notePair.UNKNOWN_PROVENANCE).toBe('string');
  });
});

describe('provenance is per-direction', () => {
  test('directionFields maps both provenance fields, and the reverse pointers too', () => {
    expect(notePair.directionFields(true).retriever).toBe('retrieverAB');
    expect(notePair.directionFields(true).digest).toBe('digestAB');
    expect(notePair.directionFields(false).retriever).toBe('retrieverBA');
    expect(notePair.directionFields(false).digest).toBe('digestBA');
    // The $setOnInsert pointers: getting these wrong is how a fresh row ends up
    // with the wrong direction seeded.
    expect(notePair.directionFields(true).reverseRetriever).toBe('retrieverBA');
    expect(notePair.directionFields(false).reverseRetriever).toBe('retrieverAB');
  });

  test('a row can hold a real label in one direction and a recorded unknown in the other', () => {
    // The case a single retrieverVersion per row CANNOT describe, and the whole
    // argument for answering 4.2's question differently at 4.3.
    const row = {
      scoreAB: 11.3, retrieverAB: 'v4-bm25', digestAB: 'ba72e199',
      scoreBA: 0.42, retrieverBA: notePair.UNKNOWN_PROVENANCE, digestBA: notePair.UNKNOWN_PROVENANCE
    };
    expect(notePair.weightProvenance(row)).toEqual({
      weight: 11.3, direction: 'AB', retriever: 'v4-bm25', digest: 'ba72e199'
    });
  });
});

describe('the derived weight now says where it came from', () => {
  test('it reports the provenance of the direction it picked, not the row\'s', () => {
    const row = {
      scoreAB: 3, retrieverAB: 'v1-overlap', digestAB: 'aaa',
      scoreBA: 7, retrieverBA: 'v4-bm25', digestBA: 'bbb'
    };
    const wp = notePair.weightProvenance(row);
    expect(wp.weight).toBe(7);
    expect(wp.direction).toBe('BA');
    expect(wp.retriever).toBe('v4-bm25');
    // ...and NOT the other direction's, which is the mistake this exists to
    // prevent: a number from one side labelled from the other.
    expect(wp.retriever).not.toBe('v1-overlap');
  });

  test('it agrees with weight(), which is deliberately unchanged', () => {
    const rows = [
      { scoreAB: 3, scoreBA: 7 },
      { scoreAB: 7, scoreBA: 3 },
      { scoreAB: 3, scoreBA: null },
      { scoreAB: null, scoreBA: 3 },
      { scoreAB: 0, scoreBA: null }
    ];
    for (const row of rows) expect(notePair.weightProvenance(row).weight).toBe(notePair.weight(row));
  });

  test('null when nothing is observed, exactly as weight() is', () => {
    expect(notePair.weightProvenance({ scoreAB: null, scoreBA: null })).toBeNull();
    expect(notePair.weight({ scoreAB: null, scoreBA: null })).toBeNull();
  });

  test('an unlabelled direction reports null rather than inventing a label', () => {
    expect(notePair.weightProvenance({ scoreAB: 5, scoreBA: null }))
      .toEqual({ weight: 5, direction: 'AB', retriever: null, digest: null });
  });

  test('ties go to AB — arbitrary, and therefore pinned', () => {
    const row = { scoreAB: 4, retrieverAB: 'v4-bm25', scoreBA: 4, retrieverBA: 'v1-overlap' };
    expect(notePair.weightProvenance(row).direction).toBe('AB');
  });
});

describe('what the linker stamps on an edge', () => {
  test('the source direction carries the version AND the digest', async () => {
    seed();
    const links = await computeAndSaveLinks(docs[0].id, USER);
    const rows = linkRows();

    for (const link of links) {
      const { noteA, noteB, forward } = notePair.canonicalPair(docs[0].id, link.noteId);
      const f = notePair.directionFields(forward);
      const row = rows.find((r) => String(r.noteA) === String(noteA) && String(r.noteB) === String(noteB));
      expect(row[f.retriever]).toBe('v4-bm25');
      expect(row[f.digest]).toMatch(/^[0-9a-f]{64}$/);
      // The direction nobody has written is seeded null, not left undefined and
      // not given the writer's label.
      expect(row[f.reverseRetriever]).toBeNull();
      expect(row[f.reverseDigest]).toBeNull();
    }
  });

  test('the digest is describe(handle).digest, and a version string alone would not carry it', async () => {
    seed();
    await computeAndSaveLinks(docs[0].id, USER);
    const stored = linkRows()[0];
    const digest = stored.digestAB ?? stored.digestBA;

    const live = retrieval.describe(retrieval.index('v4-bm25', docs.map((d) => ({
      id: d.id, title: d.title || '', body: d.body || ''
    })), {}));
    expect(digest).toBe(live.digest);

    // The distinction the digest exists for: same version, different params,
    // different identity. §13 and §16.8's sweeps are about exactly this.
    const swept = retrieval.describe(retrieval.index('v4-bm25', docs.map((d) => ({
      id: d.id, title: d.title || '', body: d.body || ''
    })), { k1: 2.0 }));
    expect(swept.version).toBe(live.version);
    expect(swept.digest).not.toBe(live.digest);
  });

  test('the stored digest matches the COMMITTED v4-bm25 ladder sidecar', async () => {
    // What this buys: an app edge and a committed ladder run are joinable on one
    // key. What it does NOT buy: any claim that the corpora match — docCount is
    // deliberately not in the digest, so a 34-document fixture and the 27,325-
    // document ladder corpus hash identically. §12.2 and §21.8 are untouched.
    seed();
    await computeAndSaveLinks(docs[0].id, USER);
    const stored = linkRows()[0];
    const sidecar = require(path.join(__dirname, '..', '..', 'results', 'runs', 'v4-bm25.test.run.json'));
    expect(stored.digestAB ?? stored.digestBA).toBe(sidecar.retriever.digest);
    expect(sidecar.retriever.docCount).not.toBe(docs.length);
  });

  test('clearing a direction clears its label with it', async () => {
    seed();
    const source = docs[0].id;
    const current = new Set((await computeAndSaveLinks(source, USER)).map((l) => String(l.noteId)));
    const stale = docs.find((d) => d.id !== source && !current.has(d.id));
    expect(stale).toBeDefined();

    const { noteA, noteB, forward } = notePair.canonicalPair(source, stale.id);
    const f = notePair.directionFields(forward);
    // A stale edge the partner still claims, so the row survives the clear and
    // its cleared direction can be inspected.
    setLinkRows([{
      user: USER, noteA, noteB, sharedAB: [], sharedBA: [],
      [f.score]: 99, [f.retriever]: 'v1-overlap', [f.digest]: 'stale-digest',
      [f.reverseScore]: 42, [f.reverseRetriever]: 'v4-bm25', [f.reverseDigest]: 'kept'
    }]);

    await computeAndSaveLinks(source, USER);
    const row = linkRows().find((r) => `${r.noteA}|${r.noteB}` === `${noteA}|${noteB}`);

    // A label for a score that is not there records where a missing value came
    // from, which is worse than recording nothing.
    expect(row[f.score]).toBeNull();
    expect(row[f.retriever]).toBeNull();
    expect(row[f.digest]).toBeNull();
    // The partner's direction is untouched — label included.
    expect(row[f.reverseScore]).toBe(42);
    expect(row[f.reverseRetriever]).toBe('v4-bm25');
  });

  test('re-saving overwrites the label alongside the score it explains', async () => {
    seed();
    const source = docs[0].id;
    const links = await computeAndSaveLinks(source, USER);
    const partner = links[0].noteId;
    const { noteA, noteB, forward } = notePair.canonicalPair(source, partner);
    const f = notePair.directionFields(forward);

    // Plant a foreign label on the source's own direction, as a migrated row
    // would carry, then re-save.
    const rows = linkRows();
    const planted = rows.find((r) => `${r.noteA}|${r.noteB}` === `${noteA}|${noteB}`);
    planted[f.retriever] = notePair.UNKNOWN_PROVENANCE;
    planted[f.digest] = notePair.UNKNOWN_PROVENANCE;
    setLinkRows(rows);

    await computeAndSaveLinks(source, USER);
    const after = linkRows().find((r) => `${r.noteA}|${r.noteB}` === `${noteA}|${noteB}`);
    expect(after[f.retriever]).toBe('v4-bm25');
    expect(after[f.digest]).not.toBe(notePair.UNKNOWN_PROVENANCE);
  });

  test('provenance costs no extra round trip — still three operations', async () => {
    // Countable from code and asserted anyway, because "it rides in the existing
    // $set" is the kind of claim that stops being true when someone adds a
    // second update. results/write-cost.txt is the artifact.
    seed();
    for (const doc of docs.slice(0, 5)) {
      resetOps();
      await computeAndSaveLinks(doc.id, USER);
      expect(totalOps()).toBe(3);
    }
  });
});

describe('the read path carries the label beside the number it explains', () => {
  test('strength and retriever come from the SAME direction', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    const links = await getLinkedNotes(docs[0].id, USER);

    const out = links.filter((l) => l.direction === 'out');
    const incoming = links.filter((l) => l.direction === 'in');
    expect(out.length).toBeGreaterThan(0);
    expect(incoming.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.retriever).toBe('v4-bm25');
      expect(link.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('an unlabelled edge reads back as null rather than as a version', async () => {
    // What a migrated row looks like through the UI's read path before 002 runs.
    seed();
    setLinkRows([{
      user: USER, noteA: idOrder[0], noteB: idOrder[1],
      scoreAB: 5, scoreBA: null, sharedAB: [], sharedBA: []
    }]);
    const [link] = await getLinkedNotes(idOrder[0], USER);
    expect(link.strength).toBe(5);
    expect(link.retriever).toBeNull();
    expect(link.digest).toBeNull();
  });

  test('the response shape LinkedNotesPanel reads is unchanged, only widened', async () => {
    seed();
    await computeAndSaveLinks(docs[0].id, USER);
    const [link] = await getLinkedNotes(docs[0].id, USER);
    for (const key of ['noteId', 'strength', 'sharedKeywords', 'direction']) {
      expect(link).toHaveProperty(key);
    }
    expect(typeof link.strength).toBe('number');
    expect(Array.isArray(link.sharedKeywords)).toBe(true);
  });
});

describe('the edge set for a given version — 4.3\'s Done criterion', () => {
  test('returns the rows a version wrote, and names WHICH directions matched', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);

    const found = await edgesForVersion(USER, 'v4-bm25');
    expect(found.length).toBe(linkRows().length);
    expect(found.every((e) => e.matched.length > 0)).toBe(true);
    // Two-sided rows match on both directions; one-sided rows on one. That the
    // answer distinguishes them is the content of "per-direction".
    expect(found.some((e) => e.matched.length === 2)).toBe(true);
    expect(found.some((e) => e.matched.length === 1)).toBe(true);
  });

  test('a version nothing wrote returns the empty set, not everything', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    expect(await edgesForVersion(USER, 'v5-embeddings')).toEqual([]);
  });

  test('a MIXED row appears in both versions\' answers, and that is not a bug', async () => {
    // The honest content of the criterion: the query returns (row, direction)
    // pairs and not edges, because a row is not single-version. A per-row
    // retrieverVersion would have had to pick one and be wrong about the other.
    seed();
    await computeAndSaveLinks(docs[0].id, USER);
    const rows = linkRows();
    const target = rows[0];
    const side = target.scoreAB !== null ? 'AB' : 'BA';
    const other = side === 'AB' ? 'BA' : 'AB';
    target[`score${other}`] = 0.42;
    target[`retriever${other}`] = notePair.UNKNOWN_PROVENANCE;
    target[`digest${other}`] = notePair.UNKNOWN_PROVENANCE;
    setLinkRows(rows);

    const live = await edgesForVersion(USER, 'v4-bm25');
    const unknown = await edgesForVersion(USER, notePair.UNKNOWN_PROVENANCE);
    const key = (e) => `${e.noteA}|${e.noteB}`;

    expect(live.map(key)).toContain(key(target));
    expect(unknown.map(key)).toEqual([key(target)]);
    expect(live.find((e) => key(e) === key(target)).matched).toEqual([side]);
    expect(unknown[0].matched).toEqual([other]);
  });

  test('one user cannot see another user\'s edges through the version query', async () => {
    seed();
    for (const doc of docs) await computeAndSaveLinks(doc.id, USER);
    expect(await edgesForVersion('somebody-else', 'v4-bm25')).toEqual([]);
  });
});

describe('what 002 would label — the diff, which is what makes it idempotent', () => {
  // WHAT THIS DOES AND DOES NOT COVER, because the boundary is the point.
  // unlabelled() is a pure function over rows: it is the SELECTION that makes a
  // second run a no-op, and it is testable here. It is NOT the migration —
  // whether the server then reports zero operations, and whether updatedAt
  // survives `timestamps: true`, are statements about a database and are
  // scripts/verify-migration.js's, which needs Docker and is not in `npm test`.
  //
  // This block exists because a mutation check found the gap: breaking the diff
  // so 002 re-labels unconditionally was caught by NOTHING in the suite. That
  // is 4.2's noticed-list item arriving for a second constraint, and this closes
  // the half of it that does not need a server.
  const { unlabelled } = require('../migrations/002-edge-provenance');

  const row = (fields) => ({ user: 'u', noteA: 'a', noteB: 'b', scoreAB: null, scoreBA: null, ...fields });

  test('an observed direction with no label is selected', () => {
    expect(unlabelled([row({ scoreAB: 1 })])).toHaveLength(1);
    expect(unlabelled([row({ scoreAB: 1 })])[0].dir.side).toBe('AB');
  });

  test('an ALREADY-LABELLED direction is not selected — this is the idempotence', () => {
    expect(unlabelled([row({ scoreAB: 1, retrieverAB: notePair.UNKNOWN_PROVENANCE })])).toEqual([]);
    expect(unlabelled([row({ scoreAB: 1, retrieverAB: 'v4-bm25' })])).toEqual([]);
  });

  test('an UNOBSERVED direction is not selected — no label for a missing number', () => {
    expect(unlabelled([row({ scoreAB: null, scoreBA: 2 })]).map((x) => x.dir.side)).toEqual(['BA']);
  });

  test('a score of zero is an observation and does get labelled', () => {
    // The same distinction default:null exists for on the score fields. Treating
    // 0 as absent would leave a real edge permanently unlabelled.
    expect(unlabelled([row({ scoreAB: 0 })])).toHaveLength(1);
  });

  test('a half-migrated row selects only the direction that needs it', () => {
    const mixed = row({ scoreAB: 1, retrieverAB: 'v4-bm25', scoreBA: 2 });
    expect(unlabelled([mixed]).map((x) => x.dir.side)).toEqual(['BA']);
  });
});

describe('the paired-kind invariant, on the real model', () => {
  // The real mongoose model, not the fake — the hook under test is the model's.
  // No connection is needed: validate() is a document-level operation.
  const RealNoteLink = jest.requireActual('../models/NoteLink');
  const A = '0000000000000000000000aa';
  const B = '0000000000000000000000bb';

  const validate = (fields) => new RealNoteLink({
    user: '000000000000000000000001', noteA: A, noteB: B, ...fields
  }).validate();

  test('both real is accepted', async () => {
    await expect(validate({ scoreAB: 1, retrieverAB: 'v4-bm25', digestAB: 'ba72e199' })).resolves.toBeUndefined();
  });

  test('both the recorded unknown is accepted', async () => {
    await expect(validate({
      scoreAB: 1, retrieverAB: notePair.UNKNOWN_PROVENANCE, digestAB: notePair.UNKNOWN_PROVENANCE
    })).resolves.toBeUndefined();
  });

  test('both absent is accepted — that is a 4.2 row, and it is a legal state', async () => {
    // Deliberately NOT rejected. "An observed score carries a label" is true
    // after 002 and false before it, and false in a state the system passes
    // through on purpose. It is checked as a query in the migration instead.
    await expect(validate({ scoreAB: 1 })).resolves.toBeUndefined();
  });

  test('a real version beside an unknown digest is refused', async () => {
    await expect(validate({
      scoreAB: 1, retrieverAB: 'v4-bm25', digestAB: notePair.UNKNOWN_PROVENANCE
    })).rejects.toThrow(/must agree in kind/);
  });

  test('a real version beside a missing digest is refused', async () => {
    await expect(validate({ scoreAB: 1, retrieverAB: 'v4-bm25' })).rejects.toThrow(/must agree in kind/);
  });

  test('the other direction is checked too, not just AB', async () => {
    await expect(validate({ scoreBA: 1, retrieverBA: 'v4-bm25' })).rejects.toThrow(/retrieverBA and digestBA/);
  });

  test('the canonical-order check still fires first and unchanged', async () => {
    await expect(new RealNoteLink({
      user: '000000000000000000000001', noteA: B, noteB: A
    }).validate()).rejects.toThrow(/must sort before/);
  });
});
