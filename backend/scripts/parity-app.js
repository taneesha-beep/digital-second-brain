#!/usr/bin/env node
'use strict';

/**
 * parity-app.js — Phase 4.1
 *
 *   npm run parity:app              report only
 *   npm run parity:app -- --write   also write results/parity/app-*.txt
 *
 * The 4.1 Done criterion: "one import path shared; a test asserts app-side and
 * harness-side results are identical for the same corpus."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A TEST THAT COMPARES THE HARNESS TO ITSELF IS WORTH NOTHING, so what is on
 * each side is stated before anything is measured.
 *
 *   harness side   the fixture read off disk as run-eval.js builds
 *                  data/corpus/cooking.jsonl — {id, title, body} straight into
 *                  retrieval.index().
 *
 *   app side       the SAME CONTENT as Note records, put through the whole app
 *                  path: Note.find({user}).select().sort().limit().lean(), the
 *                  ObjectId->string conversion, the contentText fallback, and
 *                  services/noteCorpus.service.js's projection.
 *
 * The two sides share `backend/retrieval/` — that is the point — and share
 * nothing else. Five places the app path can silently differ, each of which
 * this proof would catch: the query filter, the projection, .lean()'s JSON
 * round trip, the id conversion, and the contentText fallback.
 *
 * "THE SAME CORPUS" IS A DEFINITION, NOT A GESTURE. Two corpora are the same
 * when their ordered {id, title, body} triples render identically under
 * noteCorpus.renderCorpus(). Both sides print that digest into the evidence
 * file, so the comparison covers the corpus AND the ranking rather than
 * assuming the first to check the second.
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS CANNOT ESTABLISH, stated here rather than left to be inferred:
 *
 *   - Nothing about a real Mongo. FakeNoteStore is a substitute; a real
 *     driver's natural order, ObjectId semantics and projection are not
 *     exercised. Roadmap 4.5's integration tests.
 *   - Nothing about user notes. §12.2 recorded that "over a <=500-note user
 *     slice" has no referent on a corpus with no users. This runs on Stack
 *     Exchange cooking documents SHAPED AS Notes: the shape is proved, the
 *     content is borrowed.
 *   - Nothing about normalizeContent(). It is upstream — it turns three
 *     historical content shapes into contentText at write time — and FROZEN.md
 *     keeps it there. D below covers the three shapes synthetically, which is
 *     not the same as covering the live data in all three.
 *   - Nothing about the STORED graph. linker.service.js:67-91's bidirectional
 *     write is last-writer-wins and still mangles the ranked list; §7.6
 *     quantified it at 15 differing lines. Roadmap 4.2.
 *
 * Six things run here:
 *
 *   A. Parity. App path vs harness path, byte-for-byte, corpus and ranking.
 *   B. The adapter's sort is load-bearing — reverse the store order and the
 *      app's output does NOT move, where §7.6(B) showed shipped v1's does.
 *   C. The id conversion, mutation-checked in both directions.
 *   D. The three historical content shapes reach the adapter as contentText.
 *   E. The <=500 slice, now specified, and what it means that it is.
 *   F. Link density — what changes for the product when v1 becomes v4.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { FakeNoteStore, setStore, install } = require('./lib/fake-note-store');

// Must precede any require that reaches ../models/Note.
install();

const retrieval = require('../retrieval');
const noteCorpus = require('../services/noteCorpus.service');
const parityV1 = require('./parity-v1');

const USER = 'fixture-user';
const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'results', 'parity');
const { APP_RETRIEVER, LINK_CAP } = noteCorpus;

/** The fixture content as the Note records routes/notes.js would have saved. */
function asNotes(docs) {
  return docs.map((doc) => ({
    _id: doc.id,
    user: USER,
    title: doc.title,
    contentText: doc.body
  }));
}

/** The eval path: the fixture straight into the retriever, as run-eval.js does. */
function runHarness(docs, params = {}) {
  const handle = retrieval.index(APP_RETRIEVER, docs, params);
  const perDoc = docs.map((doc) => ({
    id: doc.id,
    hits: retrieval.search(handle, doc.id, LINK_CAP)
  }));
  return { perDoc, handle, corpus: docs };
}

/** The app path: Note records -> the adapter -> the retriever. */
async function runApp(docs, { order, params = {} } = {}) {
  setStore(new FakeNoteStore(asNotes(docs), order || docs.map((d) => d.id)));
  const corpus = await noteCorpus.loadNoteCorpus(USER);
  const handle = await noteCorpus.indexUserNotes(USER, { params });
  const perDoc = corpus.map((doc) => ({
    id: doc.id,
    hits: noteCorpus.relatedNotes(handle, doc.id, LINK_CAP)
  }));
  return { perDoc, handle, corpus };
}

/**
 * Canonical text. Both sides render through this one function and the two files
 * are byte-identical INCLUDING their header — nothing in either names which
 * side produced it, so `cmp` and sha256sum are the whole comparison. §7.6's
 * convention, unchanged.
 */
