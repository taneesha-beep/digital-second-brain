#!/usr/bin/env node
'use strict';

/**
 * measure-writes.js — Phase 4.2
 *
 *   npm run measure:writes              report only
 *   npm run measure:writes -- --write   also write results/write-cost.txt
 *
 * The 4.2 Done criterion says "round trips per save [MEASURED] -> [MEASURED]".
 * This is the script both numbers come from, and it exists as its own commit
 * BEFORE the change, because the change destroys the first of them. CLAUDE.md:
 * "Baselines are unrecoverable. In several phases the 'before' number is
 * destroyed by the change itself. Capture it as a separate, earlier step."
 *
 * ---------------------------------------------------------------------------
 * WHAT A "ROUND TRIP" IS HERE, because the word is doing real work
 * ---------------------------------------------------------------------------
 *
 * ONE DRIVER OPERATION = ONE CALL THAT WOULD REACH A SERVER. Counted inside
 * scripts/lib/fake-note-store.js, which is the store the code under
 * measurement already talks to:
 *
 *   Note.find(f).select(s).sort(o).limit(n).lean()   1  — the builder chain is
 *                                                       client-side; only the
 *                                                       terminal await goes out
 *   Note.findOne(f).lean()                           1
 *   Note.findById(id)                                1
 *   Note.findByIdAndUpdate(id, u)                    1
 *   doc.save()                                       1
 *   Model.bulkWrite([...])                           1  — ONE command carrying
 *                                                       N server-side writes
 *
 * That unit is chosen because it is what the up-to-8 sequential findById+save
 * loop actually costs: each iteration is two blocking waits, and they cannot
 * overlap, because the loop awaits inside its own body.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT ESTABLISH, stated here rather than left to be inferred
 * ---------------------------------------------------------------------------
 *
 *   - IT IS NOT A LATENCY MEASUREMENT. It counts operations issued. No network
 *     RTT, no write concern, no replication, no index-maintenance cost. A
 *     unique index makes every write more expensive server-side and nothing
 *     here sees that.
 *   - A bulkWrite is ONE command and N writes, and the count deliberately does
 *     not conflate those. The honest reading of "3 operations" below is "three
 *     blocking waits", NOT "three documents touched".
 *   - Nothing about Atlas, or about any real driver. This runs on
 *     FakeNoteStore. EVALUATION.md §21.3's limits are unchanged, and 4.5's
 *     integration tests are where a real driver arrives.
 *   - Nothing about user notes. The fixture is Stack Exchange cooking documents
 *     shaped as Notes: the shape is proved, the content is borrowed.
 *   - Nothing about the migration's own cost, which is a different script
 *     (scripts/verify-migration.js).
 *
 * ---------------------------------------------------------------------------
 * THE THREE PATHS, AND WHY ROW A IS THE CONTROL
 * ---------------------------------------------------------------------------
 *
 *   A  v1-shipped   scripts/lib/linker-v1-shipped.js — the pre-4.1 app.
 *                   Preserved verbatim from tag v0-pre-reorientation and hashed
 *                   by tests/retrieval.app-parity.test.js, so IT CANNOT DRIFT.
 *                   That is what makes it a control: it is measurable at every
 *                   commit, before and after 4.2 alike, and if its number ever
 *                   moves then the INSTRUMENT moved rather than the subject.
 *
 *   B  pre-4.2      services/linker.service.js as 4.1 left it — v4-bm25
 *                   ranking, v1's bidirectional write. THIS IS THE ROW THE
 *                   CHANGE DESTROYS. Measured live only while it exists.
 *
 *   C  4.2          services/linker.service.js after canonical edge storage.
 *
 * Row A's storage half and row B's storage half are BYTE-IDENTICAL —
 * linker-v1-shipped.js:101-127 against linker.service.js:65-91, the
 * bidirectional write 4.1 deliberately did not touch. So once row A establishes
 * the per-link cost empirically, row B is predictable from row A's pattern and
 * row B's own link counts, and this script prints that projection BESIDE the
 * live measurement while both exist. Their agreement is what licenses quoting
 * row B after row B stops being measurable.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { FakeNoteStore, setStore, install, resetOps, totalOps, opBreakdown } = require('./lib/fake-note-store');

// Must precede any require that reaches ../models/Note. parity-v1.js calls it
// again at its own module scope, which is harmless now that counting lives in
// the store rather than in a require.cache proxy in front of it — see that
// file's header for the version of this script that did not work.
install();

const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'results', 'write-cost.txt');

const parityV1 = require('./parity-v1');
const { extractKeywords } = require('../utils/keywords');
const { loadUserCorpus } = require('../utils/corpus');

const USER = 'fixture-user';

// ── stats ───────────────────────────────────────────────────────────────────

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: sorted[Math.min(sorted.length - 1, Math.floor(0.5 * sorted.length))],
    total: sum
  };
}

function fmt(s) {
  return `min ${s.min}  p50 ${s.p50}  mean ${s.mean.toFixed(2)}  max ${s.max}  total ${s.total}`;
}

/** ops = a + b*links, and whether that relation is EXACT rather than fitted. */
function fitLinear(rows) {
  const usable = rows.filter((r) => r.links > 0);
  const distinct = new Map();
  for (const r of usable) distinct.set(r.links, r.ops);
  if (distinct.size < 2) {
    return { note: 'link count does not vary across notes — slope not identifiable' };
  }
  const pts = [...distinct.entries()].sort((a, b) => a[0] - b[0]);
  const [l0, o0] = pts[0];
  const [l1, o1] = pts[pts.length - 1];
  const b = (o1 - o0) / (l1 - l0);
  const a = o0 - b * l0;
  return { a, b, exact: usable.every((r) => Math.abs(r.ops - (a + b * r.links)) < 1e-9) };
}

