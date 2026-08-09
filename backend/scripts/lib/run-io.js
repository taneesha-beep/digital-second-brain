'use strict';

/**
 * run-io.js — the TREC run/qrels loaders, in one place.
 *
 * CONSOLIDATED AT 3.7. THE COUNT IS NOW TWO BY DESIGN, NOT FIVE BY ACCIDENT,
 * and that distinction is the whole point of this comment.
 *
 * The history, because it is the reason the remaining two are not a defect.
 * 3.1's noticed-list recorded the loaders as "duplicated three ways"; the count
 * was already FOUR, and run-eval.js's own copy made five. 3.3's rule was the
 * narrow one — *a new sweep adds no copy* — which stopped the number growing
 * without reducing it. 3.5 and 3.6 both deferred the reduction. 3.6's reason
 * was specific and good: consolidating means changing the parse path inside
 * run-eval.js ON THE DAY THE TEST SPLIT IS OPENED ONCE, where a one-byte
 * behaviour change makes seven unrepeatable runs wrong. That reason expired
 * when test closed, and 3.6 said so in those words.
 *
 * ABSORBED HERE AT 3.7 — run-eval.js, sweep-v1.js, analyse-rungs.js.
 *
 * NOT ABSORBED, AND NOT PENDING. These two are deliberate and their reasons do
 * not expire:
 *
 *   emit-per-query-scores.js  is §10's evidence chain — the bridge whose output
 *                             pytrec_eval was diffed against. Refactoring it to
 *                             serve a new caller means the VALIDATED artifact
 *                             and the AUDITED artifact stop being the same bytes.
 *   compare-runs.js           is the deliberate SECOND OPINION §11.1 argues for.
 *                             The runner writes a sidecar; the comparison tool
 *                             re-derives the same aggregate from the run file
 *                             through its own parse and asserts equality at
 *                             exact float precision. Point them both at this
 *                             file and the assert becomes a tautology — it would
 *                             compare a parse against itself and pass.
 *
 * So the surviving duplication is a CHECK, not debt. Consolidating it would
 * make the code shorter and the evidence weaker.
 *
 * ONE BEHAVIOURAL CHANGE CAME WITH THE MERGE, in the safe direction: qrels
 * parsing is now VALIDATING for every caller, because run-eval.js's copy was
 * the strict one and it is the copy that survived. See loadQrelsStrict.
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

/**
 * TREC qrels: `qid 0 docid grade` -> { byQuery: Map<qid, Map<docid, grade>>, judgments }.
 *
 * THE VALIDATING PARSE, and it is run-eval.js's, moved here rather than
 * rewritten. Of the two copies that met at 3.7 this was the strict one, so it
 * is the one that survived: making every caller validate is the safe direction
 * of a merge, where making the runner permissive would have been the unsafe one.
 * On the pinned, SHA-256-verified cooking key none of these throws can fire,
 * which is exactly why the strict version costs nothing to adopt.
 *
 * The duplicate check is the load-bearing one. It is the shape of the 1.3 bug
 * that produced 18,284 judgments instead of 16,678: one pair kept twice puts
 * the document in the ideal ranking twice, inflating IDCG and silently
 * DEFLATING every nDCG that rests on it.
 */
function loadQrelsStrict(file) {
  const byQuery = new Map();
  const lines = readLines(file);
  let judgments = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const fields = lines[i].split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(`${file}:${i + 1} has ${fields.length} fields, expected 4 (qid 0 docid grade)`);
    }
    const [qid, iteration, docId, gradeText] = fields;
    if (iteration !== '0') {
      throw new Error(`${file}:${i + 1} field 2 is "${iteration}", expected the vestigial 0`);
    }
    const grade = Number(gradeText);
    if (!Number.isInteger(grade)) {
      throw new Error(`${file}:${i + 1} grade "${gradeText}" is not an integer`);
    }
    let row = byQuery.get(qid);
    if (!row) { row = new Map(); byQuery.set(qid, row); }
    if (row.has(docId)) {
      throw new Error(`${file}:${i + 1} duplicate judgment for (${qid}, ${docId})`);
    }
    row.set(docId, grade);
    judgments += 1;
  }
  return { byQuery, judgments };
}

/** The same parse, for the callers that only want the map. */
function loadQrels(file) {
  return loadQrelsStrict(file).byQuery;
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

module.exports = { readLines, sha256File, loadQrels, loadQrelsStrict, loadRun, retrievalSha256 };
