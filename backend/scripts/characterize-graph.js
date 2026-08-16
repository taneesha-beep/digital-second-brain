#!/usr/bin/env node
'use strict';

/**
 * characterize-graph.js — Phase 4.4
 *
 *   npm run characterize:graph                    report only, N=500 and N=2000
 *   npm run characterize:graph -- --n 750
 *   npm run characterize:graph -- --write         also write
 *                                                 results/graph-characterization.txt
 *
 * TWO SCALES BY DEFAULT, AND THEY ARE NOT THE SAME MEASUREMENT. N=500 is the
 * slice utils/corpus.js:3 and noteCorpus.service.js:100 both cap at, so it is
 * where the app lives and where the 4.4 DF cutoff is INERT — which makes it the
 * scale at which the rewrite must be byte-identical. N=2000 is roadmap 4.4's
 * stated Done scale, and it is where the cutoff is LIVE. Running both in one
 * invocation is what keeps "did the rewrite change anything" and "what does the
 * cutoff change" as separate questions with separate evidence, per CLAUDE.md's
 * never-change-two-variables rule.
 *
 * buildGlobalGraph is also the ONLY path here where N is unbounded: it runs
 * Note.find({user}).lean() with no .limit(), where the linker's adapter caps at
 * CORPUS_LIMIT = 500. So N > 500 is reachable in the app today and the cutoff
 * has something to do.
 *
 * THE BASELINE THE CHANGE IS ABOUT TO DESTROY, captured in its own earlier
 * commit. CLAUDE.md: "Baselines are unrecoverable. In several phases the
 * 'before' number is destroyed by the change itself. Capture it as a separate,
 * earlier step." 4.2 did this for the write cost at 4a38def; this is the same
 * move for the graph build, and it has to carry more than a number because
 * roadmap 4.4's second Done clause is about an OUTPUT.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND THE ONE THING THAT IS RECONSTRUCTED INSTEAD
 * ---------------------------------------------------------------------------
 *
 * MEASURED   the total wall time and the exact output of
 *            scripts/lib/graph-builder-v1-shipped.js, which is byte-identical
 *            to services/graphBuilder.service.js at 83689c6 below its first
 *            line. Both are checked here before anything is timed.
 *
 * RECONSTRUCTED   the split of that total across the builder's three phases.
 *            The frozen copy is one function and cannot be instrumented without
 *            editing it, which would end its claim to be the shipped code. So
 *            section 4 re-expresses the three phases and times them separately,
 *            AND CHECKS THAT THEIR SUM AGREES WITH THE MEASURED TOTAL. If it
 *            does not agree within RECON_TOLERANCE the split is suppressed
 *            rather than printed, because a reconstruction that does not
 *            reproduce the thing it decomposes is not evidence about it.
 *
 * This is write-cost.txt's PROJECTION row in a second place: a number that
 * cannot be measured directly, obtained from something that can, and labelled
 * as reconstruction everywhere it appears.
 *
 * ---------------------------------------------------------------------------
 * THE CORPUS IS STACK EXCHANGE, AND THE SLICE IS NOT A NOTEBOOK
 * ---------------------------------------------------------------------------
 *
 * §12.2's point, unchanged and now in a fourth place: there are no user notes
 * to measure. This slices the first N documents of data/corpus/cooking.jsonl
 * and shapes them as Notes, exactly as analyse-app.js does at N=500 (§21.4).
 * The slice is contiguous rather than sampled — a sample needs a seed and a
 * defence, and the quantity of interest here is scale.
 *
 * Roadmap 4.4 says "N=2000 SEEDED notes". Seeded notes are declined and the
 * reason is not convenience: the document-frequency distribution is the single
 * input the 4.4 DF cutoff is chosen against, and a generator would make that
 * distribution an artifact of the generator. Real text, stated for what it is.
 *
 * ---------------------------------------------------------------------------
 * KEYWORDS ARE THE CONVERGED STATE, NOT A SAVE HISTORY
 * ---------------------------------------------------------------------------
 *
 * The builder reads stored `note.keywords`, which in a live database are
 * per-note snapshots from different corpus epochs (§7.2's second unspecified
 * input, roadmap 4.6). That state cannot be reproduced without a save history,
 * so this uses §7.2's frozen definition instead: every note's keywords
 * extracted once, after all notes exist — "what the app would converge to if
 * every note were re-saved once".
 *
 * It runs the REAL backend/utils/keywords.js and backend/utils/corpus.js
 * through the fake store, called exactly as routes/notes.js:124-125 calls them,
 * because §7.5's rule is that comparing a reimplementation against a
 * reimplementation proves nothing. That costs O(N^2) tokenisation — the
 * shipped extractor rebuilds the whole document-frequency table per call
 * (§7.1) — and it is the dominant cost of this script rather than of the thing
 * being measured. It is timed and reported separately for that reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT ESTABLISH
 * ---------------------------------------------------------------------------
 *
 *   - NOT a latency claim about the graph endpoint. No Mongo, no network, no
 *     JSON serialisation on the wire, no browser. It is CPU in one process on
 *     one machine, and the environment is printed with it.
 *   - NOT a measurement of any real notebook. See the corpus note above.
 *   - NOT a claim that N=2000 extrapolates. §21.4 established the Sigma_t df_t^2
 *     ratio is not scale-free; every figure here names its N.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fake = require('./lib/fake-note-store');
const { explainDiff } = require('./lib/graph-diff');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(REPO, 'data', 'corpus', 'cooking.jsonl');
const FROZEN = path.join(__dirname, 'lib', 'graph-builder-v1-shipped.js');
const LIVE = path.join(REPO, 'backend', 'services', 'graphBuilder.service.js');
const OUT = path.join(REPO, 'results', 'graph-characterization.txt');

/** The verbatim block's hash — graphBuilder.service.js at 83689c6, from line 2. */
const FROZEN_VERBATIM_SHA =
  '711b6588dc6a72101d557000157e9df4dd3cbf112c0cdf475c5a79160d2f3fb2';

