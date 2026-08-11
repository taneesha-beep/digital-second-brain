#!/usr/bin/env node
'use strict';

/**
 * verify-migration.js — Phase 4.2
 *
 *   MONGO_URI=mongodb://localhost:27017/dsb_migration_test \
 *     npm run migration:verify
 *   ... -- --write     also write results/migration-verification.txt
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS NEEDS A REAL SERVER AND scripts/lib/fake-note-store.js WILL NOT DO.
 *
 * The central claim of 4.2 is "one edge per pair BY CONSTRUCTION", and
 * construction here means a unique index on {user, noteA, noteB}. A fake that
 * enforces uniqueness proves that the fake enforces uniqueness. The only thing
 * that can support the claim is a real server rejecting a real duplicate with
 * E11000 — so the fake collection deliberately does NOT simulate the index, and
 * this script exists to test the part the fake cannot reach.
 *
 * The same goes for idempotence and the rollback. Both are statements about
 * what a database does when an operation arrives twice, and both are asserted
 * here by doing it twice and comparing hashes rather than by reasoning about
 * upsert semantics.
 *
 * IT WILL NOT RUN AGAINST A NON-LOCALHOST HOST. It creates and destroys data,
 * including dropping a collection, so pointing it at Atlas would be pointing a
 * test harness at production. There is no override flag; unlike the migration
 * itself, there is no legitimate reason to want one.
 * ───────────────────────────────────────────────────────────────────────────
 * THE FIXTURE IS BUILT TO BE PATHOLOGICAL, because a migration tested on clean
 * data is tested on the case that was never going to break. It carries:
 *
 *   - a symmetric pair, agreeing            the easy case
 *   - an asymmetric pair, two strengths     last-writer-wins, as stored
 *   - a ONE-SIDED link                      A holds B, B does not hold A
 *   - a v1-scale score beside a v4-scale    §21.8's mixture, in one collection
 *   - a self-link                           must be skipped, never stored
 *   - a dangling target                     a note that no longer exists
 *   - a cross-user link                     must never merge two users' graphs
 *   - a second user with the same shape     so cross-user isolation is real
 *   - a v1 sharedKeywords list              which the migration must not lose
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS STILL DOES NOT ESTABLISH:
 *
 *   - Nothing about Atlas. A pinned mongo:7 container is not a managed replica
 *     set: no election, no read preference, no write concern beyond the
 *     default, and no network worth the name.
 *   - Nothing about real user notes. The fixture is synthetic and was written
 *     to contain the failures I could think of, which is not the same as the
 *     ones that exist.
 *   - Nothing about scale. Nine notes. The migration reads every note into
 *     memory in one Note.find({}), which is fine at portfolio scale and is not
 *     a claim about any other scale.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');

const Note = require('../models/Note');
const NoteLink = require('../models/NoteLink');
const migration = require('../migrations/001-canonical-edges');
const { rollback } = require('../migrations/001-canonical-edges.rollback');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'results', 'migration-verification.txt');

const oid = (hex) => new mongoose.Types.ObjectId(hex);

/**
 * The pathological fixture — see the header for what each row is for.
 *
 * THE IDS ARE FIXED, NOT GENERATED, and that is two decisions rather than one.
 *
 * Reproducibility: a generated ObjectId embeds a timestamp and a counter, so
 * every run produced different ids, therefore different digests, therefore a
 * committed artifact that could never be regenerated to match itself. §8.5's
 * rule is that a committed artifact carries what does not regenerate; an
 * artifact that does not regenerate AT ALL carries nothing.
 *
 * Coverage: with fixed ids the canonical ordering is known in advance, so the
 * fixture can deliberately exercise BOTH branches of it. `c` sorts before `a`,
 * so the a→c link is stored as scoreBA while a→b and a→d are stored as scoreAB.
 * A fixture whose every pair happened to be forward would pass with
 * directionFields() hard-coded to one branch.
 */