// ── the paths under measurement ─────────────────────────────────────────────

/**
 * Row A. The pre-4.1 shipped app: stored keyword lists, overlap coefficient,
 * threshold 0.15, cap 8, then the bidirectional write.
 *
 * The keyword-extraction pass has to run first, because that path scores from
 * stored note.keywords and routes/notes.js:118-119 is what puts them there.
 * parity-v1.js runs the same two passes for the same reason. resetOps() lands
 * BETWEEN the two passes, so extraction is deliberately not counted: it is a
 * cost of the save, but it is not a cost of computeAndSaveLinks, and 4.2 is
 * about the second.
 */
async function measureShippedV1(docs) {
  const { computeAndSaveLinks } = require('./lib/linker-v1-shipped');
  const rows = [];
  for (const target of docs) {
    const store = setStore(new FakeNoteStore(parityV1.asNotes(docs), docs.map((d) => d.id)));
    for (const id of store.order) {
      const note = store.raw(id);
      note.keywords = extractKeywords(note.title, note.contentText, await loadUserCorpus(USER, { excludeId: note._id }));
    }

    resetOps();
    const links = await computeAndSaveLinks(target.id, USER);
    rows.push({ id: target.id, ops: totalOps(), links: links.length, breakdown: opBreakdown() });
  }
  return rows;
}

/**
 * Rows B and C. The live linker, whichever one this commit has.
 *
 * No extraction pass: from 4.1 the linker does not read note.keywords at all
 * (EVALUATION.md §21.2), so the corpus adapter is its only input.
 *
 * A FRESH STORE PER MEASURED SAVE. routes/notes.js calls computeAndSaveLinks
 * once per save, and the count does not depend on what is already stored —
 * under row B the insert and update branches of the bidirectional write cost
 * the same findById+save either way, and under row C the bulkWrite is one
 * operation regardless of how many rows it touches.
 */
async function measureLive(docs) {
  const { computeAndSaveLinks } = require('../services/linker.service');
  const rows = [];
  for (const target of docs) {
    setStore(new FakeNoteStore(parityV1.asNotes(docs), docs.map((d) => d.id)));
    resetOps();
    const links = await computeAndSaveLinks(target.id, USER);
    rows.push({ id: target.id, ops: totalOps(), links: links.length, breakdown: opBreakdown() });
  }
  return rows;
}

/**
 * Which row the live path is, read off the MEASURED SHAPE rather than off a
 * version string — so this cannot be fooled by a comment or a stale constant.
 * Row B's cost rises by exactly 2 per link; row C's does not rise at all.
 */
