#!/usr/bin/env node
'use strict';

/**
 * parity-v1.js — Phase 2.1
 *
 * Proves that backend/retrieval/v1-overlap.js reproduces the shipped algorithm,
 * by running both and comparing bytes.
 *
 *   npm run parity:v1              report only
 *   npm run parity:v1 -- --write   also write results/parity/*.txt
 *
 * THE SHIPPED SIDE RUNS THE REAL MODULES. utils/keywords.js, utils/corpus.js
 * and services/linker.service.js are required unmodified and executed exactly
 * as routes/notes.js:118-129 executes them, minus Express. A fake Note model
 * is installed by priming require.cache, so no shipped file is edited and no
 * database is involved — mongoose is never even loaded.
 *
 * WHAT IS AND IS NOT COVERED, stated rather than implied:
 *
 *   - normalizeContent() is not exercised. Its job is turning three historical
 *     content shapes into contentText; the fixture supplies contentText
 *     directly, so it is upstream of the retriever.
 *   - The 500-document cap in loadUserCorpus is NOT exercised by the fixture,
 *     which holds 24 documents on purpose. Demonstration C below covers it
 *     separately with generated documents, so the parity run is not left
 *     implying a coverage it does not have.
 *   - linker.service.js:40-64, the bidirectional write, is not re-expressed.
 *     Demonstration B shows why: it is last-writer-wins storage and it makes
 *     the *stored* graph depend on save order. Phase 4.2's subject.
 *
 * Four things run here:
 *
 *   A. Parity. Shipped vs harness on the fixture, byte-for-byte, including
 *      each document's keyword list and each link's sharedKeywords in the
 *      shipped target-order.
 *   B. The tie-order freeze is load-bearing. The same shipped code on the same
 *      fixture, with only the store's return order changed, produces a
 *      different link graph.
 *   C. The 500-cap freeze is load-bearing. Generated documents, above the cap,
 *      where which 500 the database happens to return changes which keywords a
 *      document ends up with.
 *   D. What the shipped threshold actually means, per document.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { FakeNoteStore, setStore, install } = require('./lib/fake-note-store');

// Must precede any require that reaches ../models/Note.
install();

const { extractKeywords } = require('../utils/keywords');
const { loadUserCorpus } = require('../utils/corpus');
const { computeAndSaveLinks } = require('../services/linker.service');
const retrieval = require('../retrieval');
const v1 = require('../retrieval/v1-overlap');

const USER = 'fixture-user';
const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(REPO, 'backend', 'retrieval', 'fixtures', 'mini-corpus.jsonl');
const OUT_DIR = path.join(REPO, 'results', 'parity');
const CAP = 8; // linker.service.js:36

function loadFixture(file = FIXTURE) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Corpus documents as the Note records routes/notes.js would have saved. */
function asNotes(docs) {
  return docs.map((doc) => ({
    _id: doc.id,
    user: USER,
    title: doc.title,
    contentText: doc.body
  }));
}

/**
 * The shipped composition. routes/notes.js:118-119 for every document, then
 * services/linker.service.js for every document.
 *
 * Extraction and linking run as two passes rather than interleaved per-save.
 * That is the state the app converges to once every note has been re-saved
 * after all notes exist; interleaving them would additionally mix in each
 * note's arrival time, which is freeze 2 and is what the harness replaces.
 */
async function runShipped(docs, { order } = {}) {
  const notes = asNotes(docs);
  const store = setStore(new FakeNoteStore(notes, order || docs.map((d) => d.id)));

  for (const id of store.order) {
    const note = store.raw(id);
    const corpus = await loadUserCorpus(USER, { excludeId: note._id });
    note.keywords = extractKeywords(note.title, note.contentText, corpus);
  }

  const perDoc = [];
  for (const id of store.order) {
    const links = await computeAndSaveLinks(id, USER);
    perDoc.push({
      id,
      keywords: store.raw(id).keywords,
      hits: links.map((l) => ({
        docId: String(l.noteId),
        score: l.strength,
        sharedKeywords: l.sharedKeywords
      }))
    });
  }
  return { perDoc, store };
}

