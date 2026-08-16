#!/usr/bin/env node
'use strict';

/**
 * measure-provenance-query.js — Phase 4.3
 *
 *   MONGO_URI=mongodb://localhost:27017/dsb_query_test npm run measure:query
 *   ... -- --write     also write results/provenance-query.txt
 *
 * Measures 4.3's Done criterion — "a query can return the edge set for a given
 * version" — against a real MongoDB, on a collection large enough for the
 * answer to mean something.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT PART OF scripts/verify-migration.js.
 *
 * That artifact regenerates byte-identically, which §8.5 and §22.4 both lean
 * on, and a duration in it would end that property on the first run. So the
 * split is the one §22.6 arrived at from the other direction: A VALUE THAT IS
 * COMPARED AND A VALUE THAT IS PUBLISHED ARE NOT THE SAME VALUE. verify-
 * migration.js keeps the stable shape checks — which indexes exist, which plan
 * won, docs examined against returned — and this file carries the timings and
 * is explicitly NOT byte-reproducible. Its header says so, so nobody diffs it
 * and files a bug.
 *
 * WHY IT NEEDS A REAL SERVER. The claim is about INDEX SELECTION, and
 * scripts/lib/fake-note-store.js simulates no index at all: a filter that
 * returns the right rows by scanning every one of them is indistinguishable
 * from an index scan when the only thing you can see is the answer. Only a real
 * planner's explain() can tell them apart, and only a real collection makes the
 * planner's choice representative — at 5 rows it will reasonably prefer a
 * collection scan, and that is a fact about 5 rows.
 *
 * IT WILL NOT RUN AGAINST A NON-LOCALHOST HOST, and there is no override, for
 * the same reason verify-migration.js has none: it creates and destroys data.
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT ESTABLISH.
 *
 *   - Nothing about Atlas. A pinned mongo:7 container on loopback is not a
 *     managed replica set: no election, no read preference, no write concern
 *     beyond the default, and no network worth the name. The numbers below have
 *     no RTT in them worth the name either.
 *   - Nothing about real user notes. The rows are synthetic and uniform; a real
 *     user's provenance distribution after a partial re-save is not uniform and
 *     is not modelled.
 *   - It is not a claim that the query is FAST ENOUGH for anything, because
 *     nothing has stated a budget for it. It is a claim about which plan the
 *     server chooses and how many documents it touches to answer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');

const NoteLink = require('../models/NoteLink');
const { UNKNOWN_PROVENANCE } = require('../utils/notePair');
const { describeTarget } = require('../migrations/001-canonical-edges');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'results', 'provenance-query.txt');

/** Two users, so the user prefix on both indexes is doing visible work. */
const USER_ONE = new mongoose.Types.ObjectId('000000000000000000000001');
const USER_TWO = new mongoose.Types.ObjectId('000000000000000000000002');

/** Rows per user. Large enough that a collection scan is not the cheap option. */
const ROWS = 20000;

/**
 * The mixture is deliberate and lopsided: most directions are the RECORDED
 * UNKNOWN a migration wrote, a minority are a real version a save wrote. That
 * is the shape of a real store shortly after 002 runs, and it is also the shape
 * where an index earns its place — a query for the minority label is the one a
 * collection scan is worst at.
 */
const REAL_SHARE = 0.1;

function collectStages(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.stage) out.push(node.stage);
  for (const child of [node.inputStage, ...(node.inputStages || [])]) collectStages(child, out);
  return out;
}

function collectIndexNames(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.indexName) out.push(node.indexName);
  for (const child of [node.inputStage, ...(node.inputStages || [])]) collectIndexNames(child, out);
  return out;
}

const oidAt = (n) => new mongoose.Types.ObjectId(String(n).padStart(24, '0'));

function buildRows(user, offset) {
  const rows = [];
  for (let i = 0; i < ROWS; i += 1) {
    // Two distinct endpoints per row, in the normal form by construction.
    const a = oidAt(offset + i * 2 + 1);
    const b = oidAt(offset + i * 2 + 2);
    const real = i % Math.round(1 / REAL_SHARE) === 0;
    rows.push({
      user,
      noteA: a,
      noteB: b,
      scoreAB: 1 + (i % 97) / 10,
      scoreBA: i % 3 === 0 ? null : 1 + (i % 89) / 10,
      sharedAB: [],
      sharedBA: [],
      retrieverAB: real ? 'v4-bm25' : UNKNOWN_PROVENANCE,
      digestAB: real ? 'ba72e199' : UNKNOWN_PROVENANCE,
      retrieverBA: i % 3 === 0 ? null : UNKNOWN_PROVENANCE,
      digestBA: i % 3 === 0 ? null : UNKNOWN_PROVENANCE
    });
  }
  return rows;
}

/** Median of `runs` timings, in milliseconds, after a discarded warm-up. */
async function timed(run, runs = 11) {
  await run();
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((x, y) => x - y);
  return { p50: samples[Math.floor(samples.length / 2)], min: samples[0], max: samples[samples.length - 1] };
}

