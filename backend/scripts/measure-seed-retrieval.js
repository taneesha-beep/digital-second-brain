#!/usr/bin/env node
'use strict';

/**
 * measure-seed-retrieval.js — Phase 5.7. The RETRIEVAL half of the 5.7 table.
 *
 *   npm run seed:retrieval                 report only
 *   npm run seed:retrieval -- --write      write results/seed-retrieval.jsonl
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE SCRIPT FROM THE REPORT, AND IT IS 5.4's SPLIT AGAIN
 * ---------------------------------------------------------------------------
 *
 * 5.7 needs nDCG@8 per SEED per RETRIEVER. Computing it needs the gitignored
 * corpus, the gitignored qrels and (for v5/v6) the gitignored vectors, so a
 * report that computed it could never run in CI and — worse — would pass in CI
 * and FAIL in the local reproduction of CI, which moves data/ aside entirely
 * (§29.11). §30.3 rejected exactly that shape.
 *
 * So this script is the half that reads data/, and it writes a committed
 * artifact. `npm run eval:v7` is the half that reads only results/ and is PURE.
 * That is the runner/reporter split 5.4 drew between `gen:v5` and `eval:gen`,
 * with "spends quota" replaced by "needs the corpus" — a different reason for
 * the same boundary, and the boundary is what makes the report runnable
 * anywhere.
 *
 * NOTHING HERE COSTS QUOTA. No key, no network, no model. It is retrieval only.
 *
 * ---------------------------------------------------------------------------
 * ALL SIX RUNGS, NOT JUST THE TWO WITH A GENERATION ARM
 * ---------------------------------------------------------------------------
 *
 * The nDCG@8 column is free for every rung, and a table showing two of six
 * would invite the reading that the other four were tried and omitted. Two of
 * them carry a generation arm; the artifact says which, per row, so the report
 * cannot quietly pair a retrieval score with a generation score that was never
 * measured under it.
 *
 * ---------------------------------------------------------------------------
 * THE QRELS ARE SPARSE ON THESE 30 SEEDS AND THE ARTIFACT SAYS SO PER ROW
 * ---------------------------------------------------------------------------
 *
 * `judged` is the count of relevant documents the key holds for that seed. On
 * this draw the median is 1, so a seed's nDCG@8 is close to a BINARY event —
 * "was the one linked question retrieved in the top 8". That is a property of
 * PostLinks (§5.1: positive judgments only, every absolute a lower bound) and
 * not of the retrievers, and it is the single most important caveat on any
 * per-seed correlation computed from this file. It is written into every row
 * rather than into a paragraph somebody may not read.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const retrieval = require('../retrieval');
const { scoreQuery } = require('../eval/metrics');
const { loadQrelsStrict, sha256File } = require('./lib/run-io');
const { attachVectors } = require('./lib/vectors');
const { LINK_CAP } = require('../services/noteCorpus.service');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(REPO, 'data', 'corpus', 'cooking.jsonl');
const CORPUS_MANIFEST = path.join(REPO, 'data', 'corpus', 'cooking.manifest.json');
const QRELS = path.join(REPO, 'data', 'qrels', 'cooking.qrels');
const CLUSTERS = path.join(REPO, 'data', 'gen-eval', 'clusters.jsonl');
const OUT = path.join(REPO, 'results', 'seed-retrieval.jsonl');

/** Which rungs carry a generation arm, and under which ledger. 5.7's two. */
const GENERATION_ARMS = {
  'v4-bm25': 'gen-v5',
  'v5-embeddings': 'gen-v7'
};

const K = LINK_CAP;

const has = (name) => process.argv.includes(`--${name}`);

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function requireInput(file, what) {
  if (!fs.existsSync(file)) {
    console.error(`MISSING ${what}: ${path.relative(REPO, file)}`);
    console.error('  Gitignored by design. EVALUATION.md §6 has how to rebuild it.');
    process.exit(1);
  }
}

