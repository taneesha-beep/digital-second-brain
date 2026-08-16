#!/usr/bin/env node
'use strict';

/**
 * 002-edge-provenance.rollback.js — Phase 4.3.
 *
 *   node migrations/002-edge-provenance.rollback.js                DRY RUN
 *   node migrations/002-edge-provenance.rollback.js --apply
 *
 * $unsets the four provenance fields from every row, returning the collection
 * to the shape 4.2 left it in.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THIS WAS HARDER TO DEFINE THAN 001'S, AND THE SENTINEL IS WHAT MADE IT
 * DEFINABLE AT ALL.
 *
 * 001's rollback is a collection drop: the migration is additive, so the state
 * before it is the state still on disk. This one cannot be. Provenance lives
 * ON existing rows, so undoing it means removing a field — and a field this
 * migration added is indistinguishable from a field the live linker wrote,
 * EXCEPT that this migration writes UNKNOWN_PROVENANCE and the linker writes a
 * real version and digest. That distinction is not a convenience here; it is
 * the only thing that lets this script report what it is about to destroy.
 *
 *   directions labelled `unknown`  this migration's own work. Removing them
 *                                  loses NOTHING — re-running 002 reproduces
 *                                  every one of them exactly, because the value
 *                                  is a constant rather than a measurement.
 *   directions labelled REAL       written by the live 4.3 linker. Removing
 *                                  them DISCARDS the only record of which
 *                                  configuration produced those scores, and no
 *                                  migration can put it back — only a re-save,
 *                                  by the retriever, which is the one thing
 *                                  that knows.
 *
 * SO THE LIMIT HAS THE SAME SHAPE AS 001'S AND A DIFFERENT CAUSE: lossless only
 * while the 4.3 CODE HAS NOT SERVED WRITES. After that it is a partial revert,
 * and the script counts and prints exactly how partial before doing anything.
 *
 * IT UNSETS RATHER THAN NULLS, and the difference is the whole point. A row
 * with no provenance fields is the pre-4.3 shape. A row with four nulls is a
 * 4.3 row that happens to be unlabelled — which is a state 002 would then try
 * to label. Nulling would leave the collection claiming to have been rolled
 * back while still carrying the schema it was rolled back from.
 *
 * WHAT IT DOES NOT TOUCH: scores, shared-term lists, row identity, and any
 * note. 002 never wrote one, so neither does its undo.
 *
 * THE TWO PROVENANCE INDEXES ARE LEFT IN PLACE, deliberately. They index fields
 * that no longer exist on any document, which Mongo handles as a sparse-in-
 * effect index over nothing; dropping them is a schema change rather than a
 * data one, and it belongs with removing the fields from models/NoteLink.js —
 * i.e. with reverting the code, not with reverting the data.
 * ───────────────────────────────────────────────────────────────────────────
 * The same production guard as the migration, for the same reason.
 */

const mongoose = require('mongoose');

const NoteLink = require('../models/NoteLink');
const { UNKNOWN_PROVENANCE } = require('../utils/notePair');
const { describeTarget } = require('./001-canonical-edges');
const { DIRECTIONS } = require('./002-edge-provenance');

const PROVENANCE_FIELDS = ['retrieverAB', 'retrieverBA', 'digestAB', 'digestBA'];

async function rollback({ apply, log = console.log }) {
  const rows = await NoteLink.find({}).lean();

  let recorded = 0;   // labelled `unknown` — 002's own work, reproducible
  let appWritten = 0; // labelled with a real version — the live linker's
  let carrying = 0;   // rows holding any provenance field at all

  for (const row of rows) {
    let any = false;
    for (const dir of DIRECTIONS) {
      const value = row[dir.retriever] ?? null;
      if (value === null) continue;
      any = true;
      if (value === UNKNOWN_PROVENANCE) recorded += 1;
      else appWritten += 1;
    }
    if (any) carrying += 1;
  }

  log(`   rows in notelinks          ${rows.length}`);
  log(`   rows carrying provenance   ${carrying}`);
  log(`   directions RECORDED UNKNOWN ${recorded}   (002's own work — re-running 002 reproduces every one)`);
  log(`   directions with a REAL label ${appWritten}${appWritten > 0 ? '   <-- DISCARDED, and recoverable only by re-saving the note' : ''}`);
  log('   notes touched by this script  0   (the migration never wrote one, so neither does its undo)');

  if (!apply) {
    log('   DRY RUN — nothing unset. Pass --apply.');
    return { unset: 0, recorded, appWritten };
  }

  if (carrying === 0) {
    log('   no row carries provenance — nothing to do');
    return { unset: 0, recorded, appWritten };
  }

  const $unset = Object.fromEntries(PROVENANCE_FIELDS.map((f) => [f, '']));
  const result = await NoteLink.updateMany({}, { $unset });
  log(`   unset ${PROVENANCE_FIELDS.join(', ')} on ${result.modifiedCount} rows`);
  return { unset: result.modifiedCount, recorded, appWritten };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const acknowledged = process.argv.includes('--i-know-this-is-production');

  require('dotenv').config();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');

  const target = describeTarget(uri);
  console.log('002-edge-provenance ROLLBACK');
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

module.exports = { rollback, PROVENANCE_FIELDS };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
