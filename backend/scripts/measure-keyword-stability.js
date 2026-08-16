#!/usr/bin/env node
'use strict';

/**
 * measure-keyword-stability.js — Phase 4.6
 *
 *   npm run measure:keywords                 report only
 *   npm run measure:keywords -- --write      also write results/keyword-stability.txt
 *   npm run measure:keywords -- --n 500,1000
 *
 * THE BASELINE THE CHANGE IS ABOUT TO DESTROY, captured in its own earlier
 * commit. CLAUDE.md: "Baselines are unrecoverable. In several phases the
 * 'before' number is destroyed by the change itself. Capture it as a separate,
 * earlier step." 4.2 did this for the write cost, 4.4 for the graph build, and
 * this is the same move for the stored keyword list.
 *
 * Section A specifically becomes unmeasurable against the live function the
 * moment `utils/corpus.js` gains a `.sort()`: once the query is ordered, the
 * store's return order is no longer an input and there is nothing left to vary.
 *
 * ---------------------------------------------------------------------------
 * TWO DEFECTS THAT ARE ROUTINELY SPOKEN OF AS ONE, AND ONLY ONE OF THEM IS
 * FIXED BY A SORT
 * ---------------------------------------------------------------------------
 *
 * EVALUATION §7.2 lists three inputs shipped v1 leaves unspecified. Two of them
 * reach the stored keyword list, and they are independent:
 *
 *   ORDER   which <=500 documents feed the IDF. `utils/corpus.js:6` is a
 *           `.limit(500)` with no `.sort()`, so above 500 notes the corpus is
 *           whichever 500 the database happened to hand back. Section A.
 *           A `.sort()` closes this completely.
 *
 *   EPOCH   when each document's keywords were computed. Keywords are extracted
 *           at save time and persisted, never recomputed, so a note's list is a
 *           snapshot of whatever corpus existed at ITS OWN last save. Sections
 *           B and C. A `.sort()` does NOTHING to this, and no amount of sorting
 *           can: any stored value derived from a moving corpus is a function of
 *           when it was derived.
 *
 * They are measured at different N ON PURPOSE, so that no figure here confounds
 * them — CLAUDE.md's never-change-two-variables rule applied to a measurement
 * rather than to an experiment:
 *
 *   Section A runs ABOVE the 500 cap, where ORDER can act.
 *   Sections B and C run AT OR BELOW it, where ORDER cannot act at all, so
 *   every difference they report is EPOCH and nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE CORPUS IS STACK EXCHANGE, AND THE SLICE IS NOT A NOTEBOOK
 * ---------------------------------------------------------------------------
 *
 * §12.2's point, unchanged and now in a fifth place: there are no user notes to
 * measure. This slices the first N documents of data/corpus/cooking.jsonl and
 * shapes them as Notes, exactly as analyse-app.js (§21.4) and
 * characterize-graph.js (§24) do. The slice is contiguous rather than sampled —
 * a sample needs a seed and a defence, and the quantity of interest is scale.
 *
 * The ONE seeded thing here is section A's third store order, and it is seeded
 * because a shuffle that cannot be reproduced is not evidence. §11.3's rule:
 * a different purpose gets a different stream, so sharing a constant does not
 * imply a coupling that does not exist.
 *
 * AND THE SORTED SLICE HERE IS NOT "THE OLDEST 500", WHICH IT IS IN THE APP.
 * `.sort({_id: 1})` orders by the id's byte sequence. A real note's `_id` is an
 * ObjectId whose 24-hex string is monotonic in creation time, so in the app
 * lexicographic order IS chronological order. These documents carry Stack
 * Exchange ids as NUMERIC STRINGS, where "1000" sorts before "999", so the
 * sorted 500 is a lexicographic slice and not a chronological one. That is why
 * section A's live digest differs from the pre-4.6 ascending digest even though
 * the file is in ascending numeric order: the two loaders are choosing
 * different 500 documents, which is the point — one of them chooses a
 * SPECIFIED 500.
 *
 * It costs the measurement nothing, because section A asks whether the RETURN
 * ORDER changes the answer, not which documents were picked. It is stated
 * because a reader who assumes "oldest first" would be reading a property of
 * the app into a fixture that does not have it.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS THE REAL MODULES
 * ---------------------------------------------------------------------------
 *
 * `utils/keywords.js` and `utils/corpus.js` are required unmodified and called
 * exactly as `routes/notes.js:124-125` calls them, through the same
 * `scripts/lib/fake-note-store.js` the parity proofs use. §7.5's rule is that
 * comparing a reimplementation against a reimplementation proves nothing, and a
 * hand-rolled "unsorted loader" here would be exactly that.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT ESTABLISH
 * ---------------------------------------------------------------------------
 *
 *   - NOT a measurement of any real notebook. See the corpus note above. The
 *     df distribution of Stack Exchange cooking questions is not the df
 *     distribution of somebody's notes, and nothing here claims it is.
 *   - NOT a quality claim in either direction. It measures whether the keyword
 *     list MOVES, not whether the list that moved was better. No answer key in
 *     this repository grades a keyword list.
 *   - NOT a latency claim. Section D is CPU in one process with the environment
 *     printed beside it, and it exists to price ONE design option.
 *   - NOT extrapolable across N. §21.4 established that Sigma_t df_t^2 is not
 *     scale-free on this corpus; every figure below names its N.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fake = require('./lib/fake-note-store');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(REPO, 'data', 'corpus', 'cooking.jsonl');
const LIVE_LOADER = path.join(REPO, 'backend', 'utils', 'corpus.js');
const OUT = path.join(REPO, 'results', 'keyword-stability.txt');

const USER = 'u-keyword-stability';

/** utils/corpus.js:3 and noteCorpus.service.js:100 — the slice both cap at. */
const CORPUS_LIMIT = 500;