function main() {
  for (const [f, w] of [[CORPUS, 'corpus'], [CORPUS_MANIFEST, 'corpus manifest'],
    [QRELS, 'qrels'], [CLUSTERS, 'golden set']]) requireInput(f, w);

  const corpusSha = sha256File(CORPUS);
  const corpusManifest = JSON.parse(fs.readFileSync(CORPUS_MANIFEST, 'utf8'));
  if (corpusSha !== corpusManifest.output.sha256) {
    console.error('CORPUS SHA-256 MISMATCH against its own manifest — refusing to measure.');
    process.exit(1);
  }

  const docs = readJsonl(CORPUS).map((d) => ({ id: String(d.id), title: d.title || '', body: d.body || '' }));
  const { byQuery: qrels } = loadQrelsStrict(QRELS);
  const clusters = readJsonl(CLUSTERS);
  const seeds = clusters.map((c) => ({ id: String(c.seedId), quintile: c.quintile, words: c.words }));

  console.log('PHASE 5.7 — RETRIEVAL QUALITY PER SEED\n');
  console.log(`  corpus     ${docs.length} docs   sha256 ${corpusSha.slice(0, 16)}…`);
  console.log(`  seeds      ${seeds.length}   from data/gen-eval/clusters.jsonl (the GOLDEN half — same in every arm)`);
  console.log(`  k          ${K}   the app's LINK_CAP, and the k every arm's clusters were built at\n`);

  // Every seed carries a judgment by construction — the golden set is drawn
  // from the dev split, which IS the qrels qid set (§19.1). Asserted rather
  // than assumed, because an unjudged seed would score 0 and be indistinguish-
  // able from a seed the retriever failed on. CLAUDE.md names exactly that
  // confusion as a sub-0.05 nDCG diagnosis.
  const unjudged = seeds.filter((s) => !qrels.has(s.id));
  if (unjudged.length > 0) {
    console.error(`${unjudged.length} seeds carry NO judgment: ${unjudged.map((s) => s.id).join(', ')}`);
    console.error('  A seed with no judgments scores 0 and looks like a retrieval failure. Refusing.');
    process.exit(1);
  }

  const rows = [];
  for (const version of retrieval.versions()) {
    const resolved = retrieval.resolvedParamsFor(version, {});
    const local = docs.map((d) => ({ id: d.id, title: d.title, body: d.body }));
    if (resolved.vectors !== undefined) {
      attachVectors({
        site: 'cooking', slug: resolved.vectors, docs: local, repoRoot: REPO,
        fail: (m) => { console.error(m); process.exit(1); }
      });
    }
    const t0 = Date.now();
    const handle = retrieval.index(version, local);
    const described = retrieval.describe(handle);
    const indexMs = Date.now() - t0;

    for (const seed of seeds) {
      const hits = retrieval.search(handle, seed.id, K);
      const judgments = qrels.get(seed.id);
      const scored = scoreQuery(hits.map((h) => h.docId), judgments, [K]);
      rows.push({
        seedId: seed.id,
        quintile: seed.quintile,
        words: seed.words,
        retriever: version,
        digest: described.digest,
        k: K,
        // The count of RELEVANT documents the key holds for this seed. Median 1
        // on this draw — see the header. Carried per row on purpose.
        judged: scored.judged,
        retrieved: hits.length,
        ndcg8: scored.ndcg[K],
        p8: scored.p[K],
        r8: scored.r[K],
        mrr: scored.mrr,
        neighbours: hits.map((h) => h.docId),
        generationArm: GENERATION_ARMS[version] || null,
        corpusSha256: corpusSha
      });
    }
    const mine = rows.filter((r) => r.retriever === version);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(
      `  ${version.padEnd(15)} nDCG@8 ${mean(mine.map((r) => r.ndcg8)).toFixed(4)}  ` +
      `zeros ${String(mine.filter((r) => r.ndcg8 === 0).length).padStart(2)}/${mine.length}  ` +
      `index ${String(indexMs).padStart(4)} ms  ` +
      `${GENERATION_ARMS[version] ? `GENERATION ARM: ${GENERATION_ARMS[version]}` : '(retrieval only)'}`
    );
  }

  const jd = rows.filter((r) => r.retriever === retrieval.versions()[0]).map((r) => r.judged).sort((a, b) => a - b);
  console.log(`\n  judged docs per seed   median ${jd[Math.floor(jd.length / 2)]}  min ${jd[0]}  max ${jd[jd.length - 1]}`);
  console.log('  A median of 1 makes a seed\'s nDCG@8 close to a BINARY event. §5.1 — the key');
  console.log('  is positive-only, so every absolute is a lower bound and this is not a');
  console.log('  property of the retrievers. Carried per row as `judged`.\n');

  // Seeds in ascending numeric id, retrievers in registration order, so the
  // file is a deterministic function of its inputs and a diff between two
  // builds is readable. NO TIMESTAMP — this regenerates byte-identically.
  const ordered = rows.slice().sort((a, b) => (
    a.retriever < b.retriever ? -1 : a.retriever > b.retriever ? 1 : Number(a.seedId) - Number(b.seedId)
  ));
  const jsonl = `${ordered.map((r) => JSON.stringify(r)).join('\n')}\n`;
  console.log(`  ${ordered.length} rows   sha256 ${crypto.createHash('sha256').update(jsonl).digest('hex')}`);
  console.log('  regenerates byte-identically — no timestamp, no RNG, no wall time\n');

  if (!has('write')) {
    console.log('  (dry run — pass --write)\n');
    return;
  }
  fs.writeFileSync(OUT, jsonl);
  console.log(`  wrote ${path.relative(REPO, OUT)}\n`);
}

if (require.main === module) main();

module.exports = { GENERATION_ARMS, K };