/**
 * The DF cutoff Phase 4.4 adopts, present here ONLY so this baseline carries
 * the arithmetic the diff will be checked against. Nothing in this script
 * applies it — the frozen builder has no cutoff, which is the point.
 *
 * ceil(0.06 x CORPUS_LIMIT), CORPUS_LIMIT = 500. Chosen against the max-df band
 * measured in section 3 across several N; the writeup carries the argument.
 */
const MAX_DF = 30;

/** Reconstruction agrees with measurement if within this fraction of it. */
const RECON_TOLERANCE = 0.05;

const REPEATS = 5;

const out = [];
function w(line = '') { out.push(line); console.log(line); }

function fail(message) {
  console.error(`\ncharacterize-graph: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { scales: [500, 2000], write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--n' && argv[i + 1]) {
      args.scales = argv[i + 1].split(',').map((s) => Number.parseInt(s.trim(), 10));
      i += 1;
    } else if (argv[i] === '--write') args.write = true;
    else if (argv[i].startsWith('--')) fail(`unknown flag ${argv[i]}`);
  }
  if (args.scales.some((n) => !Number.isInteger(n) || n < 2)) fail('--n must be integers >= 2');
  return args;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function gitHead() {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: REPO })
      .toString().trim();
  } catch { return '(not a git checkout)'; }
}

// ── the frozen copy's two checks, both before anything is timed ─────────────

/**
 * The byte check. Extracts the region strictly between the two markers, which
 * is what "byte-for-byte the shipped file below its first line" means, and
 * compares it to a hash naming a commit. tests/graph.characterization.test.js
 * runs the same check, so it holds at every commit rather than only when this
 * script is run.
 */
function frozenVerbatim() {
  const text = fs.readFileSync(FROZEN, 'utf8');
  const begin = text.indexOf('BEGIN VERBATIM');
  const end = text.indexOf('// ─── END VERBATIM');
  if (begin === -1 || end === -1) fail('frozen copy has lost its VERBATIM markers');
  return text.slice(text.indexOf('\n', begin) + 1, end);
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

/**
 * The corpus slice's identity, so a figure below can be tied to the exact
 * documents that produced it. Same escaping rule as noteCorpus.renderCorpus()
 * — tab separated, newlines escaped, so a body carrying the separator cannot
 * forge a row boundary.
 */
function sliceDigest(docs) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
  return sha256(docs.map((d) => `${d.id}\t${esc(d.title)}\t${esc(d.body)}`).join('\n'));
}

// ── the notes, with converged keywords from the REAL extractor ──────────────

const USER = 'u-characterize';

function buildNotes(docs) {
  const notes = docs.map((d) => ({
    _id: d.id, user: USER, title: d.title, contentText: d.body, keywords: [], tags: []
  }));

  fake.install();
  const store = new fake.FakeNoteStore(notes, notes.map((n) => n._id));
  fake.setStore(store);

  // Required AFTER install(), so both resolve the primed models/Note.
  const { loadUserCorpus } = require('../utils/corpus');
  const { extractKeywords } = require('../utils/keywords');

  const t0 = process.hrtime.bigint();
  return (async () => {
    for (const note of notes) {
      // routes/notes.js:124-125, verbatim in shape.
      const corpus = await loadUserCorpus(USER, { excludeId: note._id });
      store.raw(note._id).keywords = extractKeywords(note.title, note.contentText, corpus);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { store, notes: notes.map((n) => store.raw(n._id)), extractMs: ms };
  })();
}

// ── the document-frequency table over STORED KEYWORDS ───────────────────────

function keywordDf(notes) {
  const df = new Map();
  for (const note of notes) {
    for (const kw of new Set(note.keywords)) df.set(kw, (df.get(kw) || 0) + 1);
  }
  return df;
}

function pairs(d) { return (d * (d - 1)) / 2; }

// ── timing ──────────────────────────────────────────────────────────────────

async function timeIt(fn, repeats = REPEATS) {
  const times = [];
  let value = null;
  for (let i = 0; i < repeats; i += 1) {
    const t = process.hrtime.bigint();
    value = await fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { value, min: times[0], p50: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
}

const fixed = (n, d = 1) => n.toFixed(d);

// ── the reconstruction, section 4 ───────────────────────────────────────────

const PALETTE = [
  '#6366f1', '#f59e0b', '#10b981', '#ef4444',
  '#3b82f6', '#8b5cf6', '#f97316', '#14b8a6',
  '#e879f9', '#84cc16', '#fb7185', '#38bdf8'
];

/**
 * The three phases, re-expressed from the frozen copy so they can be timed
 * apart. LABELLED RECONSTRUCTION EVERYWHERE. Its sum is checked against the
 * measured total before any of it is reported.
 *
 * IT ALLOCATES THE SAME ELEMENT OBJECTS THE REAL BUILDER DOES, and the first
 * draft did not — it counted nodes instead of building them and iterated the
 * notes instead of the element array. At N=500 that came in 5.0% low and
 * passed; at N=2000, where 157,503 objects are allocated, it came in 9.8% low
 * and the agreement check REFUSED it. Recorded here because the check catching
 * its own instrument is the reason the check exists: a phase split that omits
 * the allocation would have attributed that time to the pairwise loop, which is
 * the very number this file reports.
 */
async function reconstruct() {
  // Required inside, not at module scope: it must resolve the entry
  // fake.install() primed, and install() runs in buildNotes().
  const Note = require('../models/Note');
  const normList = (values) => (Array.isArray(values)
    ? values.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean) : []);

  // ── phase 0: the store read, :189. INSTRUMENT COST, and it is inside the
  // measured region so it has to be inside the split too. FakeNoteStore's
  // lean() is JSON.parse(JSON.stringify(doc)) per document; real Mongo pays
  // BSON deserialisation here instead, which is also real and is NOT this
  // number.
  //
  // THE READ IS HERE FOR A REASON THE TIMING DOES NOT SHOW, and the first
  // explanation of it was wrong. Earlier drafts took the notes as an argument
  // and came in 6-12% low against BYTE-IDENTICAL output. That was attributed to
  // the clone cost; measured, the clone is 0.5% and 0.1% of the two totals, so
  // it explains none of it. What actually differed is the OBJECT SHAPE the
  // pairwise loop iterates: store.raw() hands back the store's own documents,
  // which carry a non-enumerable `save` defined with Object.defineProperty,
  // while find().lean() returns fresh plain objects — and V8 does not optimise
  // the two the same way. Reading through the store makes the re-expression
  // structurally identical to the builder rather than merely equivalent, which
  // is what closed the gap.
  let t = process.hrtime.bigint();
  const notes = await Note.find({ user: USER }).lean();
  const storeRead = Number(process.hrtime.bigint() - t) / 1e6;

  const noteColors = new Map();
  for (let i = 0; i < notes.length; i += 1) {
    noteColors.set(notes[i]._id.toString(), PALETTE[i % PALETTE.length]);
  }
  const kwUsage = new Map();
  for (const note of notes) {
    for (const kw of normList(note.keywords)) kwUsage.set(kw, (kwUsage.get(kw) || 0) + 1);
  }

  // ── phase 1: the pairwise connCount loop, :204-217 ──
  t = process.hrtime.bigint();
  const connCount = new Map();
  for (const note of notes) connCount.set(note._id.toString(), 0);
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const shared = normList(notes[i].keywords).filter(
        (k) => normList(notes[j].keywords).includes(k)
      );
      if (shared.length) {
        const aId = notes[i]._id.toString(); const bId = notes[j]._id.toString();
        connCount.set(aId, (connCount.get(aId) || 0) + 1);
        connCount.set(bId, (connCount.get(bId) || 0) + 1);
      }
    }
  }
  const pairwise = Number(process.hrtime.bigint() - t) / 1e6;

  // ── phase 2: node emission, :219-258 ──
  t = process.hrtime.bigint();
  const elements = [];
  for (const note of notes) {
    const noteId = note._id.toString();
    const conns = connCount.get(noteId) || 0;
    const noteSize = 64 + Math.min(conns * 6, 24);
    const color = noteColors.get(noteId) || '#6366f1';
    elements.push({
      data: {
        id: noteId, label: note.title || 'Untitled', type: 'note', level: 1,
        size: noteSize, keywords: normList(note.keywords), noteColor: color
      },
      classes: 'global-note-node'
    });
    for (const kw of normList(note.keywords)) {
      const kwNodeId = `kw_${noteId}_${kw}`;
      const usage = kwUsage.get(kw) || 1;
      const isShared = usage > 1;
      elements.push({
        data: {
          id: kwNodeId, label: kw, type: 'keyword', level: 2,
          size: 38 + Math.min(usage * 4, 14), keyword: kw,
          parentNote: noteId, noteColor: color, shared: isShared
        },
        classes: `global-kw-node${isShared ? ' shared-kw' : ''}`
      });
      elements.push({
        data: { id: `e_${noteId}_${kw}`, source: noteId, target: kwNodeId, type: 'note-keyword' },
        classes: 'global-kw-edge'
      });
    }
  }
  const nodes = Number(process.hrtime.bigint() - t) / 1e6;

  // ── phase 3: cross-edge emission, :260-282. Iterates `elements`, as :262 does ──
  t = process.hrtime.bigint();
  const kwGroups = new Map();
  for (const el of elements) {
    if (el.data.type !== 'keyword') continue;
    const kw = el.data.keyword;
    if (!kwGroups.has(kw)) kwGroups.set(kw, []);
    kwGroups.get(kw).push(el.data.id);
  }
  let cross = 0;
  for (const [kw, nodeIds] of kwGroups.entries()) {
    if (nodeIds.length < 2) continue;
    for (let i = 0; i < nodeIds.length; i += 1) {
      for (let j = i + 1; j < nodeIds.length; j += 1) {
        elements.push({
          data: {
            id: `cross_${nodeIds[i]}_${nodeIds[j]}`,
            source: nodeIds[i], target: nodeIds[j],
            type: 'cross-link', sharedKeyword: kw
          },
          classes: 'cross-edge'
        });
        cross += 1;
      }
    }
  }
  const emission = Number(process.hrtime.bigint() - t) / 1e6;

  return {
    storeRead, pairwise, nodes, emission,
    total: storeRead + pairwise + nodes + emission,
    cross, connCount, elementList: elements
  };
}

// ── main ────────────────────────────────────────────────────────────────────

/** reconstruct() REPEATS times, per-phase p50 — see the call site. */
async function repeatReconstruct(repeats) {
  const runs = [];
  for (let i = 0; i < repeats; i += 1) runs.push(await reconstruct());
  const p50 = (key) => {
    const v = runs.map((r) => r[key]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const last = runs[runs.length - 1];
  const storeRead = p50('storeRead');
  const pairwise = p50('pairwise');
  const nodes = p50('nodes');
  const emission = p50('emission');
  return {
    storeRead, pairwise, nodes, emission,
    total: storeRead + pairwise + nodes + emission,
    cross: last.cross, connCount: last.connCount, elementList: last.elementList
  };
}

async function characterize(n) {
  const { docs, meanWords } = loadSlice(n);
  const corpusSha = sliceDigest(docs);
  const { notes, extractMs } = await buildNotes(docs);

  // Required after install(), like the utils above.
  const frozen = require('./lib/graph-builder-v1-shipped');

  const timed = await timeIt(() => frozen.buildGlobalGraph(USER));
  const graph = timed.value;
  const elements = graph.elements;
  const payload = JSON.stringify(graph);

  const byType = new Map();
  for (const el of elements) byType.set(el.data.type, (byType.get(el.data.type) || 0) + 1);

  const df = keywordDf(notes);
  const dfs = [...df.values()].sort((a, b) => b - a);
  const sumDf = dfs.reduce((a, b) => a + b, 0);
  const sumDf2 = dfs.reduce((a, b) => a + b * b, 0);
  const crossAll = dfs.reduce((a, b) => a + pairs(b), 0);
  const overCut = [...df.values()].filter((d) => d > MAX_DF);
  const removedByCut = overCut.reduce((a, b) => a + pairs(b), 0);

  // REPEATED THE SAME NUMBER OF TIMES AS THE MEASUREMENT, and that is not a
  // detail. Run once against a p50 of five, the re-expression came in 12.5% low
  // at N=2000 with BYTE-IDENTICAL output — five repeats allocate 5 x 157,503
  // objects and the later ones pay GC the first does not. Two things being
  // compared have to be measured the same way, or the difference is the method.
  const recon = await repeatReconstruct(REPEATS);
  // TWO conditions, and the digest one is the strong half: if the re-expression
  // emits byte-identical output it IS the same computation, and the timing
  // agreement then says it is not doing it a different way.
  const reconSha = sha256(JSON.stringify({ elements: recon.elementList }));
  const sameOutput = reconSha === sha256(payload);
  const sameCost = Math.abs(recon.total - timed.p50) <= RECON_TOLERANCE * timed.p50;
  const agrees = sameOutput && sameCost;

  const degrees = [...recon.connCount.values()].sort((a, b) => a - b);
  const pct = (p) => degrees[Math.min(degrees.length - 1, Math.floor(degrees.length * p))];

  w(`══ N = ${n} ${'═'.repeat(Math.max(0, 60 - String(n).length))}`);
  w(`corpus slice         first ${n} documents of data/corpus/cooking.jsonl, shaped as Notes`);
  w(`corpus sha256        ${corpusSha}`);
  w(`                     mean ${fixed(meanWords)} words per document — NOT a notebook, see the header`);
  w(`keywords             converged (§7.2), real utils/keywords.js + utils/corpus.js,`);
  w(`                     ${fixed(extractMs / 1000, 1)} s to build — this script's cost, not the builder's`);
  w('');

  w('1. THE OUTPUT — what buildGlobalGraph returns, and its identity');
  w(`   elements total       ${elements.length}`);
  for (const [type, count] of [...byType.entries()].sort()) {
    w(`     ${String(type).padEnd(18)} ${count}`);
  }
  w(`   payload             ${fixed(payload.length / 1048576, 2)} MiB of JSON`);
  w(`   OUTPUT DIGEST       ${sha256(payload)}`);
  w('   The digest is over JSON.stringify({elements}) in EMISSION ORDER, so it');
  w('   covers ordering as well as content. This is the fixture 4.4 is checked');
  w('   against — a frozen implementation rather than a committed blob, because');
  w('   the blob regenerates from committed inputs and §8.5 sends it to .gitignore.');
  w('');

  w('2. THE COST — MEASURED, whole-build');
  w(`   buildGlobalGraph     min ${fixed(timed.min)} ms  p50 ${fixed(timed.p50)} ms  max ${fixed(timed.max)} ms   at N=${n}`);
  w('   NO PART OF THIS IS I/O. The one Note.find() is served by FakeNoteStore');
  w('   from memory, so this is the builder\'s CPU and nothing else.');
  w('');

  w('3. THE DOCUMENT-FREQUENCY TABLE over stored keywords — what the cutoff acts on');
  w(`   |V| with postings    ${dfs.length}`);
  w(`   Sigma_t df_t         ${sumDf}      (= the keyword-node count above)`);
  w(`   Sigma_t df_t^2       ${sumDf2.toExponential(4)}`);
  w(`   max df               ${dfs[0]}   (${fixed((dfs[0] / n) * 100, 1)}% of N)`);
  w(`   df p50 / p90 / p99   ${dfs[Math.floor(dfs.length * 0.5)]} / ${dfs[Math.floor(dfs.length * 0.1)]} / ${dfs[Math.floor(dfs.length * 0.01)]}`);
  w(`   df == 1, emits none  ${dfs.filter((d) => d === 1).length} of ${dfs.length}`);
  w(`   cross edges, all     ${crossAll}      = Sigma_t C(df_t, 2), and it MATCHES the emitted count: ${crossAll === (byType.get('cross-link') || 0) ? 'YES' : 'NO'}`);
  w('');
  w(`   THE CUTOFF ARITHMETIC, at the MAX_DF = ${MAX_DF} that 4.4 adopts. Computed from`);
  w('   this table and NOT from any diff, so it is the independent expected value');
  w('   the 4.4 comparison is checked against.');
  w(`   terms with df > ${MAX_DF}   ${overCut.length}`);
  w(`   cross edges removed  ${removedByCut}   (${fixed((removedByCut / Math.max(crossAll, 1)) * 100, 1)}% of ${crossAll})`);
  w(`   THE CUTOFF IS ${removedByCut === 0 ? 'INERT' : 'LIVE'} AT N=${n}.`);
  w('');

  w('4. WHERE THE TIME GOES — RECONSTRUCTION, not a measurement of the frozen file');
  w('   The frozen copy is one function and instrumenting it would end its claim');
  w('   to be the shipped code. These three phases are re-expressed and timed');
  w('   apart, and the re-expression is admitted only if it passes BOTH checks.');
  w(`   output byte-identical  ${sameOutput ? 'YES' : 'NO'}   ${reconSha}`);
  w(`   total ${fixed(recon.total)} ms vs MEASURED p50 ${fixed(timed.p50)} ms — within ${(RECON_TOLERANCE * 100).toFixed(0)}%   ${sameCost ? 'YES' : 'NO'}`);
  if (agrees) {
    const share = (x) => `${fixed((x / recon.total) * 100, 1)}%`;
    w(`     store read (INSTRUMENT)   ${fixed(recon.storeRead).padStart(9)} ms   ${share(recon.storeRead).padStart(6)}   FakeNoteStore's lean() clone`);
    w(`     pairwise connCount loop   ${fixed(recon.pairwise).padStart(9)} ms   ${share(recon.pairwise).padStart(6)}   O(N^2 * K^2)`);
    w(`     node emission             ${fixed(recon.nodes).padStart(9)} ms   ${share(recon.nodes).padStart(6)}   O(N * K)`);
    w(`     cross-edge emission       ${fixed(recon.emission).padStart(9)} ms   ${share(recon.emission).padStart(6)}   O(Sigma_t df_t^2)`);
    w('   THE FINDING, and it is not what roadmap 4.4 names. Cross-edge emission');
    w('   ALREADY runs from an inverted index — graphBuilder.service.js:261 groups');
    w('   keyword nodes by keyword and emits from the buckets, which IS postings.');
    w('   What is quadratic is the OTHER loop, at :206, and the roadmap does not');
    w('   mention it.');
  } else {
    w('   SPLIT SUPPRESSED. A re-expression that does not reproduce what it');
    w('   decomposes is not evidence about it.');
  }
  w('');

  w('5. WHAT THE PAIRWISE LOOP BUYS — its only consumer');
  w('   connCount feeds ONE value: noteSize = 64 + min(conns * 6, 24), at :223.');
  w(`   It saturates at conns >= 4.`);
  w(`   degree p50 / p90     ${pct(0.5)} / ${pct(0.9)}      max ${degrees[degrees.length - 1]}`);
  w(`   notes at or above 4  ${degrees.filter((d) => d >= 4).length} of ${degrees.length}   (${fixed((degrees.filter((d) => d >= 4).length / degrees.length) * 100, 2)}%)`);
  w(`   distinct node sizes  ${new Set(elements.filter((e) => e.data.type === 'note').map((e) => e.data.size)).size}`);
  w('   So the quadratic loop distinguishes the notes NOT at the cap, and there');
  w('   are few of them. That is the cost being paid, stated as a count rather');
  w('   than as an opinion.');
  w('');

  // ── 6 and 7: THE LIVE BUILDER, and the two comparisons ────────────────────
  //
  // TWO RUNS, NEVER ONE, and never both variables at once (CLAUDE.md). The
  // uncapped run answers "did the rewrite change anything"; the capped run
  // answers "what does the cutoff change". Fusing them produces one diff that
  // attributes nothing.
  const live = require('../services/graphBuilder.service');

  const uncappedTimed = await timeIt(() => live.buildGlobalGraph(USER, { maxDf: Infinity }));
  const uncapped = uncappedTimed.value;
  const uncappedSha = sha256(JSON.stringify({ elements: uncapped.elements }));
  const identical = uncappedSha === sha256(payload);

  const cappedTimed = await timeIt(() => live.buildGlobalGraph(USER));
  const capped = cappedTimed.value;

  const verdict = explainDiff(elements, capped.elements, {
    maxDf: live.MAX_DF,
    notes: notes.map((note) => ({ id: String(note._id), keywords: note.keywords })),
  });

  w('6. THE REWRITE — one inverted index, and the cutoff switched OFF');
  w(`   buildGlobalGraph     min ${fixed(uncappedTimed.min)} ms  p50 ${fixed(uncappedTimed.p50)} ms  max ${fixed(uncappedTimed.max)} ms   maxDf = Infinity`);
  w(`   against the frozen   p50 ${fixed(timed.p50)} ms  ->  ${fixed(timed.p50 / uncappedTimed.p50, 1)}x faster`);
  w(`   OUTPUT DIGEST        ${uncappedSha}`);
  w(`   BYTE-IDENTICAL TO THE FIXTURE   ${identical ? 'YES' : 'NO'}`);
  w('   This is the behaviour-preservation proof and it carries no cutoff, so');
  w('   it is a ONE-VARIABLE result: same output, different cost.');
  w('');

  w(`7. THE CUTOFF — the same builder at MAX_DF = ${live.MAX_DF}`);
  w(`   buildGlobalGraph     min ${fixed(cappedTimed.min)} ms  p50 ${fixed(cappedTimed.p50)} ms  max ${fixed(cappedTimed.max)} ms`);
  w(`   elements             ${verdict.counts.before} -> ${verdict.counts.after}`);
  w(`   payload              ${fixed(payload.length / 1048576, 2)} -> ${fixed(JSON.stringify({ elements: capped.elements }).length / 1048576, 2)} MiB`);
  w(`   cross-links removed  ${verdict.counts.removed}`);
  w(`   expected, from the df table and NOT from the diff   ${verdict.counts.expectedRemoved}`);
  w(`   terms cut            ${verdict.counts.cutTerms}   meta.suppressedTerms says ${capped.meta.suppressedTerms}`);
  w(`   elements added       ${verdict.counts.added}`);
  w(`   \`shared\` flipped     ${verdict.counts.sharedFlipped}   (keyword nodes of cut terms)`);
  w(`   note sizes changed   ${verdict.counts.sizeChanged}`);
  w('');
  w(`   FULLY EXPLAINED BY THE DF CUTOFF   ${verdict.explained ? 'YES' : 'NO'}`);
  w('   The predicate is scripts/lib/graph-diff.js and it was written BEFORE the');
  w('   rewrite existed — ROADMAP decisions log, 2026-08-16. It derives its own');
  w('   postings, df table and expected degrees from the NOTES and never asks the');
  w('   builder anything, so its expected removal count cannot agree with an');
  w('   arbitrary diff.');
  if (!verdict.explained) {
    for (const v of verdict.violations.slice(0, 12)) w(`     VIOLATION  ${v}`);
    if (verdict.violations.length > 12) w(`     ... and ${verdict.violations.length - 12} more`);
  }
  if (capped.meta.suppressed.length) {
    const top = capped.meta.suppressed.slice(0, 12).map((t) => `${t.keyword}:${t.df}`).join(' ');
    w(`   meta.suppressed, top ${Math.min(12, capped.meta.suppressed.length)}   ${top}`);
    w('   Reported in the RESPONSE, not only here: a suppressed edge is');
    w('   indistinguishable from an absent relationship, so the cutoff is the one');
    w('   thing this builder must not be silent about.');
  }
  w('');

  return { n, agrees, identical, explained: verdict.explained };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const verbatimSha = sha256(frozenVerbatim());
  const liveSha = sha256(fs.readFileSync(LIVE, 'utf8'));

  if (verbatimSha !== FROZEN_VERBATIM_SHA) {
    fail(
      'the frozen builder has DRIFTED.\n'
      + `  expected ${FROZEN_VERBATIM_SHA}\n`
      + `  actual   ${verbatimSha}\n`
      + '  scripts/lib/graph-builder-v1-shipped.js must never be edited.'
    );
  }

  w('GLOBAL GRAPH CHARACTERIZATION — the pre-4.4 builder, its output and its cost');
  w('subject              scripts/lib/graph-builder-v1-shipped.js, byte-identical to');
  w('                     services/graphBuilder.service.js at 83689c6 below line 1');
  w(`verbatim sha256      ${verbatimSha}`);
  w(`live file sha256     ${liveSha}`);
  w('                     services/graphBuilder.service.js at this commit');
  w(`generated at HEAD    ${gitHead()}`);
  w(`scales               ${args.scales.join(', ')}`);
  w(`timing               ${REPEATS} repeats, one process, no Mongo — NOT an endpoint latency`);
  w('THIS FILE DOES NOT     regenerate byte-identically, and that is deliberate. It carries');
  w('                     wall times. Every DIGEST, COUNT and df figure below DOES reproduce');
  w('                     exactly — they are functions of the corpus slice and the frozen');
  w('                     code, not of the machine. Same split §23.10 made between');
  w('                     migration-verification.txt and provenance-query.txt.');
  w(`DF cutoff quoted     MAX_DF = ${MAX_DF}, the value 4.4 adopts. NOTHING HERE APPLIES IT —`);
  w('                     the frozen builder has no cutoff, which is the point. Section 3');
  w('                     carries the arithmetic the 4.4 diff will be checked against.');
  w('');

  const results = [];
  for (const n of args.scales) results.push(await characterize(n));

  w('8. WHAT THIS DOES NOT ESTABLISH');
  w('   - NOT an endpoint latency. No Mongo, no network, no serialisation on the');
  w('     wire, no browser layout. GET /api/graph/global pays all four.');
  w('   - NOT a measurement of a notebook. Stack Exchange documents shaped as');
  w('     Notes; §12.2 and §21.4 say the same thing about the same slice.');
  w('   - NOT extrapolable. §21.4 established Sigma_t df_t^2 is not scale-free,');
  w('     so every figure here names its N and none of them implies another.');
  w('   - NOT a claim about buildNoteGraph or expandKeyword. They are a keyword');
  w('     tree for ONE note, they are not this function, and 4.4 does not touch');
  w('     them.');

  if (args.write) {
    fs.writeFileSync(OUT, `${out.join('\n')}\n`);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  }

  const bad = results.filter((r) => !r.agrees || !r.identical || !r.explained);
  if (bad.length) {
    console.error(`\ncharacterize-graph: FAILED at N=${bad.map((r) => r.n).join(', ')}\n`);
    process.exit(1);
  }
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