function classify(rows) {
  const usable = rows.filter((r) => r.links > 0);
  if (usable.length === 0) return 'indeterminate — no note produced a link';
  const fit = fitLinear(rows);
  if (fit.b === undefined) return 'indeterminate — link count does not vary';
  if (fit.exact && Math.abs(fit.b) < 1e-9) return 'C (4.2 — constant in the link count)';
  if (fit.exact && Math.abs(fit.b - 2) < 1e-9) return 'B (pre-4.2 — findById + save per link)';
  return `unrecognised — ops = ${fit.a} + ${fit.b} x links`;
}

// ── report ──────────────────────────────────────────────────────────────────

function shell(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: REPO }).toString().trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const write = process.argv.includes('--write');
  const docs = parityV1.loadFixture();

  const out = [];
  const say = (line = '') => { out.push(line); console.log(line); };

  say('WRITE COST PER SAVE — driver operations issued by computeAndSaveLinks()');
  say(`fixture              backend/retrieval/fixtures/mini-corpus.jsonl — ${docs.length} documents`);
  say(`commit               ${shell('git', ['rev-parse', '--short', 'HEAD'])}`);
  say('unit                 one operation = one call that would reach a server.');
  say('                     A bulkWrite is ONE operation and N server-side writes.');
  say('                     This is NOT a latency measurement — see the script header.');
  say('');

  const report = (label, rows) => {
    const o = summarise(rows.map((r) => r.ops));
    const l = summarise(rows.map((r) => r.links));
    const fit = fitLinear(rows);
    say(`   links per save       ${fmt(l)}`);
    say(`   operations per save  ${fmt(o)}`);
    say(fit.b === undefined
      ? `   fitted               ${fit.note}`
      : `   fitted               ops = ${fit.a} + ${fit.b} x links   ${fit.exact ? 'EXACT on every note' : 'APPROXIMATE — the relation is not linear'}`);
    const worst = rows.find((r) => r.ops === o.max);
    say(`   breakdown, worst     ${JSON.stringify(Object.fromEntries(worst.breakdown))}  (note ${worst.id}, ${worst.links} links)`);
    return { o, l, fit };
  };

  // ── A ─────────────────────────────────────────────────────────────────────
  say('A. v1-shipped — scripts/lib/linker-v1-shipped.js (the pre-4.1 app)');
  say('   THE CONTROL. Hashed by tests/retrieval.app-parity.test.js so it cannot drift,');
  say('   therefore measurable at every commit; if this row ever moves, the instrument');
  say('   moved and not the subject.');
  const a = report('A', await measureShippedV1(docs));
  say('');

  // ── B or C ────────────────────────────────────────────────────────────────
  const liveRows = await measureLive(docs);
  say(`LIVE. services/linker.service.js at this commit — classified as row ${classify(liveRows)}`);
  const live = report('live', liveRows);
  say('');

  // ── the projection ────────────────────────────────────────────────────────
  if (a.fit.exact && a.fit.b !== undefined) {
    const projected = liveRows.map((r) => a.fit.a + a.fit.b * r.links);
    say("PROJECTION — row A's MEASURED storage pattern applied to the live link counts");
    say(`   ops = ${a.fit.a} + ${a.fit.b} x links, links measured in the run above`);
    say(`   projected per save   ${fmt(summarise(projected))}`);
    const agrees = projected.every((v, i) => v === liveRows[i].ops);
    say(`   agrees with live     ${agrees ? `YES on all ${liveRows.length} notes — the live path IS row B` : 'NO — the live path is no longer the per-link pattern, so this is row B reconstructed'}`);
    say('   This is what makes row B quotable once it stops being measurable: the pattern');
    say('   comes from a file that cannot drift, and the projection was checked against');
    say('   the live path at the commit where the live path still WAS row B.');
    say('');
  }

  say('ENVIRONMENT');
  say(`   ${os.type()} ${os.release()} ${process.arch}, Node ${process.version}, npm ${shell('npm', ['--version'])}`);
  say(`   ${os.cpus().length} x ${os.cpus()[0].model}, ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB`);

  if (write) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${out.join('\n')}\n`);
    console.log(`\nwrote ${path.relative(REPO, OUT)}`);
  }
}

module.exports = { summarise, fitLinear, classify, measureShippedV1, measureLive, USER };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