function render(run, label) {
  const lines = [
    `# app parity — ${label} — ${run.perDoc.length} documents — ${APP_RETRIEVER}`,
    `CORPUS ${noteCorpus.corpusDigest(run.corpus)}`
  ];
  for (const doc of [...run.perDoc].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    doc.hits.forEach((hit, i) => {
      const shared = hit.explain && typeof hit.explain.shared === 'number' ? hit.explain.shared : '-';
      lines.push(
        `LINK ${doc.id}  ${String(i + 1).padStart(2)}  ${hit.docId}  ` +
          `${hit.score.toFixed(4)}  shared=${shared}`
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function diffLines(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) out.push([left[i], right[i]]);
  }
  return out;
}

/**
 * Demonstration C's instrument: an object that behaves like a Mongo ObjectId
 * closely enough to reproduce the failure. A real ObjectId is not a string, has
 * a toString(), and carries an `id` property that is a Buffer rather than a
 * string — that last detail is what decides which of the two failures happens.
 */
function fakeObjectId(hex) {
  return {
    id: Buffer.from(hex),
    toString() { return hex; }
  };
}

async function main() {
  const write = process.argv.includes('--write');
  const docs = parityV1.loadFixture();
  const idOrder = [...docs.map((d) => d.id)].sort();

  // ── A. Parity ───────────────────────────────────────────────────────────
  const harness = runHarness(docs);
  const app = await runApp(docs, { order: idOrder });

  const harnessText = render(harness, 'mini-corpus.jsonl');
  const appText = render(app, 'mini-corpus.jsonl');
  const identical = harnessText === appText;

  console.log('A. PARITY — app path (Note -> adapter -> retrieval) vs harness path');
  console.log(`   retriever            ${APP_RETRIEVER}`);
  console.log(`   documents            ${docs.length}`);
  console.log(`   corpus digest  app   ${noteCorpus.corpusDigest(app.corpus)}`);
  console.log(`   corpus digest  eval  ${noteCorpus.corpusDigest(harness.corpus)}`);
  console.log(`   app      sha256      ${sha256(appText)}`);
  console.log(`   harness  sha256      ${sha256(harnessText)}`);
  console.log(`   byte-identical       ${identical ? 'YES' : 'NO'}`);
  console.log(`   link lines           ${appText.split('\n').filter((l) => l.startsWith('LINK')).length}`);
  console.log(`   retriever provenance ${JSON.stringify(retrieval.describe(app.handle))}`);
  if (!identical) {
    for (const [l, r] of diffLines(appText, harnessText).slice(0, 20)) {
      console.log(`   app    > ${l}`);
      console.log(`   harness> ${r}`);
    }
  }

  // ── B. The adapter's sort ───────────────────────────────────────────────
  const appReversed = await runApp(docs, { order: [...idOrder].reverse() });
  const reversedText = render(appReversed, 'mini-corpus.jsonl');
  const orderDiff = diffLines(appText, reversedText);

  console.log('\nB. THE ADAPTER\'S SORT IS LOAD-BEARING — AND THIS IS THE OPPOSITE RESULT TO §7.6(B)');
  console.log('   same app code, same fixture, store return order reversed');
  console.log(`   reversed sha256      ${sha256(reversedText)}`);
  console.log(`   differing lines      ${orderDiff.length}   (§7.6(B): shipped v1 differed on 87 of 151)`);
  for (const [l, r] of orderDiff.slice(0, 6)) {
    console.log(`   id-asc > ${l}`);
    console.log(`   revrse > ${r}`);
  }

  // ── C. The id conversion ────────────────────────────────────────────────
  console.log('\nC. THE ObjectId -> string CONVERSION, MUTATION-CHECKED IN BOTH DIRECTIONS');
  const oid = fakeObjectId(docs[0].id);

  // C1 — index side. An adapter that forgets String(_id).
  let c1;
  try {
    retrieval.index(APP_RETRIEVER, [{ id: oid, title: 'x', body: 'y' }]);
    c1 = 'NO THROW — the guard did not fire';
  } catch (err) {
    c1 = `throws: ${err.message}`;
  }
  console.log(`   C1 index with a non-string id       ${c1}`);

  // C2 — query side. relatedNotes() without its String(noteId).
  const hitsStringified = noteCorpus.relatedNotes(app.handle, oid, LINK_CAP);
  const hitsRaw = app.handle._byId.has(oid)
    ? retrieval.search(app.handle, oid, LINK_CAP)
    : null;
  console.log(`   C2 query WITH String(noteId)        ${hitsStringified.length} hits`);
  console.log(`   C2 query WITHOUT String(noteId)     ${hitsRaw === null ? '0 hits, SILENTLY — no throw, no log, no links' : `${hitsRaw.length} hits`}`);

  // C3 — and what search() itself does if the raw object reaches it.
  let c3;
  try {
    const hits = retrieval.search(app.handle, oid, LINK_CAP);
    c3 = `NO THROW — returned ${hits.length} hits`;
  } catch (err) {
    c3 = `throws: ${err.message}`;
  }
  console.log(`   C3 search() handed the raw object   ${c3}`);

  // ── D. The three historical content shapes ──────────────────────────────
  console.log('\nD. THE THREE HISTORICAL CONTENT SHAPES REACH THE ADAPTER AS contentText');
  const shaped = [
    { _id: 'quill', user: USER, title: 'quill delta', contentText: 'brine the turkey overnight', content: { ops: [{ insert: 'brine the turkey overnight' }] } },
    { _id: 'blocks', user: USER, title: 'block array', contentText: 'sear the steak hard', content: [{ type: 'paragraph', content: [{ text: 'sear the steak hard' }] }] },
    { _id: 'string', user: USER, title: 'legacy string', contentText: 'proof the dough slowly', content: { text: 'proof the dough slowly' } },
    { _id: 'notext', user: USER, title: 'no contentText at all', content: { ops: [{ insert: 'never normalised' }] } }
  ];
  setStore(new FakeNoteStore(shaped, shaped.map((n) => n._id)));
  const shapedCorpus = await noteCorpus.loadNoteCorpus(USER);
  for (const doc of shapedCorpus) {
    console.log(`   ${doc.id.padEnd(8)} title=${JSON.stringify(doc.title).padEnd(26)} body=${JSON.stringify(doc.body)}`);
  }
  console.log('   normalizeContent() and blockNoteToPlainText() are NOT called by the adapter.');
  console.log('   `notext` is the pre-existing gap: routes/notes.js POST stores');
  console.log('   `contentText: req.body.contentText || \'\'` without deriving it, so a note');
  console.log('   created that way is empty to the LINKER and was already empty to');
  console.log('   extractKeywords via loadUserCorpus. 4.1 neither causes nor fixes it.');

  // ── E. The <=500 slice ──────────────────────────────────────────────────
  const capDocs = parityV1.capFixture();
  const capNotes = capDocs.map((d) => ({ _id: d.id, user: USER, title: d.title, contentText: d.body }));
  setStore(new FakeNoteStore(capNotes, capNotes.map((n) => n._id)));
  const capAsc = await noteCorpus.loadNoteCorpus(USER);
  setStore(new FakeNoteStore(capNotes, [...capNotes.map((n) => n._id)].reverse()));
  const capDesc = await noteCorpus.loadNoteCorpus(USER);

  console.log('\nE. THE <=500 SLICE, NOW SPECIFIED');
  console.log(`   generated documents  ${capDocs.length}   adapter returned ${capAsc.length}`);
  console.log(`   id-ascending  digest ${noteCorpus.corpusDigest(capAsc)}`);
  console.log(`   id-descending digest ${noteCorpus.corpusDigest(capDesc)}`);
  console.log(`   same 500 either way  ${noteCorpus.corpusDigest(capAsc) === noteCorpus.corpusDigest(capDesc) ? 'YES' : 'NO'}`);
  console.log('   §7.6(C) showed the SHIPPED loader gives two different keyword lists here.');
  console.log('   utils/corpus.js is unchanged and still does — roadmap 4.6. This is the');
  console.log('   ADAPTER\'s corpus, which is a different function with a different fix.');

  // ── F. Link density ─────────────────────────────────────────────────────
  const v1Handle = retrieval.index('v1-overlap', docs);
  let v1Edges = 0;
  const v1PerDoc = [];
  for (const doc of docs) {
    const hits = retrieval.search(v1Handle, doc.id, LINK_CAP);
    v1Edges += hits.length;
    v1PerDoc.push(hits.length);
  }
  const v4Edges = app.perDoc.reduce((sum, d) => sum + d.hits.length, 0);
  const v1Zero = v1PerDoc.filter((n) => n === 0).length;

  console.log('\nF. LINK DENSITY — WHAT THE PRODUCT SEES WHEN v1 BECOMES v4');
  console.log(`   v1-overlap  edges    ${v1Edges}   notes with 0 links ${v1Zero} of ${docs.length}`);
  console.log(`   ${APP_RETRIEVER.padEnd(11)} edges    ${v4Edges}   notes with 0 links ${app.perDoc.filter((d) => d.hits.length === 0).length} of ${docs.length}`);
  console.log(`   ratio                ${(v4Edges / v1Edges).toFixed(2)}x`);
  console.log(`   v4 links per note    mean ${(v4Edges / docs.length).toFixed(2)} of a possible ${LINK_CAP}`);
  console.log('   v4 has NO threshold and NO cap param, so a note gets min(k, |candidates|)');
  console.log('   links — and |candidates| is every document sharing at least ONE term, not');
  console.log('   the corpus. That is why the count is under 8 for some notes here and why');
  console.log('   no note reaches 0: what disappears is v1\'s 0.15 FILTER, not all variation.');
  console.log('   Whether the product wants a score floor is an open question, and it is NOT');
  console.log('   answered by adding a param to a closed rung: that moves v4\'s digest and');
  console.log('   invalidates its committed sidecars.');

  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'app-adapter.txt'), appText);
    fs.writeFileSync(path.join(OUT_DIR, 'app-harness.txt'), harnessText);
    console.log(`\nwrote ${path.relative(REPO, OUT_DIR)}/app-adapter.txt and app-harness.txt`);
  }

  if (!identical) process.exitCode = 1;
}

module.exports = { asNotes, runHarness, runApp, render, sha256, fakeObjectId, USER };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