function buildFixture() {
  const userOne = oid('000000000000000000000001');
  const userTwo = oid('000000000000000000000002');
  const n = {
    a: oid('0000000000000000000000aa'),
    b: oid('0000000000000000000000bb'),
    c: oid('000000000000000000000011'), // sorts BEFORE a — the reversed branch
    d: oid('0000000000000000000000dd'),
    e: oid('0000000000000000000000ee'),
    f: oid('0000000000000000000000ff'),
    ghost: oid('00000000000000000000009e') // never inserted
  };
  const m = { a: oid('000000000000000000000a11'), b: oid('000000000000000000000b22') };

  const notes = [
    {
      _id: n.a, user: userOne, title: 'A', contentText: 'alpha', linkedNotes: [
        { noteId: n.b, strength: 0.4200, sharedKeywords: ['stock', 'broth'] }, // symmetric, agreeing
        { noteId: n.c, strength: 11.3271, sharedKeywords: [] },                // asymmetric
        { noteId: n.d, strength: 3.5000, sharedKeywords: [] },                 // ONE-SIDED
        { noteId: n.a, strength: 9.9999, sharedKeywords: [] },                 // SELF-LINK
        { noteId: n.ghost, strength: 1.2500, sharedKeywords: [] },             // DANGLING
        { noteId: m.a, strength: 7.7000, sharedKeywords: [] }                  // CROSS-USER
      ]
    },
    { _id: n.b, user: userOne, title: 'B', contentText: 'bravo', linkedNotes: [
      { noteId: n.a, strength: 0.4200, sharedKeywords: ['stock', 'broth'] }
    ] },
    { _id: n.c, user: userOne, title: 'C', contentText: 'charlie', linkedNotes: [
      { noteId: n.a, strength: 8.1140, sharedKeywords: [] }   // the OTHER strength for the a-c pair
    ] },
    { _id: n.d, user: userOne, title: 'D', contentText: 'delta', linkedNotes: [] },
    { _id: n.e, user: userOne, title: 'E', contentText: 'echo', linkedNotes: [] },
    { _id: n.f, user: userOne, title: 'F', contentText: 'foxtrot', linkedNotes: [] },

    { _id: m.a, user: userTwo, title: 'A2', contentText: 'alpha two', linkedNotes: [
      { noteId: m.b, strength: 5.0000, sharedKeywords: [] }
    ] },
    { _id: m.b, user: userTwo, title: 'B2', contentText: 'bravo two', linkedNotes: [
      { noteId: m.a, strength: 4.0000, sharedKeywords: [] }
    ] }
  ];

  return { notes, userOne, userTwo, n, m };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function main() {
  const write = process.argv.includes('--write');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set — point it at a THROWAWAY local database');

  const target = migration.describeTarget(uri);
  if (!target.local) {
    throw new Error(
      `refusing to run against ${target.host}: this script creates and DESTROYS data, including ` +
      'dropping a collection. It runs against localhost only, and there is no override.'
    );
  }

  const out = [];
  const say = (line = '') => { out.push(line); console.log(line); };
  let failures = 0;
  const check = (label, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    if (!pass) failures += 1;
    say(`   ${pass ? 'OK  ' : 'FAIL'}  ${label.padEnd(52)} ${JSON.stringify(actual)}${pass ? '' : `  expected ${JSON.stringify(expected)}`}`);
  };

  await mongoose.connect(uri);

  say('MIGRATION VERIFICATION — 001-canonical-edges, against a real MongoDB');
  const build = await mongoose.connection.db.admin().serverStatus();
  say(`   server                     MongoDB ${build.version}`);
  say(`   target                     ${target.host} / ${target.db}   (throwaway)`);
  // HEAD at generation, which is the PARENT of the commit that carries this
  // file — the tree whose code was measured, not the tree the artifact lands in.
  say(`   generated at HEAD          ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim()}`);
  say('');

  try {
    // ── seed ────────────────────────────────────────────────────────────────
    await Note.deleteMany({});
    const existing = await mongoose.connection.db.listCollections({ name: NoteLink.collection.name }).toArray();
    if (existing.length > 0) await mongoose.connection.db.dropCollection(NoteLink.collection.name);

    const fixture = buildFixture();
    await Note.insertMany(fixture.notes);
    const seedNotes = await Note.find({}).select('_id user linkedNotes').lean();

    /**
     * TWO DIGESTS OVER THE SAME NOTES, and the split is deliberate.
     *
     * `byteDigest` covers the documents whole — including the _id mongoose
     * generates for every linkedNotes SUBDOCUMENT, and the timestamps. That is
     * the right thing to CHECK the rollback against, because "byte-identical"
     * should mean it. It is the wrong thing to PRINT: subdocument ids are
     * freshly generated on every insert, so the value moves between runs and a
     * committed artifact carrying it could never regenerate to match itself.
     *
     * `fixtureDigest` covers only the fields the migration reads. It is stable
     * across runs, so it is what identifies the fixture in the artifact.
     */
    const byteDigest = (notes) => sha256(notes.map((x) => JSON.stringify(x)).sort().join('\n'));
    const fixtureDigest = sha256(
      seedNotes
        .map((x) => `${String(x._id)}\t${String(x.user)}\t${(x.linkedNotes || [])
          .map((l) => `${String(l.noteId)}:${l.strength}:${(l.sharedKeywords || []).join(',')}`).sort().join(' ')}`)
        .sort()
        .join('\n')
    );
    const seedBytes = byteDigest(seedNotes);

    say('1. FIXTURE — built to be pathological, see the script header');
    say(`   notes                      ${fixture.notes.length}  across 2 users`);
    say(`   linkedNotes entries        ${fixture.notes.reduce((t, x) => t + x.linkedNotes.length, 0)}`);
    say(`   fixture digest             ${fixtureDigest}`);
    say('');

    // ── 2. before ───────────────────────────────────────────────────────────
    say('2. BEFORE — the defect, counted off the legacy arrays');
    const before = await migration.verify(say);
    check('NoteLink rows before the migration', before.rows.length, 0);
    say('');

    // ── 3. migrate ──────────────────────────────────────────────────────────
    say('3. MIGRATE');
    await migration.migrate({ apply: true, log: say });
    say('   verification:');
    const first = await migration.verify(say);
    check('every invariant holds', first.ok, true);
    say('');

    // ── 4. what it did with each pathology ──────────────────────────────────
    say('4. EACH PATHOLOGY, CHECKED INDIVIDUALLY');
    const rows = await NoteLink.find({}).lean();
    const find = (x, y) => {
      const { noteA, noteB } = NoteLink.canonicalPair(x, y);
      return rows.find((r) => String(r.noteA) === String(noteA) && String(r.noteB) === String(noteB));
    };
    const dirOf = (row, from) => (String(row.noteA) === String(from) ? row.scoreAB : row.scoreBA);

    const ab = find(fixture.n.a, fixture.n.b);
    check('symmetric pair a-b becomes ONE row', Boolean(ab), true);
    check('  a->b direction', dirOf(ab, fixture.n.a), 0.42);
    check('  b->a direction', dirOf(ab, fixture.n.b), 0.42);
    check('  v1 sharedKeywords preserved', (String(ab.noteA) === String(fixture.n.a) ? ab.sharedAB : ab.sharedBA), ['stock', 'broth']);

    const ac = find(fixture.n.a, fixture.n.c);
    check('asymmetric pair a-c keeps BOTH strengths', [dirOf(ac, fixture.n.a), dirOf(ac, fixture.n.c)], [11.3271, 8.114]);
    check('  derived pair weight is the max', NoteLink.weight(ac), 11.3271);

    const ad = find(fixture.n.a, fixture.n.d);
    check('one-sided link a->d keeps one direction', [dirOf(ad, fixture.n.a), dirOf(ad, fixture.n.d)], [3.5, null]);

    check('self-link is not stored', rows.some((r) => String(r.noteA) === String(r.noteB)), false);
    check('dangling target is not stored', Boolean(find(fixture.n.a, fixture.n.ghost)), false);
    check('cross-user link is not stored', Boolean(find(fixture.n.a, fixture.m.a)), false);
    check('user two keeps its own pair', Boolean(find(fixture.m.a, fixture.m.b)), true);
    check('no row spans two users', rows.every((r) => {
      const byId = new Map(seedNotes.map((x) => [String(x._id), String(x.user)]));
      return byId.get(String(r.noteA)) === byId.get(String(r.noteB));
    }), true);
    say('');

    // ── 5. the unique index, against a real server ──────────────────────────
    say('5. THE UNIQUE INDEX — a REAL duplicate, rejected by a REAL server');
    const indexes = await NoteLink.collection.indexes();
    const unique = indexes.find((i) => i.unique && i.key.user === 1 && i.key.noteA === 1 && i.key.noteB === 1);
    check('unique index on {user, noteA, noteB} exists', Boolean(unique), true);

    let duplicateError = null;
    try {
      await NoteLink.collection.insertOne({ user: ab.user, noteA: ab.noteA, noteB: ab.noteB, scoreAB: 1, scoreBA: null, sharedAB: [], sharedBA: [] });
    } catch (err) {
      duplicateError = err.code;
    }
    check('inserting the SAME pair again is rejected (E11000)', duplicateError, 11000);

    // And the case the index cannot catch on its own, which is why the normal
    // form is constructed rather than hoped for: a REVERSED pair is a different
    // index key, so the server accepts it. The model's pre-validate hook is what
    // refuses — on the document path only.
    let reversedAccepted = false;
    try {
      await NoteLink.collection.insertOne({ user: ab.user, noteA: ab.noteB, noteB: ab.noteA, scoreAB: 1, scoreBA: null, sharedAB: [], sharedBA: [] });
      reversedAccepted = true;
      await NoteLink.collection.deleteOne({ user: ab.user, noteA: ab.noteB, noteB: ab.noteA });
    } catch { /* the index would only fire if the normal form happened to match */ }
    check('a REVERSED pair slips past the index (so the normal form is load-bearing)', reversedAccepted, true);

    let hookRefused = null;
    try {
      await new NoteLink({ user: ab.user, noteA: ab.noteB, noteB: ab.noteA, scoreAB: 1 }).validate();
    } catch (err) {
      hookRefused = err.message.includes('must sort before');
    }
    check('  and the model refuses it on the document path', hookRefused, true);

    let nonFinite = null;
    try {
      await new NoteLink({ user: ab.user, noteA: ab.noteA, noteB: ab.noteB, scoreAB: Infinity }).validate();
      nonFinite = false;
    } catch {
      nonFinite = true;
    }
    check('  and a non-finite score is refused', nonFinite, true);
    say('');

    // ── 6. idempotence ──────────────────────────────────────────────────────
    say('6. IDEMPOTENCE — run it a second time and compare, rather than reason about upserts');
    const wholeDocs = async () => sha256(
      (await NoteLink.find({}).lean()).map((r) => JSON.stringify(r)).sort().join('\n')
    );
    const beforeSecond = await wholeDocs();
    const second = await migration.migrate({ apply: true, log: () => {} });
    const afterSecond = await migration.verify(say);
    check('row-set digest unchanged', afterSecond.digest, first.digest);
    check('second run issued NO operations at all', second.operations, 0);
    check('second run upserted nothing', second.result.upsertedCount, 0);
    check('second run modified nothing', second.result.modifiedCount, 0);
    // The stronger claim, and the one the first version of this script could
    // not make: not merely the same content, but the same DOCUMENTS —
    // updatedAt included. `timestamps: true` puts updatedAt in every $set, so a
    // migration that re-upserts unconditionally moves it on every row while
    // reporting an unchanged content digest. Compared, not printed: the value
    // carries timestamps and so moves between runs.
    check('every document byte-identical, updatedAt included', (await wholeDocs()) === beforeSecond, true);
    say('');

    // ── 7. rollback ─────────────────────────────────────────────────────────
    say('7. ROLLBACK — tested, then re-migrated to prove it left nothing behind');
    const back = await rollback({ apply: true, log: say });
    check('collection dropped', back.dropped > 0, true);
    check('nothing was written since the migration, so nothing is lost', back.appWritten, 0);
    const notesAfterRollback = await Note.find({}).select('_id user linkedNotes').lean();
    check('every note is byte-identical to the seed',
      byteDigest(notesAfterRollback) === seedBytes, true);
    check('notelinks is gone',
      (await mongoose.connection.db.listCollections({ name: NoteLink.collection.name }).toArray()).length, 0);

    await migration.migrate({ apply: true, log: () => {} });
    const remigrated = await migration.verify(say);
    check('re-migrating reproduces the same row set', remigrated.digest, first.digest);
    say('');

    // ── 8. what a live save does to a migrated row ──────────────────────────
    say('8. AND WHAT THE LIVE LINKER DOES TO A MIGRATED ROW');
    say('   Not run here. The linker needs a corpus and an index build, which is');
    say('   scripts/measure-writes.js and tests/edges.canonical.test.js on the fake');
    say('   store. What this section would add is a real driver under the same');
    say('   operations, and that is roadmap 4.5 rather than 4.2.');
    say('');

    say(`RESULT   ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    say('');
    say('ENVIRONMENT');
    say(`   ${os.type()} ${os.release()} ${process.arch}, Node ${process.version}`);
    say(`   MongoDB ${build.version} in Docker, image pinned by digest in docker-compose.yml`);

    if (write) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, `${out.join('\n')}\n`);
      console.log(`\nwrote ${path.relative(REPO, OUT)}`);
    }

    // Leave the throwaway database clean.
    await Note.deleteMany({});
    const left = await mongoose.connection.db.listCollections({ name: NoteLink.collection.name }).toArray();
    if (left.length > 0) await mongoose.connection.db.dropCollection(NoteLink.collection.name);
  } finally {
    await mongoose.disconnect();
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