/**
 * Section A's shuffle seed. NOT 1.4's 20260803 and NOT 2.5's 20260804 — §11.3's
 * rule, restated: different purpose, different stream. Sharing a constant would
 * imply a coupling between a store return order and a bootstrap resample that
 * does not exist.
 */
const SHUFFLE_SEED = 20260816;

/** Section D repeats. Fewer than characterize-graph's 5; each run is seconds. */
const REPEATS = 3;

const out = [];
function w(line = '') { out.push(line); console.log(line); }

function fail(message) {
  console.error(`\nmeasure-keyword-stability: ${message}\n`);
  process.exit(1);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function gitHead() {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: REPO })
      .toString().trim();
  } catch { return '(not a git checkout)'; }
}

function parseArgs(argv) {
  const args = { orderN: 1000, epochN: CORPUS_LIMIT, costScales: [500, 2000], write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--n' && argv[i + 1]) {
      const parts = argv[i + 1].split(',').map((s) => Number.parseInt(s.trim(), 10));
      if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n < 2)) {
        fail('--n takes two integers >= 2: the epoch scale and the order scale');
      }
      args.epochN = parts[0];
      args.orderN = parts[1];
      i += 1;
    } else if (argv[i] === '--write') args.write = true;
    else if (argv[i].startsWith('--')) fail(`unknown flag ${argv[i]}`);
  }
  if (args.orderN <= CORPUS_LIMIT) {
    fail(`the order scale must exceed CORPUS_LIMIT=${CORPUS_LIMIT}, or section A measures nothing`);
  }
  if (args.epochN > CORPUS_LIMIT) {
    fail(`the epoch scale must not exceed CORPUS_LIMIT=${CORPUS_LIMIT}, or sections B and C confound order with epoch`);
  }
  return args;
}

// ── mulberry32, the repo's PRNG (1.4, 2.5) ──────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(ids, seed) {
  const rand = mulberry32(seed);
  const copy = [...ids];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── the corpus slice ────────────────────────────────────────────────────────

function loadSlice(n) {
  if (!fs.existsSync(CORPUS)) {
    fail(`${path.relative(REPO, CORPUS)} not found. Build it: npm run corpus:build`);
  }
  const docs = [];
  let words = 0;
  const lines = fs.readFileSync(CORPUS, 'utf8').split('\n');
  for (const line of lines) {
    if (docs.length >= n) break;
    if (!line) continue;
    const doc = JSON.parse(line);
    const title = doc.title || '';
    const body = doc.body || '';
    words += `${title} ${body}`.trim().split(/\s+/).filter(Boolean).length;
    docs.push({ id: String(doc.id), title, body });
  }
  if (docs.length < n) fail(`corpus holds ${docs.length} documents, fewer than the requested ${n}`);
  return { docs, meanWords: words / docs.length };
}

