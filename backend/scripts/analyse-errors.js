#!/usr/bin/env node
'use strict';

/**
 * analyse-errors.js — Phase 3.7
 *
 *   cd backend && npm run analyse:errors
 *   cd backend && npm run analyse:errors -- --no-write
 *
 * THE PER-QUERY ERROR ANALYSIS. Roadmap 3.7 says "take the 20 worst queries
 * under the winning retriever and categorize why they failed". Two of those
 * words do not survive contact with this answer key, and this script exists to
 * replace them with something that answers a question.
 *
 * ---------------------------------------------------------------------------
 * WHY "THE 20 WORST" IS NOT A SELECTION RULE
 * ---------------------------------------------------------------------------
 *
 * The key has a MEDIAN OF ONE judgment per query (§3.3, §19.3), so a query
 * scores exactly 0.0 at nDCG@8 whenever its one judged document misses the top
 * 8. That is not a handful of queries; section 2 below counts them. "The worst
 * 20" is therefore a draw from a tie of several hundred, and the draw is not
 * neutral: §5.3 measured that a document's judged degree tracks HOW MUCH CORPUS
 * WAS CREATED AFTER IT (rho = +0.181, a 2010 question ~4.5x more judged than a
 * 2024 one), so ordering by raw nDCG@8 preferentially surfaces recent,
 * thinly-judged queries where the retriever may have done nothing wrong. §5.3
 * says so in terms: any per-query error analysis "must check the age of a
 * failing query before concluding the retriever failed on it."
 *
 * So the population is defined first and the sample is STRATIFIED:
 *
 *   POPULATION   dev queries with v5 nDCG@8 EXACTLY 0 — v5 placed no judged
 *                document in its top 8. Every dev query is judgeable (§19.1
 *                records 0 unjudgeable), so this means one thing only.
 *
 *   AXIS 1       REACHABLE — does ANY of the six rungs place a judged document
 *                for this query in its top 10? A lower bound on reachability:
 *                a rung might find it at rank 11 and the run file stops at 10.
 *
 *   AXIS 2       KEY SIZE — exactly 1 judgment, or 2 and above.
 *
 *   SAMPLE       5 from each of the four cells. Within a cell, qids sorted
 *                numerically and 5 taken EVENLY SPACED across the range.
 *
 * THE EVEN SPACING IS DELIBERATE AND IT COSTS SOMETHING, SO IT IS NAMED HERE.
 * Corpus ids ascend with creation date, so spacing across the qid range spreads
 * the hand-read sample across corpus age instead of letting §5.3 choose it.
 * The price is that the 20's OWN age distribution is a property of the sampling
 * and is not evidence of anything. THE AGE FINDING COMES FROM SECTION 4, over
 * all 2,304 queries. Twenty cases cannot carry a distribution.
 *
 * REJECTED, recorded because a selection rule with no rejected alternatives is
 * a rationalisation:
 *
 *   raw nDCG@8 ascending          undefined (the tie), and §5.3-loaded
 *   ascending, tie-broken by key  fills all 20 with the largest keys and hides
 *     size descending             the modal failure — 62.6% of dev has key 1
 *   uniform random from the zero  no §5.3 protection; ~2 in 3 would be key-1,
 *     population                  so one cell is learned and three are not
 *   worst 20 by residual against  isolates v5-specific failure well, and by
 *     the best sibling rung       construction selects ONLY reachable queries,
 *                                 excluding the largest expected bucket. Folded
 *                                 in as axis 1 rather than used as the rule
 *   a composite severity index    composite indices hide their weights; explicit
 *                                 strata say the same thing and can be argued with
 *
 * PARTIAL FAILURES ARE OUT OF POPULATION BY CHOICE. A query scoring 0.15 with
 * twelve judgments is a real thing to look at, but with a median key of 1,
 * nDCG@8 > 0 usually means the judged document WAS found and the residual is a
 * RANKING question, not a RETRIEVAL one. Section 5 reports rank-of-first-hit
 * over the whole split so that phenomenon is visible; it is not averaged into
 * this taxonomy.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COMPUTABLE HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * C0..C3 below are computed from run files and partition the zero population.
 * They are [MEASURED] over ALL 2,304 dev queries and they are what Phase 7.1's
 * "observed frequency from a named eval run" can be built from.
 *
 * The reasons a query failed — right topic wrong specificity, the key not
 * knowing about a correct result, a query with no signal in it — are NOT
 * computable and are not attempted here. They are assigned by reading, in
 * results/error-analysis-cases.csv, under the protocol in results/error-analysis.md.
 * This script writes the CASEBOOK those readings are made against so the
 * reading is reproducible against exactly the text that was read.
 *
 * DEV ONLY, AND THE REFUSAL IS IN THE CODE. --split test exits 1. The test run
 * files exist on disk and reading them would not trip results/runs/test-openings.json,
 * which governs PRODUCING a run. That is exactly why the refusal is here: 3.7's
 * output feeds Phase 7, Phase 7 feeds mitigations, and §19.9 says any future
 * change to a retriever is measured on dev. An error analysis that learns where
 * v5 fails FROM TEST makes test an input to design without ever tripping the
 * ledger, which is the quiet version of the failure the ledger exists to stop.
 *
 * READ-ONLY over every input, on §5's reasoning: it describes artifacts whose
 * SHA-256s are published, and a script that only reads cannot invalidate what
 * it describes. It writes only its own two reports.
 */

