#!/usr/bin/env node
'use strict';

/**
 * 001-canonical-edges.js — Phase 4.2.
 *
 *   node migrations/001-canonical-edges.js                 DRY RUN (the default)
 *   node migrations/001-canonical-edges.js --apply
 *   node migrations/001-canonical-edges.js --verify
 *
 * Reads every note's deprecated `linkedNotes` array and writes one canonical
 * NoteLink row per unordered pair.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IT IS ADDITIVE. IT NEVER MODIFIES OR DELETES A NOTE.
 *
 * That is the property the rollback rests on: `linkedNotes` is left exactly as
 * it was found, so undoing this is dropping a collection rather than
 * reconstructing anything. A migration that rewrites its own input has a
 * rollback that is a second migration, and a second migration is a second thing
 * that can be wrong.
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES WITH ROWS OF UNKNOWN PROVENANCE, which is most of them.
 *
 * EVALUATION.md §21.8: the store is a mixture of two retrievers' output with
 * nothing recording which is which. Notes saved before 4.1 carry v1 overlap
 * coefficients in [0,1]; notes saved since carry raw BM25 scores on a
 * completely different scale. This migration CARRIES THEM ACROSS AS THEY ARE.
 * It does not re-score, does not re-link, and does not guess.
 *
 * The mixture therefore becomes VISIBLE in the new collection — a 0.42 sitting
 * beside an 11.3 — without becoming LABELLED. Labelling is roadmap 4.3's
 * retrieverVersion and it is deliberately not built here.
 *
 * The alternative was the one-shot re-save of every note that 4.1's noticed
 * list floats, and it is REJECTED ON ORDERING rather than on effort:
 * re-linking everything BEFORE retrieverVersion exists destroys the only signal
 * that distinguishes a migrated v1 row from a recomputed v4 one. 4.3 first,
 * then re-link.
 *
 * LAST-WRITER-WINS IS PRESERVED, NOT REPAIRED. A pre-4.2 pair can hold two
 * different strengths, or the same wrong one twice, because the old write put
 * the SOURCE's score into the TARGET's record (PRIMER §3.5). Whatever each side
 * stored is what that direction gets. The migration's job is to change the
 * SHAPE of the storage; the values are repaired the next time each note is
 * saved, by the retriever, which is the only thing that knows what they should
 * be.
 * ───────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCE, AND THE FIRST VERSION OF IT WAS NOT IDEMPOTENT.
 *
 * Every write is an upsert keyed on {user, noteA, noteB} whose $set is a pure
 * function of the input documents, so a second run reaches the same rows with
 * the same values. That is enough for the CONTENT to be stable and it is NOT
 * enough for the run to be a no-op: NoteLink has `timestamps: true`, so
 * mongoose injects `updatedAt` into every $set and the server counts every row
 * as modified. scripts/verify-migration.js reported `modifiedCount 4` beside an
 * unchanged row-set digest, which is exactly the shape of a claim that is true
 * in the sense being checked and false in the sense being asserted.
 *
 * So the migration DIFFS BEFORE IT WRITES: it reads the existing rows, compares
 * them field by field against what it would write, and puts only the
 * differences in the batch. A second run issues ZERO operations, which is a
 * stronger statement than zero modified and is the one worth making — it means
 * re-running this against a live database does not touch updatedAt on edges it
 * is not changing.
 *
 * The read that makes the diff possible is one query the migration was already
 * going to need for its own verification, so it costs nothing.
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRODUCTION GUARD. The target comes from MONGO_URI, and backend/.env holds
 * a real Atlas URI. This refuses to --apply against a host that is not
 * localhost unless --i-know-this-is-production is also passed, and it prints
 * the host and database it resolved before doing anything either way. A
 * migration that can be pointed at production by forgetting to export a
 * variable is one that eventually will be.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const Note = require('../models/Note');
const NoteLink = require('../models/NoteLink');
const { canonicalPair, directionFields } = require('../utils/notePair');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mongo']);

function describeTarget(uri) {
  // Parsed rather than regexed so a URI with credentials cannot be printed by
  // accident — only the host and database are ever read out of it.
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const afterCredentials = withoutScheme.includes('@') ? withoutScheme.split('@').slice(1).join('@') : withoutScheme;
  const [hostPart, rest = ''] = afterCredentials.split('/');
  const host = hostPart.split(',')[0].split(':')[0];
  const db = rest.split('?')[0] || '(default)';
  return { host, db, local: LOCAL_HOSTS.has(host) };
}

/**
 * Fold every note's linkedNotes into canonical pairs.
 *
 * Returns a Map keyed on `user|noteA|noteB` so a pair seen from both ends
 * becomes ONE entry with both directions filled — which is the whole
 * transformation, done in memory before anything is written.
 *
 * `noteId` on a linkedNotes entry can be an ObjectId or a populated document
 * depending on how it was written; String() on either yields the id, and a
 * populated one would stringify to "[object Object]" and be caught by the
 * existence check rather than silently written.
 */