async function main() {
  const write = process.argv.includes('--write');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set — point it at a THROWAWAY local database');

  const target = describeTarget(uri);
  if (!target.local) {
    throw new Error(
      `refusing to run against ${target.host}: this script creates and DESTROYS data. ` +
      'It runs against localhost only, and there is no override.'
    );
  }

  const out = [];
  const say = (line = '') => { out.push(line); console.log(line); };

  await mongoose.connect(uri);
  try {
    const build = await mongoose.connection.db.admin().serverStatus();

    say('PROVENANCE QUERY COST — the edge set for a given retriever version');
    say(`   server                     MongoDB ${build.version} in Docker, digest-pinned by docker-compose.yml`);
    say(`   target                     ${target.host} / ${target.db}   (throwaway)`);
    say(`   generated at HEAD          ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim()}`);
    say('   THIS FILE DOES NOT REGENERATE BYTE-IDENTICALLY. It carries timings on');
    say('   purpose, which is why it is not part of migration-verification.txt.');
    say('');

    const existing = await mongoose.connection.db.listCollections({ name: NoteLink.collection.name }).toArray();
    if (existing.length > 0) await mongoose.connection.db.dropCollection(NoteLink.collection.name);
    await NoteLink.syncIndexes();

    await NoteLink.collection.insertMany(buildRows(USER_ONE, 0), { ordered: false });
    await NoteLink.collection.insertMany(buildRows(USER_TWO, ROWS * 2 + 10), { ordered: false });
    const total = await NoteLink.collection.countDocuments();

    say('1. THE COLLECTION');
    say(`   rows                       ${total}   (${ROWS} per user, 2 users)`);
    say(`   directions labelled v4-bm25 ${await NoteLink.collection.countDocuments({ retrieverAB: 'v4-bm25' })}   AB only, ${Math.round(REAL_SHARE * 100)}% of rows`);
    say(`   directions RECORDED UNKNOWN ${await NoteLink.collection.countDocuments({ $or: [{ retrieverAB: UNKNOWN_PROVENANCE }, { retrieverBA: UNKNOWN_PROVENANCE }] })}   rows holding at least one`);
    say('');

    const cases = [
      {
        name: 'edge set for v4-bm25, one user',
        filter: { user: USER_ONE, $or: [{ retrieverAB: 'v4-bm25' }, { retrieverBA: 'v4-bm25' }] }
      },
      {
        name: 'edge set for the RECORDED UNKNOWN, one user',
        filter: { user: USER_ONE, $or: [{ retrieverAB: UNKNOWN_PROVENANCE }, { retrieverBA: UNKNOWN_PROVENANCE }] }
      },
      {
        name: 'a version nothing wrote (the empty answer)',
        filter: { user: USER_ONE, $or: [{ retrieverAB: 'v5-embeddings' }, { retrieverBA: 'v5-embeddings' }] }
      },
      {
        name: 'NOT user-scoped — the ops question, and it has no index prefix',
        filter: { $or: [{ retrieverAB: 'v4-bm25' }, { retrieverBA: 'v4-bm25' }] }
      }
    ];

    say('2. EACH QUERY — plan, work done, and time');
    for (const c of cases) {
      const plan = await NoteLink.find(c.filter).explain('executionStats');
      const stats = plan.executionStats;
      const t = await timed(() => NoteLink.find(c.filter).lean());
      say(`   ${c.name}`);
      say(`      stages                  ${collectStages(plan.queryPlanner.winningPlan).join(' -> ')}`);
      say(`      indexes chosen          ${[...new Set(collectIndexNames(plan.queryPlanner.winningPlan))].join(', ') || '(none — COLLSCAN)'}`);
      say(`      returned / docs examined / keys examined   ${stats.nReturned} / ${stats.totalDocsExamined} / ${stats.totalKeysExamined}`);
      say(`      wall time, 11 runs      p50 ${t.p50.toFixed(2)} ms   min ${t.min.toFixed(2)}   max ${t.max.toFixed(2)}`);
      say('');
    }

    say('3. WHAT THE NUMBERS DO NOT SAY');
    say('   - docs examined == returned means the index answered without touching');
    say('     a row it did not need. It does NOT mean the query is cheap in any');
    say('     absolute sense, and no budget for it has been stated anywhere.');
    say('   - The wall times include driver and BSON decode for every returned row,');
    say('     so the large answers are dominated by materialising them rather than');
    say('     by finding them. That is why keys/docs examined is the load-bearing');
    say('     column and the milliseconds are context.');
    say('   - Loopback to a container. No Atlas, no replica set, no real network.');
    say('   - The row mixture is synthetic and uniform. A real store after a');
    say('     partial re-save is neither.');
    say('');
    say('ENVIRONMENT');
    say(`   ${os.type()} ${os.release()} ${process.arch}, Node ${process.version}`);
    say(`   MongoDB ${build.version} in Docker, image pinned by digest in docker-compose.yml`);

    if (write) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, `${out.join('\n')}\n`);
      console.log(`\nwrote ${path.relative(REPO, OUT)}`);
    }

    await mongoose.connection.db.dropCollection(NoteLink.collection.name);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
