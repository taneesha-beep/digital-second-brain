#!/usr/bin/env node
'use strict';

/**
 * 001-canonical-edges.rollback.js — Phase 4.2.
 *
 *   node migrations/001-canonical-edges.rollback.js                DRY RUN
 *   node migrations/001-canonical-edges.rollback.js --apply
 *
 * Drops the `notelinks` collection. That is the whole rollback, and it is short
 * because 001-canonical-edges.js is additive: it reads `linkedNotes` and never
 * writes to a note, so the state before the migration is the state that is
 * still there.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE LIMIT, STATED RATHER THAN DISCOVERED LATER.
 *
 * This is lossless ONLY WHILE THE 4.2 CODE HAS NOT SERVED WRITES. From the
 * moment services/linker.service.js starts writing canonical rows, two things
 * are true at once: new links exist only in `notelinks`, and `linkedNotes` has
 * stopped being updated and is going stale. Dropping the collection then is a
 * REVERT TO A SNAPSHOT, not an undo — every link computed since the deploy is
 * discarded and the app falls back to whatever `linkedNotes` last held.
 *
 * That is recoverable, because a link is derived data: re-saving a note
 * recomputes it. It is not silent, which is the part that matters — it is
 * written here, and the script prints how many rows it is about to discard and
 * how many of them the migration could not have produced.
 * ───────────────────────────────────────────────────────────────────────────
 * The same production guard as the migration, for the same reason.
 */

const mongoose = require('mongoose');

const Note = require('../models/Note');
const NoteLink = require('../models/NoteLink');
const { foldPairs, describeTarget } = require('./001-canonical-edges');

async function rollback({ apply, log = console.log }) {
  const rows = await NoteLink.find({}).lean();
  const notes = await Note.find({}).select('_id user linkedNotes').lean();
  const { pairs } = foldPairs(notes);

  // Rows the migration could not have produced are rows the LIVE APP wrote,
  // and they are what this drop actually costs. Counted rather than assumed,
  // because "the rollback is lossless" is only true when this number is zero.
  const reachable = new Set(pairs.keys());
  const appWritten = rows.filter((r) => !reachable.has(`${String(r.user)}|${String(r.noteA)}|${String(r.noteB)}`));

  log(`   rows in notelinks          ${rows.length}`);
  log(`   reproducible from linkedNotes ${rows.length - appWritten.length}`);
  log(`   written since the migration   ${appWritten.length}${appWritten.length > 0 ? '   <-- DISCARDED, and not recoverable from linkedNotes' : ''}`);
  log(`   notes touched by this script  0   (the migration never wrote one, so neither does its undo)`);

  if (!apply) {
    log('   DRY RUN — nothing dropped. Pass --apply.');
    return { dropped: 0, appWritten: appWritten.length };
  }

  // dropCollection rather than deleteMany: the index has to go too, or a later
  // re-run of the migration would silently inherit an index built by a version
  // of the schema that is no longer loaded.
  const collections = await mongoose.connection.db.listCollections({ name: NoteLink.collection.name }).toArray();
  if (collections.length === 0) {
    log(`   ${NoteLink.collection.name} does not exist — nothing to drop`);
    return { dropped: 0, appWritten: appWritten.length };
  }
  await mongoose.connection.db.dropCollection(NoteLink.collection.name);
  log(`   dropped ${NoteLink.collection.name} (${rows.length} rows and its indexes)`);
  return { dropped: rows.length, appWritten: appWritten.length };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const acknowledged = process.argv.includes('--i-know-this-is-production');

  require('dotenv').config();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');

  const target = describeTarget(uri);
  console.log('001-canonical-edges ROLLBACK');
  console.log(`   target                     ${target.host} / ${target.db}${target.local ? '' : '   *** NOT LOCALHOST ***'}`);
  console.log(`   mode                       ${apply ? 'APPLY' : 'dry run'}`);

  if (apply && !target.local && !acknowledged) {
    throw new Error(
      `refusing to --apply against ${target.host}: it is not localhost. Pass --i-know-this-is-production.`
    );
  }

  await mongoose.connect(uri);
  try {
    await rollback({ apply });
  } finally {
    await mongoose.disconnect();
  }
}

module.exports = { rollback };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