const fs = require('fs');
const path = require('path');

const { readLines, sha256File, loadQrels, loadRun } = require('./lib/run-io');
const { scoreQuery } = require('../eval/metrics');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The ladder, in order. The winner is last-but-one; v6 is included because
// reachability is a question about the LADDER, not about v5's competitors.
const RUNGS = ['v1-overlap', 'v2-jaccard', 'v3-tfidf', 'v4-bm25', 'v5-embeddings', 'v6-hybrid'];
const WINNER = 'v5-embeddings';
const KS = [1, 5, 8, 10];
const PER_CELL = 5;

function fail(message) {
  const err = new Error(message);
  err.assertion = true;
  throw err;
}

function parseArgs(argv) {
  const args = { site: 'cooking', split: 'dev', winner: WINNER, write: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--no-write') args.write = false;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  if (args.split === 'test') {
    fail(
      'REFUSED: this analysis does not run on test.\n' +
      '    The test run files exist and reading them would not trip the openings\n' +
      '    ledger, which governs producing a run. That is the reason for this\n' +
      '    refusal rather than an argument against it: 3.7 feeds Phase 7, which\n' +
      '    feeds design, and EVALUATION.md §19.9 says any future change to a\n' +
      '    retriever is measured on dev. Learning where the winner fails FROM\n' +
      '    TEST makes test a design input without ever tripping the ledger.\n' +
      '    If a stated reason ever justifies it, delete this check in its own\n' +
      '    commit with the reason in the message.'
    );
  }
  return args;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** corpus -> Map<id, {title, body, tags, score, creationDate, ms}>. */
function loadCorpus(file) {
  const byId = new Map();
  for (const line of readLines(file)) {
    if (line === '') continue;
    const doc = JSON.parse(line);
    // No timezone is appended to creationDate anywhere in this project (§2's
    // record schema). Every use here is a COMPARISON between two dates under
    // the same convention, so the offset cancels, exactly as §5.3's lag
    // measurement relies on.
    byId.set(doc.id, { ...doc, ms: Date.parse(doc.creationDate) });
  }
  return byId;
}

/**
 * PostLinks roles, per §5.2. A judged document sits at one of two ends of a
 * moderation workflow and the two ends have opposite quality distributions:
 * a duplicate's PostId is the question that got CLOSED (median score 1) and its
 * RelatedPostId is the canonical target (median score 16). Whether failures
 * concentrate at one end is a question §5.2 raises and nothing has answered.
 */
function loadRoles(file, corpusIds) {
  const text = fs.readFileSync(file, 'utf8');
  const rowRe = /<row\b[^>]*\/>/g;
  const attr = (row, name) => {
    const m = row.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : null;
  };
  const roles = new Map();
  const mark = (id, role) => {
    if (!corpusIds.has(id)) return;
    let set = roles.get(id);
    if (!set) { set = new Set(); roles.set(id, set); }
    set.add(role);
  };
  let match;
  let rows = 0;
  while ((match = rowRe.exec(text)) !== null) {
    const row = match[0];
    const postId = attr(row, 'PostId');
    const relatedId = attr(row, 'RelatedPostId');
    const type = attr(row, 'LinkTypeId');
    if (!postId || !relatedId) continue;
    rows += 1;
    if (type === '3') { mark(postId, 'dup-closed'); mark(relatedId, 'dup-canonical'); }
    else { mark(postId, 'links-out'); mark(relatedId, 'pointed-at'); }
  }
  return { roles, rows };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Rank of the first judged document in a ranked list, or 0 if there is none. */
function firstHitRank(ranked, judged) {
  for (let i = 0; i < ranked.length; i += 1) if (judged.has(ranked[i])) return i + 1;
  return 0;
}

/**
 * Evenly spaced picks across a sorted array — indices round(i*(n-1)/(m-1)).
 * Deterministic, endpoint-inclusive, and it degrades to "take everything" when
 * the cell is smaller than the quota.
 */
function evenlySpaced(sorted, m) {
  if (sorted.length <= m) return [...sorted];
  const out = [];
  for (let i = 0; i < m; i += 1) {
    const idx = Math.round((i * (sorted.length - 1)) / (m - 1));
    if (!out.includes(sorted[idx])) out.push(sorted[idx]);
  }
  // Rounding can collide on tiny cells; fill forward from the start.
  for (let i = 0; out.length < m && i < sorted.length; i += 1) {
    if (!out.includes(sorted[i])) out.push(sorted[i]);
  }
  return out.sort((a, b) => Number(a) - Number(b));
}

/**
 * Bin by UPPER BOUND — a value lands in the first band whose `max` it does not
 * exceed, and the last band is the catch-all.
 *
 * Written this way after the first draft compared against `bins[i + 1].max`,
 * which silently made band 0 mean "everything below band 1" — the "exactly 0"
 * row came out 1054 against a zero population of 1039, and the 15 queries in
 * between were the only reason it was visible at all. A binning function whose
 * first row disagrees with a count computed elsewhere in the same report is the
 * cheap version of this bug; one whose rows are merely all slightly wrong is
 * not, and would have shipped.
 */
function histogram(values, bins) {
  const counts = new Array(bins.length).fill(0);
  for (const v of values) {
    for (let i = 0; i < bins.length; i += 1) {
      if (i === bins.length - 1 || v <= bins[i].max) { counts[i] += 1; break; }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { site, split } = args;

  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${site}.jsonl`);
  const qrelsFile = path.join(REPO_ROOT, 'data', 'qrels', `${site}.qrels`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${site}.${split}.txt`);
  const linksFile = path.join(REPO_ROOT, 'data', 'raw', site, 'PostLinks.xml');
  const runFiles = Object.fromEntries(
    RUNGS.map((r) => [r, path.join(REPO_ROOT, 'results', 'runs', `${r}.${split}.run`)])
  );

  for (const file of [corpusFile, qrelsFile, splitFile, linksFile, ...Object.values(runFiles)]) {
    if (!fs.existsSync(file)) {
      fail(
        `${path.relative(REPO_ROOT, file)} does not exist.\n` +
        '    Run files are gitignored and regenerate in seconds (§8.5):\n' +
        '      npm run eval -- --retriever <version> --split dev'
      );
    }
  }

  const corpus = loadCorpus(corpusFile);
  const qrels = loadQrels(qrelsFile);
  const queryIds = readLines(splitFile).filter((l) => l !== '');
  const runs = Object.fromEntries(RUNGS.map((r) => [r, loadRun(runFiles[r])]));
  const { roles, rows: linkRows } = loadRoles(linksFile, new Set(corpus.keys()));

  // Judged degree over the WHOLE corpus, for §5.2's hub covariate.
  const degree = new Map();
  for (const [, row] of qrels) for (const docId of row.keys()) degree.set(docId, (degree.get(docId) || 0) + 1);

  // §5.3's axis: decile of "documents created after this one". D1 newest,
  // D10 oldest. Computed exactly as §5.3 computes it so the two are comparable.
  const byAge = [...corpus.values()].sort((a, b) => a.ms - b.ms || Number(a.id) - Number(b.id));
  const ageDecile = new Map();
  for (let rank = 0; rank < byAge.length; rank += 1) {
    const createdAfter = byAge.length - 1 - rank;
    const d = Math.min(10, Math.floor((createdAfter / byAge.length) * 10) + 1);
    ageDecile.set(byAge[rank].id, d);
  }

  // --- per-query record -----------------------------------------------------
  const records = [];
  for (const qid of queryIds) {
    const row = qrels.get(qid) || new Map();
    const judged = new Set(row.keys());
    if (judged.size === 0) continue; // §19.1: 0 of these on dev. Kept for safety.
    const doc = corpus.get(qid);
    if (!doc) fail(`query ${qid} is in the split and not in the corpus`);

    const perRung = {};
    for (const rung of RUNGS) {
      const ranked = (runs[rung].get(qid) || []).slice(0, 10);
      perRung[rung] = {
        ranked,
        score: scoreQuery(ranked, row, KS),
        firstHit: firstHitRank(ranked, judged)
      };
    }

    const w = perRung[args.winner];
    const reachedBy = RUNGS.filter((r) => perRung[r].firstHit > 0);

    records.push({
      qid,
      doc,
      judged,
      keySize: judged.size,
      grades: [...row.values()],
      ndcg8: w.score.ndcg[8],
      ndcg10: w.score.ndcg[10],
      firstHit: w.firstHit,
      reachedBy,
      reachable: reachedBy.length > 0,
      perRung,
      decile: ageDecile.get(qid),
      year: doc.creationDate.slice(0, 4),
      queryTokens: `${doc.title} ${doc.body}`.split(/\s+/).filter((t) => t !== '').length,
      maxJudgedDegree: Math.max(...[...judged].map((d) => degree.get(d) || 0)),
      roles: [...(roles.get(qid) || [])].sort()
    });
  }

  const zero = records.filter((r) => r.ndcg8 === 0);
  const nonzero = records.filter((r) => r.ndcg8 !== 0);

  // --- the computable taxonomy, a partition of the zero population ----------
  const category = (r) => {
    if (r.perRung[args.winner].ranked.length === 0) return 'C0';
    if (r.firstHit > 0) return 'C1';             // in v5's top 10, below rank 8
    if (r.reachable) return 'C2';                // a sibling rung found it
    return 'C3';                                 // no rung reached the key
  };
  for (const r of zero) r.category = category(r);
  const CATEGORIES = ['C0', 'C1', 'C2', 'C3'];
  const catCount = Object.fromEntries(CATEGORIES.map((c) => [c, zero.filter((r) => r.category === c).length]));

  // --- the stratified sample ------------------------------------------------
  const cellOf = (r) => `${r.reachable ? 'reachable' : 'unreachable'}/${r.keySize === 1 ? 'key1' : 'key2+'}`;
  const CELLS = ['reachable/key1', 'reachable/key2+', 'unreachable/key1', 'unreachable/key2+'];
  const cells = Object.fromEntries(CELLS.map((c) => [c, []]));
  for (const r of zero) cells[cellOf(r)].push(r);
  for (const c of CELLS) cells[c].sort((a, b) => Number(a.qid) - Number(b.qid));

  const picked = {};
  const shortfalls = [];
  for (const c of CELLS) {
    const ids = cells[c].map((r) => r.qid);
    picked[c] = evenlySpaced(ids, PER_CELL);
    if (picked[c].length < PER_CELL) shortfalls.push({ cell: c, have: picked[c].length });
  }
  // Pre-declared fallback: a short cell is taken whole and the deficit is made
  // up from the LARGEST cell, continuing its even spacing at a finer step.
  let deficit = shortfalls.reduce((a, s) => a + (PER_CELL - s.have), 0);
  if (deficit > 0) {
    const largest = CELLS.slice().sort((a, b) => cells[b].length - cells[a].length)[0];
    const ids = cells[largest].map((r) => r.qid);
    const wider = evenlySpaced(ids, PER_CELL + deficit);
    for (const id of wider) {
      if (deficit === 0) break;
      if (!picked[largest].includes(id)) { picked[largest].push(id); deficit -= 1; }
    }
    picked[largest].sort((a, b) => Number(a) - Number(b));
  }
  const selected = CELLS.flatMap((c) => picked[c].map((qid) => ({ cell: c, record: zero.find((r) => r.qid === qid) })));

  // --- report ---------------------------------------------------------------
  const lines = [];
  const w = (s = '') => lines.push(s);
  const thick = '='.repeat(78);
  const thin = '-'.repeat(78);

  w(`PER-QUERY ERROR ANALYSIS — ${args.winner} on ${site}.${split}`);
  w(thick);
  w();
  w('  roadmap 3.7. DEV ONLY — --split test is refused by this script, not by');
  w('  discipline. §19.9: test is spent, and this analysis feeds Phase 7, which');
  w('  feeds design. Reading test here would make it a design input without ever');
  w('  tripping results/runs/test-openings.json, which governs producing a run.');
  w();
  w('  EVERYTHING IN THIS FILE IS COMPUTED. Why a query failed is NOT computable');
  w('  and is not attempted here — that is results/error-analysis-cases.csv, read');
  w('  by hand under the protocol in results/error-analysis.md, against the');
  w('  casebook this script writes beside it.');
  w();

  w('1. INPUTS');
  w(thin);
  w(`  corpus     ${path.relative(REPO_ROOT, corpusFile)}`);
  w(`             sha256 ${sha256File(corpusFile)}  N=${corpus.size}`);
  w(`  qrels      ${path.relative(REPO_ROOT, qrelsFile)}`);
  w(`             sha256 ${sha256File(qrelsFile)}`);
  w(`  split      ${path.relative(REPO_ROOT, splitFile)}`);
  w(`             sha256 ${sha256File(splitFile)}  ${queryIds.length} queries`);
  w(`  PostLinks  ${path.relative(REPO_ROOT, linksFile)}  ${linkRows} rows read`);
  for (const rung of RUNGS) {
    w(`  run        ${path.relative(REPO_ROOT, runFiles[rung]).padEnd(38)} sha256 ${sha256File(runFiles[rung])}`);
  }
  w();

  w('2. THE POPULATION');
  w(thin);
  const bands = [
    { label: 'exactly 0', max: 1e-12 },
    { label: '0 < x <= 0.1', max: 0.1 + 1e-12 },
    { label: '0.1 < x <= 0.25', max: 0.25 + 1e-12 },
    { label: '0.25 < x <= 0.5', max: 0.5 + 1e-12 },
    { label: '0.5 < x < 1', max: 1 - 1e-12 },
    { label: 'exactly 1', max: Infinity }
  ];
  const counts = histogram(records.map((r) => r.ndcg8), bands);
  w(`  ${args.winner} nDCG@8 over ${records.length} judgeable ${split} queries`);
  w();
  w('  band              queries    share');
  w('  ' + '-'.repeat(38));
  for (let i = 0; i < bands.length; i += 1) {
    w(`  ${bands[i].label.padEnd(17)} ${String(counts[i]).padStart(6)}   ${((counts[i] / records.length) * 100).toFixed(1)}%`);
  }
  w();
  w(`  THE ZERO POPULATION IS ${zero.length} QUERIES — ${((zero.length / records.length) * 100).toFixed(1)}% of the split. That is the`);
  w('  tie "the 20 worst" would have been drawn from, and it is why the selection');
  w('  rule is stratified rather than an ordering. See the header of this script.');
  w();
  w('  A ZERO IS NOT A SYNONYM FOR A RETRIEVAL FAILURE, and the rest of this file');
  w('  is about the difference. §17.6 read ten dev queries by hand at 3.4 and found');
  w('  every one of v5\'s top-5 lists topically correct with only 2 of 10 carrying a');
  w('  judged document anywhere in the top 5.');
  w();

  w('3. THE COMPUTABLE TAXONOMY — a partition of the zero population');
  w(thin);
  const catText = {
    C0: 'zero-result — the retriever returned nothing',
    C1: 'near-miss — a judged document at rank 9 or 10',
    C2: 'sibling-reachable — a rung found one, v5 did not',
    C3: 'unreachable — no rung reached the key at all'
  };
  w('  cat  meaning                                            queries   of zero   of split');
  w('  ' + '-'.repeat(84));
  for (const c of CATEGORIES) {
    const n = catCount[c];
    w(`  ${c}   ${catText[c].padEnd(50)} ${String(n).padStart(5)}    ${((n / zero.length) * 100).toFixed(1).padStart(6)}%   ${((n / records.length) * 100).toFixed(1).padStart(7)}%`);
  }
  w('  ' + '-'.repeat(84));
  w(`  ${'total'.padEnd(55)} ${String(zero.length).padStart(5)}     100.0%   ${((zero.length / records.length) * 100).toFixed(1).padStart(7)}%`);
  w();
  w('  THE "of split" COLUMN IS THE ONE PHASE 7.1 CAN USE. It is a rate over a');
  w('  named eval run with a SHA-256, which is what "observed frequency from a');
  w('  named eval run" means. The hand-read categories are NOT rates and section 7');
  w('  says why they cannot be turned into any.');
  w();
  w('  WHICH RUNG REACHES A KEY v5 MISSES — over the C2 queries only:');
  const c2 = zero.filter((r) => r.category === 'C2');
  w();
  w('    rung            reached   share of C2');
  w('    ' + '-'.repeat(40));
  for (const rung of RUNGS) {
    if (rung === args.winner) continue;
    const n = c2.filter((r) => r.reachedBy.includes(rung)).length;
    w(`    ${rung.padEnd(15)} ${String(n).padStart(6)}     ${c2.length ? ((n / c2.length) * 100).toFixed(1) : '0.0'}%`);
  }
  w();
  w('  A rung appears here when it placed a judged document in its top 10 and v5');
  w('  did not. Rows overlap — a query reached by three rungs is counted three');
  w('  times — so they do not sum to C2.');
  w();

  w('4. AGE — §5.3\'s CHECK, WITH THE BASELINE IT DEMANDS');
  w(thin);
  w('  §5.3: a document\'s judged degree tracks how much corpus was created AFTER');
  w('  it, rho = +0.181, and per-query scores are therefore NOT comparable across');
  w('  corpus age. The decile below is §5.3\'s own axis, recomputed: D1 is the');
  w('  newest tenth of the corpus, D10 the oldest.');
  w();
  w('  decile   split queries   zero pop   share of decile   mean key size');
  w('  ' + '-'.repeat(70));
  for (let d = 1; d <= 10; d += 1) {
    const inSplit = records.filter((r) => r.decile === d);
    const inZero = zero.filter((r) => r.decile === d);
    if (inSplit.length === 0) continue;
    w(`  D${String(d).padEnd(7)} ${String(inSplit.length).padStart(12)} ${String(inZero.length).padStart(10)}   ` +
      `${((inZero.length / inSplit.length) * 100).toFixed(1).padStart(13)}%   ${mean(inSplit.map((r) => r.keySize)).toFixed(3).padStart(12)}`);
  }
  w();
  const zeroDec = mean(zero.map((r) => r.decile));
  const nonzeroDec = mean(nonzero.map((r) => r.decile));
  w(`  mean decile — zero population ${zeroDec.toFixed(3)}, scoring population ${nonzeroDec.toFixed(3)}`);
  w(`  mean key size — zero ${mean(zero.map((r) => r.keySize)).toFixed(3)}, scoring ${mean(nonzero.map((r) => r.keySize)).toFixed(3)}`);
  w(`  median key size — zero ${median(zero.map((r) => r.keySize))}, scoring ${median(nonzero.map((r) => r.keySize))}`);
  w();
  w('  A HIGHER MEAN DECILE MEANS OLDER. If the zero population is the YOUNGER of');
  w('  the two, §5.3 is acting exactly as it predicted and a chunk of these queries');
  w('  are thin-key rather than badly retrieved. If it is not, that prediction fails');
  w('  on this population and the failures are not explained by age.');
  w();
  w('  BY CATEGORY:');
  w();
  w('    cat   mean decile   mean key size   mean query tokens   median first-hit rank');
  w('    ' + '-'.repeat(76));
  for (const c of CATEGORIES) {
    const rs = zero.filter((r) => r.category === c);
    if (rs.length === 0) { w(`    ${c}    ${'—'.padStart(11)}`); continue; }
    const hits = rs.map((r) => r.firstHit).filter((h) => h > 0);
    w(`    ${c}    ${mean(rs.map((r) => r.decile)).toFixed(3).padStart(11)}   ${mean(rs.map((r) => r.keySize)).toFixed(3).padStart(13)}   ` +
      `${mean(rs.map((r) => r.queryTokens)).toFixed(1).padStart(17)}   ${(hits.length ? String(median(hits)) : 'n/a').padStart(21)}`);
  }
  w();

  w('5. RANK OF THE FIRST JUDGED HIT — the partial failures, not in the taxonomy');
  w(thin);
  w('  Over all judgeable queries, where v5 puts the first judged document. This is');
  w('  the RANKING view the population definition deliberately excludes, reported');
  w('  so the exclusion is visible rather than silent.');
  w();
  const rankBins = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  w('    rank    queries    cumulative');
  w('    ' + '-'.repeat(34));
  let cum = 0;
  for (const rank of rankBins) {
    const n = records.filter((r) => r.firstHit === rank).length;
    cum += n;
    w(`    ${String(rank).padStart(4)} ${String(n).padStart(10)} ${((cum / records.length) * 100).toFixed(1).padStart(12)}%`);
  }
  const none = records.filter((r) => r.firstHit === 0).length;
  w(`    none ${String(none).padStart(10)} ${'100.0'.padStart(12)}%`);
  w();

  w('6. §5.2\'s TWO ROLES — where the failures sit in the moderation workflow');
  w(thin);
  w('  §5.2 measured the judged set as BIMODAL rather than popular: a duplicate\'s');
  w('  PostId is the question that got CLOSED (median score 1) and its');
  w('  RelatedPostId is the canonical target (median score 16). Whether failures');
  w('  concentrate at one end is a question §5.2 raises and nothing has answered.');
  w();
  const ROLE_NAMES = ['dup-closed', 'dup-canonical', 'links-out', 'pointed-at'];
  w('    role             split queries   zero pop   zero rate');
  w('    ' + '-'.repeat(56));
  for (const role of ROLE_NAMES) {
    const inSplit = records.filter((r) => r.roles.includes(role));
    const inZero = zero.filter((r) => r.roles.includes(role));
    w(`    ${role.padEnd(16)} ${String(inSplit.length).padStart(13)} ${String(inZero.length).padStart(10)}   ` +
      `${(inSplit.length ? ((inZero.length / inSplit.length) * 100).toFixed(1) : '0.0').padStart(8)}%`);
  }
  w();
  w('  Roles overlap — a question can be both closed as a duplicate and pointed at');
  w('  — so these rows do not sum to the split.');
  w();

  w('6a. GRADE COMPOSITION — is a "linked" judgment a relevance judgment at all?');
  w(thin);
  w('  ADDED AFTER THE HAND READ, AND THE PREDICTION WAS WRITTEN BEFORE IT RAN.');
  w('  Case 52209 ("How do I pick the best fillet mignon at the supermarket?") is');
  w('  judged against two documents about SALTING a steak, which is not what the');
  w('  question asks. §2.1: LinkTypeId 1 records that an answer or comment');
  w('  REFERENCED another question — a citation, not a claim that the two questions');
  w('  are about the same thing. LinkTypeId 3, grade 2, is a duplicate closure, and');
  w('  that one IS a same-question claim. If the distinction is real, queries whose');
  w('  key contains a grade 2 should fail markedly less often. Predicted before');
  w('  running: a gap of 10 to 20 points.');
  w();
  const allLinked = records.filter((r) => r.grades.every((g) => g === 1));
  const anyDup = records.filter((r) => r.grades.some((g) => g === 2));
  w('    key composition          queries   zero pop   zero rate   mean nDCG@8');
  w('    ' + '-'.repeat(66));
  for (const [name, rs] of [['grade 1 only (linked)', allLinked], ['any grade 2 (duplicate)', anyDup]]) {
    const z = rs.filter((r) => r.ndcg8 === 0).length;
    w(`    ${name.padEnd(24)} ${String(rs.length).padStart(7)} ${String(z).padStart(10)}   ` +
      `${((z / rs.length) * 100).toFixed(1).padStart(8)}%   ${mean(rs.map((r) => r.ndcg8)).toFixed(6).padStart(11)}`);
  }
  w();

  w('6b. HUB JUDGMENTS — §5.2\'s concentration, landing on the failures');
  w(thin);
  w('  ALSO ADDED AFTER THE HAND READ. Three of the twenty cases are judged against');
  w('  a top-three corpus hub: 784 (degree 103, a US/UK/AU dialect glossary) appears');
  w('  in two of them, and 21068 (degree 209, the food-storage reference) in a');
  w('  third. §5.2 measured 9 documents carrying 4.5% of all judgments; whether');
  w('  that concentration lands disproportionately on failures is computable.');
  w();
  const degrees = [...degree.values()].sort((a, b) => b - a);
  const top1pc = degrees[Math.floor(degrees.length * 0.01)];
  const hubbed = (r) => r.maxJudgedDegree >= top1pc;
  w(`  Top 1% of judged documents starts at degree ${top1pc} (§5.2's 92-document band).`);
  w();
  w('    key contains a top-1% hub   queries   zero pop   zero rate   mean nDCG@8');
  w('    ' + '-'.repeat(70));
  for (const [name, rs] of [['yes', records.filter(hubbed)], ['no', records.filter((r) => !hubbed(r))]]) {
    const z = rs.filter((r) => r.ndcg8 === 0).length;
    w(`    ${name.padEnd(27)} ${String(rs.length).padStart(6)} ${String(z).padStart(10)}   ` +
      `${((z / rs.length) * 100).toFixed(1).padStart(8)}%   ${mean(rs.map((r) => r.ndcg8)).toFixed(6).padStart(11)}`);
  }
  w();
  w(`  mean max judged degree — zero ${mean(zero.map((r) => r.maxJudgedDegree)).toFixed(3)}, ` +
    `scoring ${mean(nonzero.map((r) => r.maxJudgedDegree)).toFixed(3)}`);
  w(`  median max judged degree — zero ${median(zero.map((r) => r.maxJudgedDegree))}, ` +
    `scoring ${median(nonzero.map((r) => r.maxJudgedDegree))}`);
  w();
  w('  BOTH 6a AND 6b ARE DESCRIPTIVE AND NEITHER IS CONTROLLED. Grade composition');
  w('  and hub degree are correlated with each other and with corpus age (§5.3), so');
  w('  these rows do not attribute the gap to any one of the three.');
  w();

  w('7. THE TWENTY, AND THE RULE THAT CHOSE THEM');
  w(thin);
  w('  Population: nDCG@8 exactly 0. Two axes: REACHABLE (any of the six rungs');
  w('  placed a judged document in its top 10 — a LOWER BOUND, the run files stop');
  w('  at 10) and KEY SIZE (1, or 2 and above). Five per cell, qids sorted');
  w(`  numerically and taken evenly spaced across the range.`);
  w();
  w('    cell                 population   picked');
  w('    ' + '-'.repeat(46));
  for (const c of CELLS) {
    w(`    ${c.padEnd(20)} ${String(cells[c].length).padStart(10)}   ${String(picked[c].length).padStart(6)}`);
  }
  w('    ' + '-'.repeat(46));
  w(`    ${'total'.padEnd(20)} ${String(zero.length).padStart(10)}   ${String(selected.length).padStart(6)}`);
  if (shortfalls.length > 0) {
    w();
    for (const s of shortfalls) w(`    SHORT CELL: ${s.cell} holds ${s.have}, taken whole; deficit made up from the largest cell.`);
  }
  w();
  w('  THE 20\'S OWN AGE AND KEY-SIZE DISTRIBUTION IS A PROPERTY OF THIS SAMPLING');
  w('  AND IS NOT EVIDENCE. Even spacing over qids spreads the sample across corpus');
  w('  age on purpose, so that §5.3 does not choose it. Section 4 is where the age');
  w('  finding lives, over all queries.');
  w();
  w('    qid       cell                 cat   key   grades   decile   year   reached by');
  w('    ' + '-'.repeat(94));
  for (const { cell, record: r } of selected) {
    w(`    ${r.qid.padEnd(9)} ${cell.padEnd(20)} ${r.category}    ${String(r.keySize).padStart(3)}   ` +
      `${r.grades.sort().join(',').padEnd(8)} D${String(r.decile).padEnd(6)} ${r.year}   ${r.reachedBy.length ? r.reachedBy.join(' ') : '—'}`);
  }
  w();

  w('8. WHAT THIS FILE CANNOT SUPPORT');
  w(thin);
  w('  - The hand-read categories are counts out of 20 in four cells of 5. They');
  w('    are NOT frequencies over the corpus and must never be reweighted into');
  w('    one: at n=5 per cell the variance of any projected share is enormous, and');
  w('    a projected percentage would be the most quotable and least defensible');
  w('    number in the writeup. Phase 7.1 takes section 3, not section 7.');
  w('  - REACHABLE is a lower bound. The run files stop at rank 10, so a judged');
  w('    document a rung would have found at rank 11 counts as unreachable here.');
  w('  - C3 is not a statement that a document is unfindable. It says the six');
  w('    rungs on this ladder do not find it in ten slots.');
  w('  - Nothing here measures whether an UNJUDGED retrieved document is relevant.');
  w('    That is §5.1\'s open problem, its only fix is pooling and hand-labelling');
  w('    (§5.4 option 2), and it is not done.');
  w('  - Dev only. Nothing here is a test-set result and nothing here was checked');
  w('    against test.');
  w();
  w(thick);

  const report = `${lines.join('\n')}\n`;

  // --- the casebook ---------------------------------------------------------
  const cb = [];
  const c = (s = '') => cb.push(s);
  c(`CASEBOOK — the 20 cases read by hand for ${args.winner} on ${site}.${split}`);
  c(thick);
  c();
  c('  Generated by analyse-errors.js so the hand read is reproducible against');
  c('  EXACTLY the text that was read. Categories are assigned in');
  c('  results/error-analysis-cases.csv under the protocol in');
  c('  results/error-analysis.md, which requires the JUDGED DOCUMENT to be read');
  c('  BEFORE the retriever\'s output — reading the output first is how a reader');
  c('  talks themselves into "the key does not know".');
  c();
  c('  Bodies are truncated. The corpus is the source of record:');
  c('    data/corpus/cooking.jsonl');
  c();
  const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`);
  for (const { cell, record: r } of selected) {
    c(thick);
    c(`QUERY ${r.qid}   cell ${cell}   category ${r.category}   key ${r.keySize}   D${r.decile}   ${r.doc.creationDate.slice(0, 10)}`);
    c(thick);
    c(`  TITLE   ${r.doc.title}`);
    c(`  TAGS    ${(r.doc.tags || []).join(', ')}`);
    c(`  SCORE   ${r.doc.score}   roles: ${r.roles.length ? r.roles.join(', ') : 'none in PostLinks'}   tokens: ${r.queryTokens}`);
    c(`  BODY    ${clip(r.doc.body.replace(/\s+/g, ' '), 700)}`);
    c();
    c('  THE KEY SAYS:');
    for (const docId of r.judged) {
      const d = corpus.get(docId);
      const grade = qrels.get(r.qid).get(docId);
      const found = RUNGS.filter((rung) => r.perRung[rung].ranked.includes(docId));
      c(`    ${docId}  grade ${grade}  (${grade === 2 ? 'duplicate' : 'linked'})  degree ${degree.get(docId) || 0}  ${d ? d.creationDate.slice(0, 10) : 'NOT IN CORPUS'}`);
      c(`      ${d ? d.title : ''}`);
      if (d) c(`      ${clip(d.body.replace(/\s+/g, ' '), 320)}`);
      c(`      found in top 10 by: ${found.length ? found.join(' ') : 'NO RUNG'}`);
    }
    c();
    c(`  ${args.winner} TOP 5:`);
    const top = r.perRung[args.winner].ranked.slice(0, 5);
    for (let i = 0; i < top.length; i += 1) {
      const d = corpus.get(top[i]);
      c(`    ${i + 1}. ${top[i].padEnd(8)} ${d ? d.title : '(not in corpus)'}`);
    }
    c();
  }
  c(thick);
  const casebook = `${cb.join('\n')}\n`;

  console.log(report);
  if (args.write) {
    const out = path.join(REPO_ROOT, 'results', `error-analysis.${split}.txt`);
    const cbOut = path.join(REPO_ROOT, 'results', `error-analysis-casebook.${split}.txt`);
    fs.writeFileSync(out, report);
    fs.writeFileSync(cbOut, casebook);
    console.log(`  written to ${path.relative(REPO_ROOT, out)}`);
    console.log(`  written to ${path.relative(REPO_ROOT, cbOut)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\nerror analysis failed: ${err.message}`);
    if (!err.assertion) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { evenlySpaced, firstHitRank };