/** The harness. */
function runHarness(docs, params = {}) {
  const handle = retrieval.index('v1-overlap', docs, params);
  const perDoc = docs.map((doc) => ({
    id: doc.id,
    keywords: v1.keywordsFor(handle._state, doc.id),
    hits: retrieval.search(handle, doc.id, CAP).map((hit) => ({
      docId: hit.docId,
      score: hit.score,
      sharedKeywords: hit.explain.sharedKeywords
    }))
  }));
  return { perDoc, handle };
}

/**
 * Canonical text. Both sides render through this one function, and the two
 * files are meant to be byte-identical including the header — nothing names
 * which side produced them, so `cmp` and sha256sum are the whole comparison.
 */
function render(perDoc, label) {
  const lines = [`# v1-overlap parity — ${label} — ${perDoc.length} documents`];
  for (const doc of [...perDoc].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    lines.push(`KW   ${doc.id}  ${doc.keywords.join(',')}`);
    doc.hits.forEach((hit, i) => {
      lines.push(
        `LINK ${doc.id}  ${String(i + 1).padStart(2)}  ${hit.docId}  ` +
          `${hit.score.toFixed(4)}  ${hit.sharedKeywords.join(',')}`
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Demonstration C: documents above loadUserCorpus's unsorted limit of 500. */
function capFixture() {
  const docs = [];
  for (let i = 1; i <= 520; i += 1) {
    const marker = i <= 60 ? 'alpha' : i >= 461 ? 'bravo' : `filler${i}`;
    docs.push({
      id: `bg${String(i).padStart(3, '0')}`,
      title: 'background note',
      body: `${marker} padding text for a background document`
    });
  }
  // One extra document whose tenth keyword slot is contested by alpha and
  // bravo. Nine terms unique to it take slots 1-9 on document frequency alone;
  // slot 10 goes to whichever of alpha and bravo the corpus makes rarer, and
  // which 500 documents the corpus holds is exactly what is unspecified.
  docs.push({
    id: 'query',
    title: '',
    body: 'aardvarks binnacles cormorants dromedary escutcheon fandangos gasconade hibernate ichthyoid alpha bravo'
  });
  return docs;
}

async function keywordsUnderOrder(docs, order) {
  const store = setStore(new FakeNoteStore(asNotes(docs), order));
  const note = store.raw('query');
  const corpus = await loadUserCorpus(USER, { excludeId: note._id });
  return { keywords: extractKeywords(note.title, note.contentText, corpus), corpusSize: corpus.length };
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

async function main() {
  const write = process.argv.includes('--write');
  const docs = loadFixture();
  const idOrder = [...docs.map((d) => d.id)].sort();

  // ── A. Parity ───────────────────────────────────────────────────────────
  const shipped = await runShipped(docs, { order: idOrder });
  const harness = runHarness(docs);

  const shippedText = render(shipped.perDoc, 'mini-corpus.jsonl');
  const harnessText = render(harness.perDoc, 'mini-corpus.jsonl');
  const identical = shippedText === harnessText;

  console.log('A. PARITY — shipped composition vs. harness, on the fixture');
  console.log(`   documents            ${docs.length}`);
  console.log(`   store order          id-ascending`);
  console.log(`   shipped  sha256      ${sha256(shippedText)}`);
  console.log(`   harness  sha256      ${sha256(harnessText)}`);
  console.log(`   byte-identical       ${identical ? 'YES' : 'NO'}`);
  console.log(`   link lines           ${shippedText.split('\n').filter((l) => l.startsWith('LINK')).length}`);
  console.log(`   retriever            ${JSON.stringify(retrieval.describe(harness.handle))}`);
  if (!identical) {
    for (const [l, r] of diffLines(shippedText, harnessText).slice(0, 20)) {
      console.log(`   shipped> ${l}`);
      console.log(`   harness> ${r}`);
    }
  }

  // ── B. Tie order ────────────────────────────────────────────────────────
  const reverseOrder = [...idOrder].reverse();
  const shippedReverse = await runShipped(docs, { order: reverseOrder });
  const reverseText = render(shippedReverse.perDoc, 'mini-corpus.jsonl');
  const orderDiff = diffLines(shippedText, reverseText);

  console.log('\nB. THE TIE-ORDER FREEZE IS LOAD-BEARING');
  console.log('   same shipped code, same fixture, store order reversed');
  console.log(`   reversed sha256      ${sha256(reverseText)}`);
  console.log(`   differing lines      ${orderDiff.length}`);
  for (const [l, r] of orderDiff.slice(0, 8)) {
    console.log(`   id-asc > ${l}`);
    console.log(`   revrse > ${r}`);
  }

  // Last-writer-wins: the *stored* graph, after the bidirectional write.
  const storedAsc = shipped.store.order
    .map((id) => `${id} ${shipped.store.raw(id).linkedNotes.map((l) => `${l.noteId}:${l.strength}`).sort().join(',')}`)
    .sort()
    .join('\n');
  const storedRev = shippedReverse.store.order
    .map((id) => `${id} ${shippedReverse.store.raw(id).linkedNotes.map((l) => `${l.noteId}:${l.strength}`).sort().join(',')}`)
    .sort()
    .join('\n');
  const storedDiff = diffLines(storedAsc, storedRev);
  console.log(`   stored linkedNotes differing lines (after the bidirectional write)  ${storedDiff.length}`);
  for (const [l, r] of storedDiff.slice(0, 4)) {
    console.log(`   id-asc > ${l}`);
    console.log(`   revrse > ${r}`);
  }

  // ── C. The 500 cap ──────────────────────────────────────────────────────
  const capDocs = capFixture();
  const asc = await keywordsUnderOrder(capDocs, capDocs.map((d) => d.id));
  const desc = await keywordsUnderOrder(capDocs, [...capDocs.map((d) => d.id)].reverse());

  console.log('\nC. THE 500-CAP FREEZE IS LOAD-BEARING');
  console.log(`   generated documents  ${capDocs.length}   loadUserCorpus returned ${asc.corpusSize}`);
  console.log(`   id-ascending  order  ${asc.keywords.join(',')}`);
  console.log(`   id-descending order  ${desc.keywords.join(',')}`);
  console.log(`   same keyword set     ${JSON.stringify([...asc.keywords].sort()) === JSON.stringify([...desc.keywords].sort()) ? 'YES' : 'NO'}`);

  // ── D. What the threshold means ─────────────────────────────────────────
  console.log('\nD. WHAT `strength > 0.15` MEANS PER DOCUMENT');
  const sizes = new Map();
  for (const doc of harness.perDoc) sizes.set(doc.keywords.length, (sizes.get(doc.keywords.length) || 0) + 1);
  console.log(`   keyword-list sizes   ${[...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}kw×${v}`).join('  ')}`);
  for (let d = 4; d <= 10; d += 1) {
    const one = Number((1 / d).toFixed(4));
    console.log(`   ${String(d).padStart(2)} keywords: 1 shared -> ${one.toFixed(4)}  ${one > 0.15 ? 'LINKS' : 'no link'}`);
  }

  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'v1-shipped.txt'), shippedText);
    fs.writeFileSync(path.join(OUT_DIR, 'v1-harness.txt'), harnessText);
    console.log(`\nwrote ${path.relative(REPO, OUT_DIR)}/v1-shipped.txt and v1-harness.txt`);
  }

  if (!identical) process.exitCode = 1;
}

module.exports = { loadFixture, runShipped, runHarness, render, sha256, capFixture, keywordsUnderOrder, CAP };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
