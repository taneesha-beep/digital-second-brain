'use strict';

/**
 * run-io.js — the TREC run/qrels loaders, in one place, for the tools that are
 * NOT part of a validated evidence chain.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DOES NOT ABSORB EVERY COPY. 3.1's
 * noticed-list recorded the loaders as "duplicated three ways"; the count was
 * already FOUR — scripts/emit-per-query-scores.js, scripts/compare-runs.js,
 * scripts/analyse-rungs.js and scripts/sweep-v1.js each carry their own. A new
 * sweep at 3.3 would have been a fifth, so 3.3's rule is the narrow one:
 *
 *     v4 ADDS NO COPY. It does not consolidate the existing ones.
 *
 * Two of them must not move, and the reason is §11.1's, unchanged:
 *
 *   emit-per-query-scores.js  is §10's evidence chain — the bridge whose output
 *                             pytrec_eval was diffed against. Refactoring it to
 *                             serve a new caller means the VALIDATED artifact
 *                             and the AUDITED artifact stop being the same bytes.
 *   compare-runs.js           is the deliberate second copy §11.1 argues for, so
 *                             that a divergent parse fails the sidecar equality
 *                             assert rather than agreeing with itself.
 *
 * The other two are left alone for a weaker but real reason: sweep-v1.js's
 * outputs are committed at 2.7 and analyse-rungs.js's are quoted in §14.6, so
 * touching either risks moving published bytes for no gain this session.
 *
 * Consolidation is still due at 3.6, when all six rungs are read at once. This
 * file is what keeps that number from growing in the meantime.
 */

const fs = require('fs');
const crypto = require('crypto');

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** TREC qrels: `qid 0 docid grade` -> Map<qid, Map<docid, grade>>. */
function loadQrels(file) {
  const byQuery = new Map();
  for (const line of readLines(file)) {
    if (line === '') continue;
    const [qid, , docId, gradeText] = line.split(/\s+/);
    let row = byQuery.get(qid);
    if (!row) { row = new Map(); byQuery.set(qid, row); }
    row.set(docId, Number.parseInt(gradeText, 10));
  }
  return byQuery;
}

/**
 * TREC run: `qid Q0 docid rank score runid` -> Map<qid, docid[]>.
 *
 * Ordered by the RANK COLUMN, not by file order. The writer emits them in order
 * and nothing has ever emitted them otherwise, but the run file is the artifact
 * a reader may hand to another tool, and rank is what a TREC run file means.
 */
function loadRun(file) {
  const byQuery = new Map();
  for (const line of readLines(file)) {
    if (line === '') continue;
    const [qid, , docId, rankText] = line.split(/\s+/);
    let rows = byQuery.get(qid);
    if (!rows) { rows = []; byQuery.set(qid, rows); }
    rows.push({ docId, rank: Number.parseInt(rankText, 10) });
  }
  for (const [qid, rows] of byQuery) {
    rows.sort((x, y) => x.rank - y.rank);
    byQuery.set(qid, rows.map((r) => r.docId));
  }
  return byQuery;
}

/** SHA-256 over `qid Q0 docid rank score` only — the retrieval, not the runid. */
function retrievalSha256(file) {
  const body = readLines(file).map((line) => line.split(' ').slice(0, 5).join(' ')).join('\n');
  return crypto.createHash('sha256').update(body).digest('hex');
}

module.exports = { readLines, sha256File, loadQrels, loadRun, retrievalSha256 };
