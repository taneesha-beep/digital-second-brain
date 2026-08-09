#!/usr/bin/env node
'use strict';

/**
 * analyse-contamination.js — Phase 3.6
 *
 *   cd backend && npm run analyse:contamination -- [--split test]
 *
 * The LINK-DATE contamination cut. §17.8 measured the confound with a
 * query-date cut and named this finer one as the thing that would actually
 * settle it, deferring it to 3.6 "where test opens and the same question has to
 * be asked there anyway".
 *
 * THE CONFOUND, RESTATED. `all-MiniLM-L6-v2` was trained on Stack Exchange
 * Duplicate-question pairs drawn from `flax-sentence-embeddings/stackexchange_xml`,
 * last modified 2021-07-26, and that dataset CONTAINS cooking.stackexchange.com
 * — checked against the file listing at 3.4, not assumed. `LinkTypeId = 3`
 * Duplicate is exactly the relation these qrels grade 2. So the model being
 * evaluated was trained on this site's duplicate pairs, on the relation the
 * answer key encodes. The confound cannot be removed; it can be priced.
 *
 * WHY THE LINK DATE IS THE RIGHT CUT AND THE QUERY DATE WAS THE CHEAP ONE.
 * §17.8 stratified on whether the QUERY DOCUMENT was created after the
 * snapshot, which reached 155 of 2,304 dev queries — 6.7%. But the unit the
 * model could have memorised is the PAIR, not the document: a 2015 question
 * linked to another 2015 question in 2023 was not a training pair, because the
 * link did not exist when the dump was packed. `PostLinks.xml` carries a
 * `CreationDate` on every row recording when the JUDGMENT was made (§5.3 is the
 * only reason anyone knows that — build-qrels.js parses the attribute and
 * discards it). Classifying on that reaches far more of the split.
 *
 * WHAT THIS CUT DOES *NOT* REMOVE, stated because it is the limit of the
 * measurement rather than a caveat bolted on. It removes memorisation of the
 * RELATION. It does not remove exposure to the TEXT: the same model card lists
 * 25,316,456 Stack Exchange (Title, Body) pairs, so both documents in a
 * post-snapshot pair were very likely seen individually. The claim available
 * here is therefore "the margin does not depend on having been shown this
 * pair", not "the model has never seen these documents".
 *
 * READ-ONLY, on 1.5's reasoning: it describes artifacts whose SHA-256s are
 * published, and a script that only reads cannot invalidate what it describes.
 *
 * EXPLORATORY. Not in registry.json, no p-value quoted. What the intervals
 * support is a direction.
 */

const fs = require('fs');
const path = require('path');

const { readLines, sha256File, loadQrels, loadRun } = require('./lib/run-io');
const { scoreQuery } = require('../eval/metrics');
const { pairedBootstrap } = require('../eval/bootstrap');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The dataset's last-modified date, from the HuggingFace listing read at 3.4.
// A date, not a guess: everything on either side of it is decided by this
// constant, so it is named once and printed in the report.
const SNAPSHOT = '2021-07-26';
const SNAPSHOT_MS = Date.parse(`${SNAPSHOT}T00:00:00.000Z`);

// 2.5's seed and B, unchanged. A different stream here would make these
// intervals incomparable with every other interval in the project.
const SEED = 20260804;
const RESAMPLES = 10000;
const KS = [1, 5, 8, 10];

function fail(message) {
  const err = new Error(message);
  err.assertion = true;
  throw err;
}