/** Same escaping rule as noteCorpus.renderCorpus(): a body cannot forge a row. */
function sliceDigest(docs) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
  return sha256(docs.map((d) => `${d.id}\t${esc(d.title)}\t${esc(d.body)}`).join('\n'));
}

function asNotes(docs) {
  return docs.map((d) => ({
    _id: d.id, user: USER, title: d.title, contentText: d.body, keywords: [], tags: []
  }));
}

// ── the real extractor, called the way routes/notes.js:124-125 calls it ─────

fake.install();
// Required AFTER install(), so both resolve the primed models/Note.
const { loadUserCorpus } = require('../utils/corpus');
const { extractKeywords } = require('../utils/keywords');
// The pre-4.6 loader, preserved, so section A carries its own "before" side
// rather than depending on a checkout. See its header.
const { loadUserCorpus: loadUserCorpusV1 } = require('./lib/corpus-v1-shipped');

/**
 * Every note's keywords extracted once, after all notes exist — §7.2's frozen
 * definition, and "what the app would converge to if every note were re-saved
 * once". `order` is the store's return order, which is section A's whole input.
 */
async function convergedKeywords(notes, order, loadCorpus = loadUserCorpus) {
  const store = fake.setStore(new fake.FakeNoteStore(notes, order));
  const byId = new Map();
  for (const note of notes) {
    const corpus = await loadCorpus(USER, { excludeId: note._id });
    byId.set(String(note._id), extractKeywords(store.raw(note._id).title, store.raw(note._id).contentText, corpus));
  }
  return byId;
}

/**
 * A SAVE HISTORY, which is what the live database actually holds.
 *
 * At the moment note i is saved, only the notes saved before it exist, so its
 * corpus is that prefix and its keyword list is a snapshot of that epoch.
 * Nothing ever recomputes it. A fresh store per step is what makes the corpus
 * grow — FakeNoteStore takes a fixed note list, and faking the growth any other
 * way would stop `loadUserCorpus` being the real one.
 */
async function saveHistoryKeywords(notes, saveOrder) {
  const byIndex = new Map(notes.map((n) => [String(n._id), n]));
  const byId = new Map();
  const present = [];
  for (const id of saveOrder) {
    present.push(byIndex.get(id));
    const store = fake.setStore(new fake.FakeNoteStore(present, present.map((n) => String(n._id))));
    const note = store.raw(id);
    const corpus = await loadUserCorpus(USER, { excludeId: note._id });
    byId.set(id, extractKeywords(note.title, note.contentText, corpus));
  }
  return byId;
}

// ── comparison ──────────────────────────────────────────────────────────────

/**
 * Two keyword maps, compared two ways, because they answer different questions.
 *
 *   SET      did the note end up with a different ten words at all
 *   ORDER    did the ten words come out in a different sequence
 *
 * The set difference is the one that matters to every current reader — the
 * graph builder's postings, `search.js?mode=semantic`'s membership test and
 * `scoreKeywords` all treat the list as a set. Sequence is reported beside it
 * so a "0 notes differ" line cannot be read as "nothing moved".
 */
function compare(left, right) {
  let setDiff = 0;
  let orderDiff = 0;
  let termsMoved = 0;
  let worst = { id: null, moved: 0 };
  for (const [id, a] of left) {
    const b = right.get(id);
    if (!b) fail(`compare: ${id} missing from the right-hand side`);
    const setA = new Set(a);
    const setB = new Set(b);
    let moved = 0;
    for (const t of setA) if (!setB.has(t)) moved += 1;
    for (const t of setB) if (!setA.has(t)) moved += 1;
    if (moved > 0) { setDiff += 1; termsMoved += moved; }
    if (a.join(',') !== b.join(',')) orderDiff += 1;
    if (moved > worst.moved) worst = { id, moved };
  }
  return {
    notes: left.size,
    setDiff,
    orderDiff,
    termsMoved,
    worst,
    setPct: (100 * setDiff) / left.size,
    orderPct: (100 * orderDiff) / left.size
  };
}

function digestOf(byId) {
  const lines = [...byId.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id, kws]) => `${id}\t${kws.join(',')}`);
  return sha256(lines.join('\n'));
}

const pct = (n) => `${n.toFixed(1)}%`;