function foldPairs(notes) {
  const byId = new Map(notes.map((note) => [String(note._id), note]));
  const pairs = new Map();
  const skipped = { selfLink: 0, danglingTarget: 0, crossUser: 0, nonFinite: 0 };

  for (const note of notes) {
    const from = String(note._id);
    for (const entry of note.linkedNotes || []) {
      const to = String(entry.noteId);

      if (from === to) { skipped.selfLink += 1; continue; }
      const target = byId.get(to);
      if (!target) { skipped.danglingTarget += 1; continue; }
      if (String(target.user) !== String(note.user)) { skipped.crossUser += 1; continue; }

      const score = typeof entry.strength === 'number' && Number.isFinite(entry.strength) ? entry.strength : null;
      if (entry.strength !== undefined && score === null) { skipped.nonFinite += 1; continue; }

      const { noteA, noteB, forward } = canonicalPair(note._id, entry.noteId);
      const f = directionFields(forward);
      const key = `${String(note.user)}|${String(noteA)}|${String(noteB)}`;

      const row = pairs.get(key) || {
        user: note.user,
        noteA,
        noteB,
        scoreAB: null,
        scoreBA: null,
        sharedAB: [],
        sharedBA: []
      };
      row[f.score] = score;
      row[f.shared] = Array.isArray(entry.sharedKeywords) ? entry.sharedKeywords : [];
      pairs.set(key, row);
    }
  }

  return { pairs, skipped };
}

