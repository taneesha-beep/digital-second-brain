#!/usr/bin/env node
'use strict';

/**
 * build-splits.js — Phase 1.4
 *
 * Splits the query set into train / dev / test with a fixed seed.
 *
 *   data/qrels/<site>.qrels  ->  data/splits/<site>.{train,dev,test}.txt
 *
 * A query is a corpus document holding at least one judgment, so the query set
 * is exactly the set of distinct qids in the qrels — this script never re-reads
 * PostLinks.xml, and cannot disagree with the answer key about what a query is.
 *
 * WHY THE SPLIT EXISTS. Every retriever on the ladder has knobs — the shipped
 * 0.15 threshold and top-8 cap (2.7), BM25's k1 and b (3.3), the RRF constant
 * (3.5). Tuning those against the same queries the result is reported on
 * produces a number that was optimised against, inflated by an unknown amount.
 * Dev is where knobs are tuned. Test is opened once per retriever version at
 * 3.6 and never used to choose anything. The protocol is written out in
 * docs/EVALUATION.md, deliberately before any result exists.
 *
 * TRAIN IS CURRENTLY UNUSED, and that is stated rather than disguised: no rung
 * on the ladder learns from examples. It is held back so that adding a learned
 * reranker later does not force a re-split, which would invalidate every number
 * measured before it.
 *
 * SPLIT BY QUERY, NOT BY COMPONENT. Judgments are symmetric, so a pair judged
 * in train has its mirror in test. That does not leak while no rung learns from
 * qrels — tuning touches two hyperparameters through aggregate dev metrics. If
 * one ever does, a random query split stops being sufficient. The obvious fix
 * does not work here and it is worth recording why: the judgment graph on
 * cooking has 1,737 connected components and the largest holds 3,736 of 9,218
 * queries (40.5%), so a component-wise split cannot reach 50/25/25 at all.
 *
 * DETERMINISM. Math.random() cannot be seeded in Node, so it is unusable for a
 * reproducible split. mulberry32 below is seeded, dependency-free, and runs on
 * integer operations (Math.imul), so it produces the same stream on any
 * platform. Ids are sorted numerically before the shuffle so the shuffle input
 * is canonical rather than Map insertion order.
 *
 * Ids are written in SHUFFLE order, not sorted order. That is deliberate: a
 * prefix of a seeded shuffle is itself a uniform random sample, so `head -n 250
 * cooking.dev.txt` is a valid 250-query subsample if a cheaper run is ever
 * wanted, and nothing is lost by keeping every query in the file.
 *
 * Usage: npm run splits:build -- --site cooking [--seed 20260803]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SEED = 20260803;
const TRAIN_FRACTION = 0.5;
const DEV_FRACTION = 0.25;
// Test takes the remainder rather than its own fraction, so the three sizes sum
// to Q exactly with no rounding gap to reconcile.

function parseArgs(argv) {
  const args = { site: 'cooking', seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--site' && argv[i + 1]) { args.site = argv[i + 1]; i += 1; }
    else if (argv[i] === '--seed' && argv[i + 1]) {
      args.seed = Number.parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return args;
}

/**
 * mulberry32 — 32-bit seeded PRNG. All state transitions are integer ops, so
 * the stream is identical across platforms and Node versions.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates. Unbiased, and every draw comes from the seeded stream.
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function writeAtomic(target, contents) {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, contents);
  const fd = fs.openSync(tmp, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, target);
}

async function main() {
  const t0 = process.hrtime.bigint();
  const { site, seed } = parseArgs(process.argv.slice(2));

  if (!Number.isInteger(seed)) {
    console.error(`build-splits: --seed must be an integer, got ${seed}`);
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const qrelsPath = path.join(repoRoot, 'data', 'qrels', `${site}.qrels`);
  const outDir = path.join(repoRoot, 'data', 'splits');

  if (!fs.existsSync(qrelsPath)) {
    console.error(`build-splits: missing ${qrelsPath}`);
    console.error(`  run: npm run qrels:build -- --site ${site}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  // --- query set = distinct qids in the qrels -----------------------------
  const qrelsText = fs.readFileSync(qrelsPath, 'utf8');
  const queryIds = new Set();
  let judgments = 0;
  let malformed = 0;
  for (const line of qrelsText.split('\n')) {
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length !== 4) { malformed += 1; continue; }
    queryIds.add(parts[0]);
    judgments += 1;
  }
  if (malformed > 0) {
    console.error(`build-splits: ${malformed} malformed qrels lines`);
    process.exit(1);
  }

  // Numerically ascending, so the shuffle input does not depend on Set
  // insertion order (which follows qrels file order, which is already sorted —
  // but relying on that would make this script's output depend on another
  // script's incidental behaviour).
  const ids = [...queryIds].sort((a, b) => Number(a) - Number(b));
  const Q = ids.length;

  const rand = mulberry32(seed);
  const shuffled = shuffle(ids.slice(), rand);

  const trainSize = Math.floor(Q * TRAIN_FRACTION);
  const devSize = Math.floor(Q * DEV_FRACTION);
  const testSize = Q - trainSize - devSize;

  const splits = {
    train: shuffled.slice(0, trainSize),
    dev: shuffled.slice(trainSize, trainSize + devSize),
    test: shuffled.slice(trainSize + devSize),
  };

  // --- guards: disjointness proved, not asserted --------------------------
  const failures = [];
  const sets = {
    train: new Set(splits.train),
    dev: new Set(splits.dev),
    test: new Set(splits.test),
  };

  // S1 — every split id is a query in the qrels.
  for (const name of ['train', 'dev', 'test']) {
    for (const id of splits[name]) {
      if (!queryIds.has(id)) { failures.push(`S1 ${name} contains non-query id ${id}`); break; }
    }
  }
  // S2 — no duplicate within a file.
  for (const name of ['train', 'dev', 'test']) {
    if (sets[name].size !== splits[name].length) {
      failures.push(`S2 ${name} has ${splits[name].length - sets[name].size} duplicate ids`);
    }
  }
  // S3 — pairwise intersections are empty.
  const intersect = (a, b) => {
    let n = 0;
    for (const id of a) if (b.has(id)) n += 1;
    return n;
  };
  const overlaps = {
    'train∩dev': intersect(sets.train, sets.dev),
    'train∩test': intersect(sets.train, sets.test),
    'dev∩test': intersect(sets.dev, sets.test),
  };
  for (const [k, v] of Object.entries(overlaps)) {
    if (v !== 0) failures.push(`S3 ${k} = ${v}, expected 0`);
  }
  // S4 — the union is the whole query set: nothing dropped, nothing invented.
  const union = new Set([...splits.train, ...splits.dev, ...splits.test]);
  if (union.size !== Q) failures.push(`S4 union ${union.size} != Q ${Q}`);
  // S5 — sizes sum to Q.
  const sizeSum = trainSize + devSize + testSize;
  if (sizeSum !== Q) failures.push(`S5 sizes sum to ${sizeSum} != Q ${Q}`);

  if (failures.length) {
    console.error('build-splits FAILED — no files written:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  // --- write ---------------------------------------------------------------
  const written = {};
  for (const name of ['train', 'dev', 'test']) {
    const file = path.join(outDir, `${site}.${name}.txt`);
    writeAtomic(file, `${splits[name].join('\n')}\n`);
    written[name] = {
      file: `data/splits/${site}.${name}.txt`,
      queries: splits[name].length,
      bytes: fs.statSync(file).size,
      sha256: await sha256File(file),
    };
  }

  const qrelsSha = await sha256File(qrelsPath);

  // No timestamp, no Node version — byte-stable wherever the splits are.
  const manifest = {
    site,
    seed,
    prng: 'mulberry32, Fisher-Yates; ids sorted numerically before shuffling',
    order: 'shuffle order, not sorted — a prefix of a seeded shuffle is itself a uniform random sample',
    fractions: { train: TRAIN_FRACTION, dev: DEV_FRACTION, test: 'remainder' },
    source: {
      file: `data/qrels/${site}.qrels`,
      sha256: qrelsSha,
      judgments,
      queries: Q,
    },
    splits: written,
    disjointness: {
      'train∩dev': overlaps['train∩dev'],
      'train∩test': overlaps['train∩test'],
      'dev∩test': overlaps['dev∩test'],
      unionSize: union.size,
      querySetSize: Q,
    },
    protocol: {
      train: 'reserved; no current rung learns from examples',
      dev: 'all tuning — thresholds, k, BM25 k1/b, RRF constant',
      test: 'opened once per retriever version at 3.6; never used to choose anything',
    },
  };
  fs.writeFileSync(
    path.join(outDir, `${site}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const n = (x) => x.toLocaleString('en-US');
  const pct = (x) => `${((x / Q) * 100).toFixed(2)}%`;

  console.log('');
  console.log(`splits:build — site=${site}`);
  console.log('');
  console.log('  input');
  console.log(`    qrels                   data/qrels/${site}.qrels`);
  console.log(`    sha256                  ${qrelsSha}`);
  console.log(`    judgments               ${n(judgments)}`);
  console.log(`    query set Q             ${n(Q)}`);
  console.log('');
  console.log('  split');
  console.log(`    seed                    ${seed}`);
  console.log(`    prng                    mulberry32 + Fisher-Yates`);
  for (const name of ['train', 'dev', 'test']) {
    console.log(`    ${name.padEnd(6)}                  ${n(written[name].queries).padStart(6)}  (${pct(written[name].queries)})  ${written[name].sha256}`);
  }
  console.log('');
  console.log('  disjointness');
  console.log(`    train ∩ dev             ${overlaps['train∩dev']}`);
  console.log(`    train ∩ test            ${overlaps['train∩test']}`);
  console.log(`    dev   ∩ test            ${overlaps['dev∩test']}`);
  console.log(`    |union|                 ${n(union.size)}  (= Q ${n(Q)}: ${union.size === Q ? 'yes' : 'NO'})`);
  console.log(`    sizes sum               ${n(sizeSum)}  (= Q ${n(Q)}: ${sizeSum === Q ? 'yes' : 'NO'})`);
  console.log('');
  console.log('  guards');
  console.log('    S1 ids are queries      pass');
  console.log('    S2 no dup within file   pass');
  console.log('    S3 pairwise disjoint    pass');
  console.log('    S4 union == query set   pass');
  console.log('    S5 sizes sum to Q       pass');
  console.log('');
  console.log('  run');
  console.log(`    wall time               ${wallMs.toFixed(0)} ms`);
  console.log(`    node                    ${process.version} ${process.platform}/${process.arch}`);
  console.log('');
}

main().catch((err) => {
  console.error('build-splits: fatal —', err && err.stack ? err.stack : err);
  process.exit(1);
});