function row(label, cmp) {
  w(`   ${label.padEnd(22)} ${String(cmp.setDiff).padStart(5)} / ${cmp.notes}  notes differ as a SET  ${pct(cmp.setPct).padStart(6)}`);
  w(`   ${''.padEnd(22)} ${String(cmp.orderDiff).padStart(5)} / ${cmp.notes}  differ in SEQUENCE     ${pct(cmp.orderPct).padStart(6)}`);
  w(`   ${''.padEnd(22)} ${String(cmp.termsMoved).padStart(5)}        terms moved in total, worst single note ${cmp.worst.moved}`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function sectionA(orderN) {
  w(`══ A. ORDER — which ${CORPUS_LIMIT} documents feed the IDF ${'═'.repeat(24)}`);
  const { docs, meanWords } = loadSlice(orderN);
  const notes = asNotes(docs);
  const ids = notes.map((n) => String(n._id));

  w(`   N                      ${orderN}, ABOVE CORPUS_LIMIT=${CORPUS_LIMIT} so the cap bites`);
  w(`   corpus sha256          ${sliceDigest(docs)}`);
  w(`                          mean ${meanWords.toFixed(1)} words per document — NOT a notebook`);
  w(`   epoch held constant    every list extracted after all ${orderN} notes exist, so the ONLY`);
  w('                          variables below are the store\'s return order and the loader');
  w('');

  // BOTH LOADERS, one variable apart. The pre-4.6 side comes from the
  // preserved copy rather than from git history, so this artifact carries its
  // own "before" and stays readable without a checkout. 4.4's
  // graph-characterization.txt does the same thing with the frozen builder.
  w('   ── pre-4.6, unsorted (scripts/lib/corpus-v1-shipped.js) ──');
  const v1Asc = await convergedKeywords(notes, ids, loadUserCorpusV1);
  const v1Desc = await convergedKeywords(notes, [...ids].reverse(), loadUserCorpusV1);
  w(`   id-ascending  digest   ${digestOf(v1Asc)}`);
  w(`   id-descending digest   ${digestOf(v1Desc)}`);
  w('');
  row('ascending vs descending', compare(v1Asc, v1Desc));
  w('');

  w('   ── live, sorted {_id: 1} (utils/corpus.js) ──');
  w('   NOTE: these ids are Stack Exchange NUMERIC STRINGS, so the sorted 500 is a');
  w('   lexicographic slice, not "the oldest 500". In the app an _id is an ObjectId');
  w('   whose hex string IS monotonic in time. That is why the digest below differs');
  w('   from the unsorted ascending one — different 500 documents, one of them');
  w('   specified. It does not affect what this section asks. See the header.');
  const asc = await convergedKeywords(notes, ids);
  const desc = await convergedKeywords(notes, [...ids].reverse());
  const shuf = await convergedKeywords(notes, shuffled(ids, SHUFFLE_SEED));
  w(`   id-ascending  digest   ${digestOf(asc)}`);
  w(`   id-descending digest   ${digestOf(desc)}`);
  w(`   shuffled      digest   ${digestOf(shuf)}   mulberry32 seed ${SHUFFLE_SEED}`);
  w('');
  row('ascending vs descending', compare(asc, desc));
  w('');
  row('ascending vs shuffled', compare(asc, shuf));
  w('');

  // The harness's own determinism, which is a check that can fail rather than
  // a claim. If a second pass over the same order disagreed with the first,
  // every figure above would be measuring this script instead of the extractor.
  const ascAgain = await convergedKeywords(notes, ids);
  const stable = digestOf(ascAgain) === digestOf(asc);
  w(`   harness deterministic  ${stable ? 'YES' : 'NO'}  — same order twice, same digest`);
  if (!stable) fail('the harness is not deterministic; every figure above is unattributable');

  // And the contrast is asserted rather than left for a reader to spot. If the
  // two loaders ever agreed, either the preserved copy drifted into having a
  // sort or the live one lost the one it gained at 4.6 — both defects, and both
  // would leave every figure above looking perfectly reasonable.
  const contrast = compare(v1Asc, v1Desc).setDiff > 0 && compare(asc, desc).setDiff === 0;
  w(`   the sort is what did it ${contrast ? 'YES' : 'NO — the two loaders agree, which is a defect'}`);
  if (!contrast) fail('the pre-4.6 and live loaders no longer disagree; section A is measuring nothing');
  w('');
  return { asc, desc, shuf, stable };
}

async function sectionB(epochN) {
  w(`══ B. EPOCH — when each list was computed ${'═'.repeat(30)}`);
  const { docs, meanWords } = loadSlice(epochN);
  const notes = asNotes(docs);
  const ids = notes.map((n) => String(n._id));

  w(`   N                      ${epochN}, AT OR BELOW CORPUS_LIMIT=${CORPUS_LIMIT} so order CANNOT act`);
  w(`   corpus sha256          ${sliceDigest(docs)}`);
  w(`                          mean ${meanWords.toFixed(1)} words per document`);
  w('   save history           note i extracted against notes 1..i-1, as routes/notes.js does');
  w('   converged              every note re-extracted after all N exist (§7.2)');
  w('');

  const history = await saveHistoryKeywords(notes, ids);
  const converged = await convergedKeywords(notes, ids);

  w(`   save-history  digest   ${digestOf(history)}`);
  w(`   converged     digest   ${digestOf(converged)}`);
  w('');
  row('history vs converged', compare(history, converged));
  w('');

  // Where the instability lives. The first notes saw an almost-empty corpus,
  // where docCount falls back to 1 and every idf is ln(2)+1 — PRIMER §3.3's
  // collapse toward "the longest words present". Reported as a profile rather
  // than a total, because a total cannot show that it is front-loaded.
  const buckets = [10, 50, 100, 250, epochN];
  let from = 0;
  w('   WHERE IT LIVES, by save position');
  for (const to of buckets) {
    if (to <= from) continue;
    const slice = new Map();
    const slice2 = new Map();
    for (let i = from; i < Math.min(to, ids.length); i += 1) {
      slice.set(ids[i], history.get(ids[i]));
      slice2.set(ids[i], converged.get(ids[i]));
    }
    if (slice.size === 0) continue;
    const c = compare(slice, slice2);
    w(`     saves ${String(from + 1).padStart(4)}-${String(Math.min(to, ids.length)).padStart(4)}   ${String(c.setDiff).padStart(4)} / ${String(c.notes).padStart(4)} differ  ${pct(c.setPct).padStart(6)}   ${String(c.termsMoved).padStart(5)} terms`);
    from = to;
  }
  w('');
  return { history, converged, notes, ids };
}

async function sectionC(epochN, prior) {
  w(`══ C. SAVE ORDER — the Done criterion's own experiment ${'═'.repeat(18)}`);
  const { notes, ids, history } = prior;
  w(`   N                      ${epochN}, the same slice as B`);
  w('   question               permute the order the notes are saved in; does a note');
  w('                          end with the same keywords?');
  w('');

  const reversed = await saveHistoryKeywords(notes, [...ids].reverse());
  w(`   forward   digest       ${digestOf(history)}`);
  w(`   reversed  digest       ${digestOf(reversed)}`);
  w('');
  row('forward vs reversed', compare(history, reversed));
  w('');

  // The criterion states it about a PAIR of notes, so it is also measured that
  // way: two notes with byte-identical text at different positions in the same
  // corpus. Injected rather than found, because the corpus has no duplicate
  // pair and a near-duplicate would not answer the question asked.
  const twinA = { _id: 'twin-early', user: USER, title: notes[0].title, contentText: notes[0].contentText, keywords: [], tags: [] };
  const twinB = { _id: 'twin-late', user: USER, title: notes[0].title, contentText: notes[0].contentText, keywords: [], tags: [] };
  const withTwins = [twinA, ...notes.slice(1), twinB];
  const twinIds = withTwins.map((n) => String(n._id));

  const twinConverged = await convergedKeywords(withTwins, twinIds);
  const twinHistory = await saveHistoryKeywords(withTwins, twinIds);

  const cvA = twinConverged.get('twin-early').join(',');
  const cvB = twinConverged.get('twin-late').join(',');
  const hsA = twinHistory.get('twin-early').join(',');
  const hsB = twinHistory.get('twin-late').join(',');

  w('   TWO NOTES, BYTE-IDENTICAL TEXT, positions 1 and N of the same corpus');
  w(`     converged     twin-early  ${cvA}`);
  w(`                   twin-late   ${cvB}`);
  w(`                   IDENTICAL   ${cvA === cvB ? 'YES' : 'NO'}`);
  w(`     save history  twin-early  ${hsA}`);
  w(`                   twin-late   ${hsB}`);
  w(`                   IDENTICAL   ${hsA === hsB ? 'YES' : 'NO'}`);
  w('');
  w('   The converged row is what a single corpus state buys and it holds at');
  w(`   N <= ${CORPUS_LIMIT}: each twin's leave-one-out corpus contains the other, and`);
  w('   identical text contributes identical df, so the two tables agree exactly.');
  w('   The save-history row is the defect this phase measures and does not fix.');
  w('');
  return { identicalConverged: cvA === cvB, identicalHistory: hsA === hsB };
}

async function sectionD(scales) {
  w(`══ D. WHAT RECOMPUTING AT READ TIME WOULD COST ${'═'.repeat(26)}`);
  w('   Prices ONE design option: dropping stored note.keywords and extracting');
  w('   on every read instead. extractKeywords rebuilds the whole df table per');
  w('   call (utils/keywords.js:71), so extracting N lists is N x O(N*K).');
  w('');
  for (const n of scales) {
    const { docs } = loadSlice(n);
    const notes = asNotes(docs);
    const ids = notes.map((x) => String(x._id));
    const times = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const t = process.hrtime.bigint();
      await convergedKeywords(notes, ids);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    w(`   N = ${String(n).padStart(4)}   extract all lists   min ${times[0].toFixed(1)} ms  p50 ${times[Math.floor(times.length / 2)].toFixed(1)} ms  max ${times[times.length - 1].toFixed(1)} ms`);
  }
  w('');
  w('   Against 4.4\'s measured buildGlobalGraph: 5.1 ms at N=500 and 43.9 ms at');
  w('   N=2000 (results/graph-characterization.txt). The comparison is the point —');
  w('   read-time extraction is the term 4.4 removed from this function, put back');
  w('   one layer up.');
  w('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  w('KEYWORD STABILITY — how much a stored note.keywords list moves, and why');
  w(`subject              utils/keywords.js + utils/corpus.js, called as routes/notes.js:124-125`);
  w(`live loader sha256   ${sha256(fs.readFileSync(LIVE_LOADER, 'utf8'))}`);
  w('                     backend/utils/corpus.js at this commit');
  w(`generated at HEAD    ${gitHead()}`);
  w(`scales               epoch ${args.epochN} (at/below the cap), order ${args.orderN} (above it)`);
  w('THIS FILE DOES NOT     regenerate byte-identically, and that is deliberate. Section D');
  w('                     carries wall times. Every DIGEST, COUNT and percentage below DOES');
  w('                     reproduce exactly — they are functions of the corpus slice and the');
  w('                     shipped code, not of the machine. Same split §23.10 made between');
  w('                     migration-verification.txt and provenance-query.txt.');
  w('TWO DEFECTS          ORDER (section A) and EPOCH (sections B, C). Measured at different');
  w('                     N so no figure confounds them. A .sort() closes the first and');
  w('                     cannot touch the second.');
  w('');

  await sectionA(args.orderN);
  const b = await sectionB(args.epochN);
  await sectionC(args.epochN, b);
  await sectionD(args.costScales);

  w('══ WHAT THIS DOES NOT ESTABLISH ═══════════════════════════════════════');
  w('   - NOT a measurement of a notebook. Stack Exchange cooking questions');
  w('     shaped as Notes; §12.2 says the same thing about the same slice.');
  w('   - NOT a quality claim. It measures whether a list MOVED, never whether');
  w('     the list it moved to is better. No answer key here grades keywords.');
  w('   - NOT a latency claim. Section D is CPU in one process, no Mongo, no');
  w('     network, no serialisation, and the environment is printed with it.');
  w('   - NOT extrapolable across N. Every figure names its own.');
  w('   - NOTHING about graphBuilder.service.js:10\'s third tokenizer, which has');
  w('     no corpus and therefore neither of these two defects.');

  if (args.write) {
    fs.writeFileSync(OUT, `${out.join('\n')}\n`);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  }
}

// The two harnesses are exported so tests/keywords.stability.test.js drives the
// SAME code this artifact was measured with, rather than a second copy of it —
// §7.5's rule applied to a harness. Guarded by require.main so importing them
// does not run a two-minute measurement, and so the import needs no data/.
module.exports = { convergedKeywords, saveHistoryKeywords, compare, asNotes, USER, CORPUS_LIMIT };

if (require.main === module) {
  main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
}