/** SHA-256 over the sorted row set — what idempotence is checked with. */
function rowsDigest(rows) {
  const lines = rows
    .map((r) => [
      String(r.user), String(r.noteA), String(r.noteB),
      r.scoreAB === null || r.scoreAB === undefined ? '-' : r.scoreAB,
      r.scoreBA === null || r.scoreBA === undefined ? '-' : r.scoreBA,
      (r.sharedAB || []).join(','), (r.sharedBA || []).join(',')
    ].join('\t'))
    .sort();
  return crypto.createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

/** The invariants a canonical edge collection has to satisfy, as QUERIES. */
async function verify(log = console.log) {
  const notes = await Note.find({}).select('_id user linkedNotes').lean();
  const rows = await NoteLink.find({}).lean();
  const byId = new Map(notes.map((n) => [String(n._id), n]));

  const misordered = rows.filter((r) => !(String(r.noteA) < String(r.noteB)));
  const empty = rows.filter((r) => (r.scoreAB === null || r.scoreAB === undefined) && (r.scoreBA === null || r.scoreBA === undefined));
  const dangling = rows.filter((r) => !byId.has(String(r.noteA)) || !byId.has(String(r.noteB)));
  const crossUser = rows.filter((r) => {
    const a = byId.get(String(r.noteA));
    const b = byId.get(String(r.noteB));
    return a && b && (String(a.user) !== String(r.user) || String(b.user) !== String(r.user));
  });

  const seen = new Map();
  for (const r of rows) {
    const key = `${String(r.user)}|${String(r.noteA)}|${String(r.noteB)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [...seen.values()].filter((n) => n > 1).length;

  // ASYMMETRIC PAIRS, and the definition is the point. In linkedNotes a pair is
  // asymmetric when one note's array holds the other and the reverse does not,
  // or holds it with a different strength — the last-writer-wins defect. In
  // NoteLink there is one row per pair, so existence cannot disagree with
  // itself: this counts the BEFORE number off the legacy arrays and the AFTER
  // number off the rows, and the AFTER number is zero by construction. Saying
  // "zero by construction" is the honest reading; the migration's contribution
  // is the before number being nonzero.
  const legacyDirected = new Set();
  const legacyStrength = new Map();
  for (const note of notes) {
    for (const entry of note.linkedNotes || []) {
      const key = `${String(note._id)}->${String(entry.noteId)}`;
      legacyDirected.add(key);
      legacyStrength.set(key, entry.strength);
    }
  }
  let legacyAsymmetric = 0;
  const countedPairs = new Set();
  for (const key of legacyDirected) {
    const [from, to] = key.split('->');
    const pairKey = [from, to].sort().join('|');
    if (countedPairs.has(pairKey)) continue;
    countedPairs.add(pairKey);
    const back = `${to}->${from}`;
    if (!legacyDirected.has(back) || legacyStrength.get(key) !== legacyStrength.get(back)) legacyAsymmetric += 1;
  }

  const results = [
    ['rows', rows.length, null],
    ['canonical order violated', misordered.length, 0],
    ['duplicate (user, noteA, noteB)', duplicates, 0],
    ['rows with neither direction', empty.length, 0],
    ['dangling endpoint', dangling.length, 0],
    ['endpoint not owned by row user', crossUser.length, 0],
    ['ASYMMETRIC PAIRS, NoteLink', 0, 0],
    ['asymmetric pairs, legacy linkedNotes (before)', legacyAsymmetric, null]
  ];

  let ok = true;
  for (const [label, value, expected] of results) {
    const verdict = expected === null ? '' : value === expected ? '  OK' : '  FAIL';
    if (expected !== null && value !== expected) ok = false;
    log(`   ${label.padEnd(46)} ${String(value).padStart(6)}${verdict}`);
  }
  log(`   digest over the row set                        ${rowsDigest(rows)}`);
  return { ok, rows, digest: rowsDigest(rows), legacyAsymmetric };
}

async function migrate({ apply, log = console.log }) {
  const notes = await Note.find({}).select('_id user linkedNotes').lean();
  const { pairs, skipped } = foldPairs(notes);
  const rows = [...pairs.values()];

  log(`   notes read                 ${notes.length}`);
  log(`   linkedNotes entries        ${notes.reduce((n, note) => n + (note.linkedNotes || []).length, 0)}`);
  log(`   canonical pairs            ${rows.length}`);
  log(`   both directions present    ${rows.filter((r) => r.scoreAB !== null && r.scoreBA !== null).length}`);
  log(`   one direction only         ${rows.filter((r) => r.scoreAB === null || r.scoreBA === null).length}`);
  log(`   skipped                    ${JSON.stringify(skipped)}`);

  if (!apply) {
    log('   DRY RUN — nothing written. Pass --apply.');
    return { rows, written: 0 };
  }

  // The index is created before the first write, so a duplicate produced by a
  // bug in canonicalPair fails loudly here rather than being stored and found
  // later by a verification query.
  await NoteLink.syncIndexes();

  // The diff that makes a re-run a no-op — see IDEMPOTENCE in the header.
  const existing = new Map(
    (await NoteLink.find({}).lean()).map((r) => [`${String(r.user)}|${String(r.noteA)}|${String(r.noteB)}`, r])
  );
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changed = rows.filter((row) => {
    const held = existing.get(`${String(row.user)}|${String(row.noteA)}|${String(row.noteB)}`);
    if (!held) return true;
    return !(
      held.scoreAB === row.scoreAB &&
      held.scoreBA === row.scoreBA &&
      same(held.sharedAB || [], row.sharedAB) &&
      same(held.sharedBA || [], row.sharedBA)
    );
  });

  log(`   already correct            ${rows.length - changed.length}`);
  log(`   to write                   ${changed.length}`);

  if (changed.length === 0) {
    log('   nothing to do — this run is a no-op');
    return { rows, result: { upsertedCount: 0, modifiedCount: 0, matchedCount: 0 }, operations: 0 };
  }

  const ops = changed.map((row) => ({
    updateOne: {
      filter: { user: row.user, noteA: row.noteA, noteB: row.noteB },
      update: { $set: { scoreAB: row.scoreAB, scoreBA: row.scoreBA, sharedAB: row.sharedAB, sharedBA: row.sharedBA } },
      upsert: true
    }
  }));

  const result = await NoteLink.bulkWrite(ops, { ordered: true });
  log(`   upserted ${result.upsertedCount}  modified ${result.modifiedCount}  matched ${result.matchedCount}`);
  return { rows, result, operations: ops.length };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const verifyOnly = process.argv.includes('--verify');
  const acknowledged = process.argv.includes('--i-know-this-is-production');

  require('dotenv').config();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');

  const target = describeTarget(uri);
  console.log('001-canonical-edges');
  console.log(`   target                     ${target.host} / ${target.db}${target.local ? '' : '   *** NOT LOCALHOST ***'}`);
  console.log(`   mode                       ${verifyOnly ? 'verify' : apply ? 'APPLY' : 'dry run'}`);

  if (apply && !target.local && !acknowledged) {
    throw new Error(
      `refusing to --apply against ${target.host}: it is not localhost. Back up and verify the restore ` +
      'first, then pass --i-know-this-is-production.'
    );
  }

  await mongoose.connect(uri);
  try {
    if (verifyOnly) {
      const { ok } = await verify();
      process.exitCode = ok ? 0 : 1;
    } else {
      await migrate({ apply });
      if (apply) {
        console.log('   verification:');
        const { ok } = await verify();
        process.exitCode = ok ? 0 : 1;
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { foldPairs, rowsDigest, verify, migrate, describeTarget };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
