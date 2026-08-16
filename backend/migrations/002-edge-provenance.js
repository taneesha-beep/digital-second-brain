#!/usr/bin/env node
'use strict';

/**
 * 002-edge-provenance.js — Phase 4.3.
 *
 *   node migrations/002-edge-provenance.js                 DRY RUN (the default)
 *   node migrations/002-edge-provenance.js --apply
 *   node migrations/002-edge-provenance.js --verify
 *
 * Labels every canonical edge direction that carries a score and no provenance
 * with the RECORDED UNKNOWN — utils/notePair.js's UNKNOWN_PROVENANCE, in both
 * that direction's `retriever` and `digest` fields.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS 002 AND NOT AN EDIT TO 001, WHICH WAS THE REAL CHOICE.
 *
 * 001 has never run anywhere — Atlas is untouched — so amending it would have
 * been free in the usual sense, and "migrations are immutable once written" is
 * a convention rather than an argument. The argument is this:
 *
 *   A 001 THAT LABELLED ROWS COULD ONLY LABEL THE ROWS IT CREATED. Every row
 *   the 4.2 LINKER writes between deploying 4.2 and deploying 4.3 also carries
 *   no provenance, and 001 never touches those — it reads linkedNotes and
 *   upserts pairs, so a row the live app wrote for a pair no legacy array
 *   mentions is invisible to it. Folding provenance into 001 cannot cover the
 *   whole population, and a backfill that covers most of a population is the
 *   kind of half-guarantee this repo keeps writing down as a defect.
 *
 * The secondary reason is legibility: §22.4 records 001's behaviour with
 * counts, and rewriting it would make a committed writeup describe code that
 * no longer exists. 4.3's job is to retire one SENTENCE of §22.4, not the
 * section.
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT A MIGRATED ROW GETS, AND WHY IT IS NOT A GUESS.
 *
 * §21.8 and §22.4 both say it plainly: the store is a mixture of two
 * retrievers' output and NOTHING IN THE DATA distinguishes them. So this
 * migration records ignorance rather than inventing a value. `null`,
 * `'unknown'`, `'pre-4.3'` and guessing `'v1-overlap'` are all defensible and
 * they are not equivalent; utils/notePair.js's header argues the choice at
 * length, including why the one available heuristic — v1 always wrote a
 * non-empty sharedKeywords where v4 always writes an empty one — was rejected.
 * The short form: provenance for these rows is not merely unknown, it is
 * UNKNOWABLE, and it is unknowable in two fields, because even a correct
 * version string could not carry a correct params digest.
 *
 * A RECORDED UNKNOWN IS NOT AN ABSENCE. `null` on this row already means
 * "direction not observed", so a null label would be indistinguishable from a
 * writer that forgot to set one — one absence standing for two facts. The
 * sentinel says something; null says nothing, twice.
 * ───────────────────────────────────────────────────────────────────────────
 * IT IS ADDITIVE IN THE SAME SENSE 001 IS: it never reads or writes a note, and
 * it never touches a score, a shared-term list, or a row's identity. It adds
 * labels to directions that have none. That is what lets the rollback be an
 * $unset rather than a reconstruction.
 *
 * IDEMPOTENCE — AND 001 ALREADY PAID FOR THE LESSON THIS ONE INHERITS.
 * NoteLink has `timestamps: true`, so mongoose injects `updatedAt` into every
 * $set and an unconditional re-write reports every row modified while the
 * content is unchanged — "true in the sense being checked and false in the
 * sense being asserted" (§22.4). So this migration DIFFS BEFORE IT WRITES: it
 * selects only the directions that are actually unlabelled, and a second run
 * issues ZERO operations rather than zero modifications.
 *
 * THERE IS NO MIGRATE-BEFORE-DEPLOY HAZARD HERE, AND THAT IS THE DIFFERENCE
 * FROM 4.2. 001's hazard was severe: getLinkedNotes() reads NoteLink and
 * nothing else, so deploying 4.2's code first emptied every related-notes panel
 * silently. An UNLABELLED row still serves its links perfectly — provenance is
 * read by nothing on the render path — so deploying 4.3 before running this
 * degrades exactly one thing: edgesForVersion() under-reports until it runs. It
 * is required for the Done criterion and it is not order-critical. Do not carry
 * §22.4's warning over by assumption.
 *
 * THE ORDER THAT DOES MATTER IS 001 THEN 002, and it is not fragile either.
 * 001's own diff compares scores and shared terms only, so it will not clear a
 * label this migration wrote; and if 001 inserts new rows afterwards, re-running
 * 002 is idempotent and cheap. Run 002 last and re-run it after any 001.
 * ───────────────────────────────────────────────────────────────────────────
 * THE PRODUCTION GUARD is 001's, unchanged and for the same reason: the target
 * comes from MONGO_URI and backend/.env holds a real Atlas URI.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const NoteLink = require('../models/NoteLink');
const { UNKNOWN_PROVENANCE } = require('../utils/notePair');
const { describeTarget } = require('./001-canonical-edges');

const DIRECTIONS = [
  { side: 'AB', score: 'scoreAB', retriever: 'retrieverAB', digest: 'digestAB' },
  { side: 'BA', score: 'scoreBA', retriever: 'retrieverBA', digest: 'digestBA' }
];

const observed = (value) => value !== null && value !== undefined;
const labelled = (value) => value !== null && value !== undefined;

/**
 * The directions this migration would label: a score is present and no label
 * is. Returned as a list rather than a count so --apply and the dry run report
 * the same thing computed the same way.
 */
