#!/usr/bin/env node
'use strict';

/**
 * emit-per-query-scores.js — the Node half of roadmap 2.4.
 *
 * Reads a written TREC run file, the qrels and a split file, and prints the
 * per-query and aggregate scores from `backend/eval/metrics.js` as JSON on
 * stdout. `scripts/validate_metrics.py` consumes that and diffs it against
 * pytrec_eval.
 *
 * WHY THIS EXISTS RATHER THAN A PYTHON REIMPLEMENTATION. EVALUATION.md §9.3
 * already records an independent Python recomputation that matched every
 * printed digit — and says plainly what it did not establish, because the same
 * conventions were implemented twice by the same person. Re-deriving the scores
 * in Python again would repeat that. The module under audit has to be the
 * shipped one, called unmodified, so this bridge requires the real
 * `backend/eval/metrics.js` and does no arithmetic of its own.
 *
 * WHAT THIS FILE IS ALLOWED TO DO. Parse files and shape inputs. Every number
 * it prints comes out of metrics.js. If a metric were computed here the
 * validation would be checking this file instead.
 *
 * THE RECONSTRUCTION IS NOT ASSUMED FAITHFUL, IT IS CHECKED. This reads the
 * *written* run file, while `run-eval.js` scored an in-memory list — so the two
 * could differ without either being wrong on its own terms. The Python side
 * asserts this aggregate against the `metrics` block of the committed sidecar,
 * which the runner wrote from that in-memory path. A mismatch there means the
 * bridge is lying, and nothing downstream of it would be worth reading.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const metrics = require(path.join(REPO_ROOT, 'backend', 'eval', 'metrics.js'));

const DEFAULT_KS = [1, 5, 8, 10];

function parseArgs(argv) {
  const args = { ks: DEFAULT_KS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--run' && value) { args.run = value; i += 1; }
    else if (flag === '--qrels' && value) { args.qrels = value; i += 1; }
    else if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--corpus' && value) { args.corpus = value; i += 1; }
    else if (flag === '--ks' && value) {
      args.ks = value.split(',').map((k) => Number.parseInt(k, 10));
      i += 1;
    } else if (flag.startsWith('--')) {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  for (const required of ['run', 'qrels', 'split', 'corpus']) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  return args;
}

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** Corpus ids only. The judgments are filtered to these, as the runner does. */
function loadCorpusIds(file) {
  const ids = new Set();
  for (const line of readLines(file)) {
    if (line === '') continue;
    ids.add(String(JSON.parse(line).id));
  }
  return ids;
}

/**
 * qrels -> Map<qid, Map<docid, grade>>, filtered to the corpus.
 *
 * The filter is applied rather than assumed away. run-eval.js asserts qrels are
 * a subset of the corpus and measures 0 violations, but that is an inherited
 * precondition — the kind CLAUDE.md warns stops holding on another site — so
 * this counts what it drops and the Python side reports the count.
 */
function loadQrels(file, corpusIds) {
  const byQuery = new Map();
  let dropped = 0;
  for (const line of readLines(file)) {
    if (line === '') continue;
    const [qid, , docid, gradeText] = line.split(/\s+/);
    if (!corpusIds.has(docid)) { dropped += 1; continue; }
    const grade = Number.parseInt(gradeText, 10);
    if (!byQuery.has(qid)) byQuery.set(qid, new Map());
    byQuery.get(qid).set(docid, grade);
  }
  return { byQuery, dropped };
}

/**
 * run file -> Map<qid, docid[]>, ordered by the run file's RANK column.
 *
 * The rank column, not the score column, and the difference is the point.
 * TREC's format treats score as authoritative and trec_eval re-sorts by it,
 * discarding rank entirely. This harness treats rank as authoritative, because
 * retrieval/index.js fixed the order (descending score, then lexicographic on
 * the id) before the file was written. On this corpus the two readings diverge
 * constantly: v1's scores take 18 distinct values across the whole dev run, so
 * 88% of adjacent pairs are score ties whose order is not recoverable from the
 * score column at all. validate_metrics.py measures what that costs instead of
 * letting it hide inside a per-query delta.
 */
function loadRun(file) {
  const byQuery = new Map();
  for (const line of readLines(file)) {
    if (line === '') continue;
    const [qid, , docid, rankText] = line.split(/\s+/);
    if (!byQuery.has(qid)) byQuery.set(qid, []);
    byQuery.get(qid).push({ docid, rank: Number.parseInt(rankText, 10) });
  }
  for (const [qid, rows] of byQuery) {
    rows.sort((a, b) => a.rank - b.rank);
    byQuery.set(qid, rows.map((r) => r.docid));
  }
  return byQuery;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const corpusIds = loadCorpusIds(args.corpus);
  const { byQuery: qrels, dropped } = loadQrels(args.qrels, corpusIds);
  const run = loadRun(args.run);
  const queryIds = readLines(args.split).filter((line) => line !== '');

  const perQuery = {};
  const ordered = [];
  for (const qid of queryIds) {
    const ranked = run.get(qid) || [];
    const judgments = qrels.get(qid) || new Map();
    const score = metrics.scoreQuery(ranked, judgments, args.ks);
    perQuery[qid] = score;
    ordered.push(score);
  }

  const aggregate = metrics.aggregate(ordered, args.ks);

  process.stdout.write(JSON.stringify({
    source: {
      run: path.relative(REPO_ROOT, path.resolve(args.run)),
      qrels: path.relative(REPO_ROOT, path.resolve(args.qrels)),
      split: path.relative(REPO_ROOT, path.resolve(args.split)),
      corpus: path.relative(REPO_ROOT, path.resolve(args.corpus))
    },
    ks: args.ks,
    corpusDocs: corpusIds.size,
    judgmentsDroppedOutsideCorpus: dropped,
    queries: queryIds.length,
    scoredBy: 'backend/eval/metrics.js',
    aggregate,
    perQuery
  }));
}

main();