function parseArgs(argv) {
  const args = { site: 'cooking', split: 'test', a: 'v5-embeddings', b: 'v4-bm25', write: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--a' && value) { args.a = value; i += 1; }
    else if (flag === '--b' && value) { args.b = value; i += 1; }
    else if (flag === '--no-write') args.write = false;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// PostLinks
// ---------------------------------------------------------------------------

/**
 * Earliest link CreationDate per UNORDERED pair.
 *
 * Unordered because the qrels are symmetric — build-qrels.js writes both
 * directions from one `PostLinks` row — so a judgment (A, B) and its mirror
 * (B, A) must resolve to the same link. EARLIEST because a pair can carry more
 * than one row (Linked and Duplicate, or the same relation filed twice), and
 * the question is when the relation FIRST existed: if any row predates the
 * snapshot, the pair was available to be memorised. Taking the earliest is the
 * conservative direction — it puts ambiguous pairs in the SEEN stratum, which
 * is the stratum that cannot flatter the result.
 */
function loadLinkDates(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rowRe = /<row\b[^>]*\/>/g;
  const attr = (row, name) => {
    const m = row.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const earliest = new Map();
  let rows = 0;
  let undated = 0;
  let match;
  while ((match = rowRe.exec(text)) !== null) {
    const row = match[0];
    const postId = attr(row, 'PostId');
    const relatedId = attr(row, 'RelatedPostId');
    const created = attr(row, 'CreationDate');
    if (!postId || !relatedId) continue;
    rows += 1;
    if (!created) { undated += 1; continue; }
    const ms = Date.parse(`${created}Z`);
    const key = Number(postId) < Number(relatedId) ? `${postId}|${relatedId}` : `${relatedId}|${postId}`;
    const prior = earliest.get(key);
    if (prior === undefined || ms < prior) earliest.set(key, ms);
  }
  return { earliest, rows, undated };
}

const pairKey = (a, b) => (Number(a) < Number(b) ? `${a}|${b}` : `${b}|${a}`);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function mean(values) {
  const usable = values.filter((v) => v !== null && v !== undefined);
  return usable.length === 0 ? null : usable.reduce((x, y) => x + y, 0) / usable.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { site, split } = args;

  const qrelsFile = path.join(REPO_ROOT, 'data', 'qrels', `${site}.qrels`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${site}.${split}.txt`);
  const linksFile = path.join(REPO_ROOT, 'data', 'raw', site, 'PostLinks.xml');
  const runA = path.join(REPO_ROOT, 'results', 'runs', `${args.a}.${split}.run`);
  const runB = path.join(REPO_ROOT, 'results', 'runs', `${args.b}.${split}.run`);
  for (const file of [qrelsFile, splitFile, linksFile, runA, runB]) {
    if (!fs.existsSync(file)) fail(`${path.relative(REPO_ROOT, file)} does not exist.`);
  }

  const qrels = loadQrels(qrelsFile);
  const queryIds = readLines(splitFile).filter((l) => l !== '');
  const { earliest, rows, undated } = loadLinkDates(linksFile);
  const hitsA = loadRun(runA);
  const hitsB = loadRun(runB);

  // --- classify every judgment ---------------------------------------------
  let judgmentsSeen = 0;
  let judgmentsUnseen = 0;
  let judgmentsUnmatched = 0;
  const strata = { unseen: [], seen: [], unmatched: [] };

  for (const qid of queryIds) {
    const row = qrels.get(qid);
    if (!row) continue;
    let anySeen = false;
    let anyUnmatched = false;
    let n = 0;
    for (const docId of row.keys()) {
      n += 1;
      const ms = earliest.get(pairKey(qid, docId));
      if (ms === undefined) { anyUnmatched = true; judgmentsUnmatched += 1; continue; }
      if (ms < SNAPSHOT_MS) { anySeen = true; judgmentsSeen += 1; } else { judgmentsUnseen += 1; }
    }
    if (n === 0) continue;
    // A query is UNSEEN only if its whole key postdates the snapshot. One
    // pre-snapshot judgment is enough for the model to have been shown the
    // relation being scored, and per-query nDCG reads the whole key at once, so
    // a partially-seen query cannot be assigned to either side.
    if (anyUnmatched) strata.unmatched.push(qid);
    else if (anySeen) strata.seen.push(qid);
    else strata.unseen.push(qid);
  }

  // --- score each stratum ---------------------------------------------------
  const score = (qid, hits) => scoreQuery((hits.get(qid) || []).slice(0, 10), qrels.get(qid) || new Map(), KS);

  const lines = [];
  const w = (s = '') => lines.push(s);
  const thick = '='.repeat(78);
  const thin = '-'.repeat(78);

  w(`LINK-DATE CONTAMINATION CUT — ${args.a} vs ${args.b} on ${site}.${split}`);
  w(thick);
  w();
  w('  roadmap 3.6, deferred here by EVALUATION.md §17.8. EXPLORATORY: not in');
  w('  registry.json, no p-value quoted. The intervals support a DIRECTION.');
  w();
  w(`  training snapshot    ${SNAPSHOT} — flax-sentence-embeddings/stackexchange_xml,`);
  w('                       which contains cooking.stackexchange.com.7z. LinkTypeId 3');
  w('                       Duplicate is the relation these qrels grade 2.');
  w(`  PostLinks.xml        ${path.relative(REPO_ROOT, linksFile)}`);
  w(`                       sha256 ${sha256File(linksFile)}`);
  w(`                       ${rows} rows read, ${undated} with no CreationDate`);
  w(`  unordered pairs      ${earliest.size} distinct, keyed on the EARLIEST link date`);
  w();
  w('  A judgment is SEEN if the link creating it predates the snapshot — the pair');
  w('  was in the dump the model trained on. A QUERY is UNSEEN only if its WHOLE key');
  w('  postdates it: one seen judgment is enough for the relation to have been');
  w('  available, and per-query nDCG reads the whole key at once. Ambiguity is');
  w('  resolved toward SEEN, which is the stratum that cannot flatter the result.');
  w();

  w('1. WHAT THE CUT REACHES');
  w(thin);
  w(`  ${split} queries with a key    ${strata.seen.length + strata.unseen.length + strata.unmatched.length}`);
  w(`    fully post-snapshot     ${strata.unseen.length}  (${((strata.unseen.length / queryIds.length) * 100).toFixed(1)}% of the split)`);
  w(`    any pre-snapshot        ${strata.seen.length}`);
  w(`    unmatched in PostLinks  ${strata.unmatched.length}`);
  w(`  judgments  seen ${judgmentsSeen} · unseen ${judgmentsUnseen} · unmatched ${judgmentsUnmatched}`);
  w();
  w('  §17.8\'s query-date cut reached 155 of 2,304 dev queries — 6.7%. This one is');
  w('  the comparison that matters for whether the finer cut was worth building.');
  w();

  w('2. THE MARGIN, WITHIN EACH STRATUM');
  w(thin);
  const colB = `${args.b} nDCG@8`;
  const colA = `${args.a} nDCG@8`;
  const wide = Math.max(colA.length, colB.length, 18) + 2;
  w('  stratum          n      ' + colB.padEnd(wide) + colA.padEnd(wide) + 'A − B        95% CI');
  w('  ' + '-'.repeat(56 + 2 * wide));

  const rowsOut = [];
  for (const [name, ids] of [['unseen', strata.unseen], ['seen', strata.seen], ['unmatched', strata.unmatched]]) {
    if (ids.length === 0) continue;
    const perA = ids.map((qid) => score(qid, hitsA).ndcg[8]);
    const perB = ids.map((qid) => score(qid, hitsB).ndcg[8]);
    const paired = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (perA[i] === null || perB[i] === null) continue;
      paired.push(perA[i] - perB[i]);
    }
    const boot = pairedBootstrap(paired, { seed: SEED, resamples: RESAMPLES, alpha: 0.05 });
    const mA = mean(perA);
    const mB = mean(perB);
    rowsOut.push({ name, n: ids.length, mA, mB, diff: boot.observedMeanDifference, ci: boot.ci });
    w(`  ${name.padEnd(14)} ${String(ids.length).padStart(5)}      ` +
      `${mB.toFixed(6).padEnd(wide)}${mA.toFixed(6).padEnd(wide)}` +
      `${(boot.observedMeanDifference >= 0 ? '+' : '')}${boot.observedMeanDifference.toFixed(6)}    ` +
      `[${boot.ci[0] >= 0 ? '+' : ''}${boot.ci[0].toFixed(4)}, ${boot.ci[1] >= 0 ? '+' : ''}${boot.ci[1].toFixed(4)}]`);
  }
  w();
  w('  THE COMPARISON IS OF THE DIFFERENCE WITHIN EACH STRATUM, NEVER OF THE ABSOLUTE');
  w('  LEVELS ACROSS THEM. §5.3 measured that per-query scores are not comparable');
  w('  across corpus age, because a document\'s judged degree tracks how much corpus');
  w('  was created after it. Both absolute columns move between strata for that');
  w('  reason, and that movement is §5.3\'s effect rather than a finding here.');
  w();
  w('  AND IT REMOVES MEMORISATION OF THE RELATION, NOT EXPOSURE TO THE TEXT. The');
  w('  same model card lists 25,316,456 Stack Exchange (Title, Body) pairs, so both');
  w('  documents in a post-snapshot pair were very likely seen individually. What is');
  w('  supported is "the margin does not depend on having been shown this pair".');
  w();

  w('3. ENVIRONMENT');
  w(thin);
  w(`  runs                 ${path.relative(REPO_ROOT, runA)}  sha256 ${sha256File(runA)}`);
  w(`                       ${path.relative(REPO_ROOT, runB)}  sha256 ${sha256File(runB)}`);
  w(`  qrels                ${path.relative(REPO_ROOT, qrelsFile)}  sha256 ${sha256File(qrelsFile)}`);
  w(`  bootstrap            seed ${SEED}, B = ${RESAMPLES}, mulberry32 — 2.5's stream, unchanged`);
  w(`  node                 ${process.version}`);
  w();
  w(thick);

  const text = `${lines.join('\n')}\n`;
  console.log(text);
  if (args.write) {
    const out = path.join(REPO_ROOT, 'results', `contamination-linkdate.${split}.txt`);
    fs.writeFileSync(out, text);
    console.log(`  written to ${path.relative(REPO_ROOT, out)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\ncontamination analysis failed: ${err.message}`);
    if (!err.assertion) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { loadLinkDates, pairKey };