function unlabelled(rows) {
  const out = [];
  for (const row of rows) {
    for (const dir of DIRECTIONS) {
      if (observed(row[dir.score]) && !labelled(row[dir.retriever])) {
        out.push({ row, dir });
      }
    }
  }
  return out;
}

/** SHA-256 over the sorted provenance state — what idempotence is checked with. */
function provenanceDigest(rows) {
  const lines = rows
    .map((r) => [
      String(r.user), String(r.noteA), String(r.noteB),
      r.retrieverAB ?? '-', r.digestAB ?? '-',
      r.retrieverBA ?? '-', r.digestBA ?? '-'
    ].join('\t'))
    .sort();
  return crypto.createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
}

/**
 * The invariants a PROVENANCE-COMPLETE collection satisfies, as QUERIES.
 *
 * These are checked here rather than in the model's pre('validate') hook for
 * two reasons. The hook does not cover bulkWrite, which is how the linker and
 * both migrations write (§22.4) — so a guard there has coverage smaller than it
 * looks. And "an observed score carries a label" is a POST-MIGRATION property,
 * false in a state the system legitimately passes through: every row 4.2's
 * linker wrote before this ran is a score with no label, by design.
 */
async function verify(log = console.log) {
  const rows = await NoteLink.find({}).lean();

  let unlabelledDirections = 0;
  let orphanLabels = 0;
  let mixedKind = 0;
  let unknownDirections = 0;
  let realDirections = 0;

  for (const row of rows) {
    for (const dir of DIRECTIONS) {
      const hasScore = observed(row[dir.score]);
      const r = row[dir.retriever] ?? null;
      const d = row[dir.digest] ?? null;

      if (hasScore && r === null) unlabelledDirections += 1;
      // A label with no score: the clear step failed to null provenance
      // alongside the number it explains, so a row records where a value that
      // is not there came from.
      if (!hasScore && r !== null) orphanLabels += 1;
      // Half-known: claims to know the configuration and not to know it.
      const kind = (v) => (v === null ? 'null' : v === UNKNOWN_PROVENANCE ? 'unknown' : 'real');
      if (kind(r) !== kind(d)) mixedKind += 1;
      if (kind(r) === 'unknown') unknownDirections += 1;
      if (kind(r) === 'real') realDirections += 1;
    }
  }

  const results = [
    ['rows', rows.length, null],
    ['observed directions with NO provenance', unlabelledDirections, 0],
    ['provenance on an unobserved direction', orphanLabels, 0],
    ['retriever and digest disagreeing in kind', mixedKind, 0],
    ['directions labelled RECORDED UNKNOWN', unknownDirections, null],
    ['directions labelled with a real version', realDirections, null]
  ];

  let ok = true;
  for (const [label, value, expected] of results) {
    const verdict = expected === null ? '' : value === expected ? '  OK' : '  FAIL';
    if (expected !== null && value !== expected) ok = false;
    log(`   ${label.padEnd(46)} ${String(value).padStart(6)}${verdict}`);
  }
  log(`   digest over the provenance state              ${provenanceDigest(rows)}`);
  return { ok, rows, digest: provenanceDigest(rows), unknownDirections, realDirections };
}

async function migrate({ apply, log = console.log }) {
  const rows = await NoteLink.find({}).lean();
  const todo = unlabelled(rows);

  const byRow = new Map();
  for (const { row, dir } of todo) {
    const key = String(row._id);
    if (!byRow.has(key)) byRow.set(key, { row, dirs: [] });
    byRow.get(key).dirs.push(dir);
  }

  log(`   rows read                  ${rows.length}`);
  log(`   observed directions        ${rows.reduce((n, r) => n + DIRECTIONS.filter((d) => observed(r[d.score])).length, 0)}`);
  log(`   already labelled           ${rows.reduce((n, r) => n + DIRECTIONS.filter((d) => observed(r[d.score]) && labelled(r[d.retriever])).length, 0)}`);
  log(`   to label RECORDED UNKNOWN  ${todo.length}  across ${byRow.size} rows`);

  if (!apply) {
    log('   DRY RUN — nothing written. Pass --apply.');
    return { rows, operations: 0 };
  }

  // The two provenance indexes are created before the first write, so a bad
  // key fails loudly here rather than at the first query that needed one.
  await NoteLink.syncIndexes();

  if (byRow.size === 0) {
    log('   nothing to do — this run is a no-op');
    return { rows, result: { modifiedCount: 0, matchedCount: 0 }, operations: 0 };
  }

  const ops = [...byRow.values()].map(({ row, dirs }) => {
    const $set = {};
    for (const dir of dirs) {
      $set[dir.retriever] = UNKNOWN_PROVENANCE;
      $set[dir.digest] = UNKNOWN_PROVENANCE;
    }
    return { updateOne: { filter: { _id: row._id }, update: { $set } } };
  });

  const result = await NoteLink.bulkWrite(ops, { ordered: true });
  log(`   modified ${result.modifiedCount}  matched ${result.matchedCount}`);
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
  console.log('002-edge-provenance');
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

module.exports = { unlabelled, provenanceDigest, verify, migrate, DIRECTIONS };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
