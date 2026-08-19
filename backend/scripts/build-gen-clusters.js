#!/usr/bin/env node
'use strict';

/**
 * build-gen-clusters.js — Phase 5.2. The generation golden set.
 *
 *   npm run gen:clusters                 report only
 *   npm run gen:clusters -- --write      also write data/gen-eval/
 *
 * Needs data/corpus/cooking.jsonl and data/splits/cooking.dev.txt, both
 * gitignored, so THIS CANNOT RUN IN CI — the same limit `characterize:graph`
 * and `measure:keywords` have, and `git ls-files data/` is still 0 files.
 * The OUTPUT is committed; the builder is not checkable by the CI that runs
 * beside it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS GOLDEN HERE IS THE SEEDS, NOT THE CLUSTERS. THAT IS THE DECISION.
 * ---------------------------------------------------------------------------
 *
 * A cluster is "a note plus its retrieved neighbours", so it is a FUNCTION OF A
 * RETRIEVER. Committing v4-bm25's neighbour lists as the definition of the
 * golden set would bake today's retriever into the artifact roadmap 5.7 exists
 * to compare retrievers with — 5.7 runs Study Pack under v1 versus the winner
 * with prompts fixed, and the one thing it varies is the one thing that would
 * have been frozen. It is CLAUDE.md's never-change-two-variables rule inverted
 * into something worse: a variable rendered unchangeable.
 *
 * So `clusters.jsonl` records:
 *
 *   THE GOLDEN PART    seedId, title, body, words, quintile. Fixed forever.
 *   THE DERIVED PART   neighbours[], stamped with `retriever`, `digest` and
 *                      `k`. ONE ARM of an experiment 5.7 will run several
 *                      times, present so a reader without the gitignored
 *                      corpus can see a cluster and so 5.3->5.5 face byte
 *                      identical context. NOT the definition.
 *
 * WHAT FIXING THE SEEDS COSTS, stated at the site: the committed file is no
 * longer self-sufficient. Reproducing the derived half needs the corpus, and
 * nothing automated re-checks it.
 *
 * ---------------------------------------------------------------------------
 * SEEDS COME FROM THE DEV SPLIT, AND THAT IS A 5.7 CONSTRAINT ARRIVING EARLY
 * ---------------------------------------------------------------------------
 *
 * Not from the corpus at large. 5.7 correlates retrieval quality against
 * generation quality, which needs qrels for the seeds; §19.9 says test is spent
 * and §20.1 refuses test as a design input in code. A corpus-wide draw would
 * make 5.7 impossible for a second, quieter reason — the seeds would have no
 * judgments at all. The split discipline reaches Phase 5 through 5.7, and 5.2
 * is where it has to be honoured.
 *
 * ---------------------------------------------------------------------------
 * SELECTION IS STRATIFIED ON LENGTH, AND THE RULE IS COMMITTED BEFORE THE DRAW
 * ---------------------------------------------------------------------------
 *
 * The defect 5.3 baselines is truncation at `max_tokens: 1024`, and truncation
 * moves along the LENGTH axis. A uniform draw could land short, report 0%
 * truncation, and be a flattering number about a sample rather than a
 * measurement of a system — §20.2's problem, in a new population.
 *
 * So: all 2,304 dev queries ordered by word count, cut into 5 quintiles, and
 * SIX TAKEN EVENLY SPACED from each. Deterministic — no RNG, no seed to record,
 * no shuffle to reproduce. §20.2's even spacing, for the same reason and with
 * the same cost: THE 30's OWN LENGTH DISTRIBUTION IS AN ARTEFACT OF THE
 * SAMPLING AND IS NOT EVIDENCE ABOUT THE CORPUS.
 *
 * Word count is whitespace-delimited over `title + ' ' + body`. NOT a
 * tokenizer: this repository has THREE that disagree (§24.6), and picking one
 * would make the strata a function of a choice nobody has measured. A crude
 * count is honest about being a proxy; a tokenizer would look precise and
 * import an argument.
 *
 * 30, not 40: the bottom of roadmap 5.2's band, chosen because 5.3 spends API
 * quota per seed (§28.6). The top of the band costs 33% more calls.
 *
 * ---------------------------------------------------------------------------
 * NEIGHBOURS ARE RETRIEVED OVER ALL 27,325 DOCUMENTS, NOT A FAKE 500-NOTE SLICE
 * ---------------------------------------------------------------------------
 *
 * The app's pool is a user's <=500 notes (noteCorpus.service.js:100). This
 * indexes the whole corpus, for §12.2's reason, now in a SEVENTH place: "over a
 * <=500-note user slice" has no referent on a corpus with no users, and
 * inventing one here would attach a magnitude to a population that does not
 * exist. Running the same code path the ladder was measured with at least means
 * the neighbour lists have §19.1's numbers characterising them.
 *
 * THE COST IS REAL AND IS NOT SMALL: these clusters are not app-shaped. Top-8
 * from 27,325 candidates is a different object from top-8 from 500, and
 * generation quality measured on the first says nothing direct about the
 * second.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const retrieval = require('../retrieval');
const { APP_RETRIEVER, LINK_CAP } = require('../services/noteCorpus.service');

const REPO = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(REPO, 'data', 'corpus', 'cooking.jsonl');
const CORPUS_MANIFEST = path.join(REPO, 'data', 'corpus', 'cooking.manifest.json');
const DEV_SPLIT = path.join(REPO, 'data', 'splits', 'cooking.dev.txt');
const SPLIT_MANIFEST = path.join(REPO, 'data', 'splits', 'cooking.manifest.json');
const OUT_DIR = path.join(REPO, 'data', 'gen-eval');
const OUT_CLUSTERS = path.join(OUT_DIR, 'clusters.jsonl');
const OUT_MANIFEST = path.join(OUT_DIR, 'clusters.manifest.json');

const SEEDS = 30;
const QUINTILES = 5;
const PER_QUINTILE = SEEDS / QUINTILES;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function wordCount(doc) {
  return `${doc.title || ''} ${doc.body || ''}`.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Evenly spaced picks from an ordered array — §20.2's rule.
 *
 * Endpoints included, so a quintile's shortest and longest are both in. The
 * point is spread, and dropping the extremes would spread over a narrower range
 * than the stratum actually holds.
 */
function evenlySpaced(items, n) {
  if (items.length <= n) return items.slice();
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  }
  return out;
}

function requireInput(file, what) {
  if (!fs.existsSync(file)) {
    console.error(`MISSING ${what}: ${path.relative(REPO, file)}`);
    console.error('  It is gitignored by design. See EVALUATION.md §6 for how to rebuild it.');
    process.exit(1);
  }
}

function main() {
  const write = process.argv.includes('--write');

  for (const [file, what] of [
    [CORPUS, 'corpus'], [CORPUS_MANIFEST, 'corpus manifest'],
    [DEV_SPLIT, 'dev split'], [SPLIT_MANIFEST, 'split manifest']
  ]) requireInput(file, what);

  const corpusBytes = fs.readFileSync(CORPUS);
  const corpusSha = sha256(corpusBytes);
  const corpusManifest = JSON.parse(fs.readFileSync(CORPUS_MANIFEST, 'utf8'));

  if (corpusSha !== corpusManifest.output.sha256) {
    console.error('CORPUS SHA-256 MISMATCH against its own manifest — refusing to build.');
    console.error(`  file     ${corpusSha}`);
    console.error(`  manifest ${corpusManifest.output.sha256}`);
    process.exit(1);
  }

  const docs = readJsonl(CORPUS).map((d) => ({
    id: String(d.id), title: d.title || '', body: d.body || ''
  }));
  const byId = new Map(docs.map((d) => [d.id, d]));

  const devBytes = fs.readFileSync(DEV_SPLIT);
  const devSha = sha256(devBytes);
  const devIds = devBytes.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean);

  console.log('BUILDING THE GENERATION GOLDEN SET — Phase 5.2\n');
  console.log(`  corpus            ${docs.length} documents  sha256 ${corpusSha.slice(0, 16)}…`);
  console.log(`  dev split         ${devIds.length} queries    sha256 ${devSha.slice(0, 16)}…`);

  // ---- A. THE GOLDEN PART: 30 seeds, stratified on length ------------------

  const devDocs = devIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((d) => ({ ...d, words: wordCount(d) }));

  if (devDocs.length !== devIds.length) {
    console.error(`Dev split names ${devIds.length} ids but only ${devDocs.length} are in the corpus.`);
    process.exit(1);
  }

  // Ordered by length, ties broken numerically on id so the order is total and
  // the strata do not depend on the corpus file's line order.
  const byLength = devDocs
    .slice()
    .sort((a, b) => (a.words - b.words) || (Number(a.id) - Number(b.id)));

  const size = Math.floor(byLength.length / QUINTILES);
  const seeds = [];
  const strata = [];

  for (let q = 0; q < QUINTILES; q += 1) {
    // The last quintile absorbs the remainder — 2304/5 = 460.8, so quintiles
    // 1-4 hold 460 and quintile 5 holds 464. Stated rather than hidden: an
    // even split would need a rule for the 4 leftover documents and every such
    // rule is arbitrary.
    const from = q * size;
    const to = q === QUINTILES - 1 ? byLength.length : (q + 1) * size;
    const stratum = byLength.slice(from, to);
    // Sorted numerically WITHIN the stratum before spacing, so the picks are a
    // spread over ids rather than over the length order — §20.2's construction.
    const ordered = stratum.slice().sort((a, b) => Number(a.id) - Number(b.id));
    const picked = evenlySpaced(ordered, PER_QUINTILE);
    strata.push({
      quintile: q + 1,
      population: stratum.length,
      words: { min: stratum[0].words, max: stratum[stratum.length - 1].words },
      picked: picked.length
    });
    for (const doc of picked) seeds.push({ ...doc, quintile: q + 1 });
  }

  console.log(`\nA. SEEDS — ${seeds.length}, stratified on word count, evenly spaced within stratum\n`);
  console.log('   quintile  population  words min-max   picked');
  for (const s of strata) {
    console.log(
      `   ${String(s.quintile).padStart(8)}  ${String(s.population).padStart(10)}  ` +
      `${String(`${s.words.min}-${s.words.max}`).padStart(13)}  ${String(s.picked).padStart(6)}`
    );
  }

  const seedWords = seeds.map((s) => s.words).sort((a, b) => a - b);
  console.log(
    `\n   seed words   min ${seedWords[0]}  median ${seedWords[Math.floor(seedWords.length / 2)]}  ` +
    `max ${seedWords[seedWords.length - 1]}  mean ${(seedWords.reduce((a, b) => a + b, 0) / seedWords.length).toFixed(1)}`
  );

  const dupes = new Set();
  for (const s of seeds) {
    if (dupes.has(s.id)) {
      console.error(`Duplicate seed ${s.id} — the strata are not disjoint.`);
      process.exit(1);
    }
    dupes.add(s.id);
  }

  // ---- B. THE DERIVED PART: neighbours at a NAMED retriever ----------------

  const t0 = Date.now();
  const handle = retrieval.index(APP_RETRIEVER, docs);
  const described = retrieval.describe(handle);
  const indexMs = Date.now() - t0;

  console.log(`\nB. NEIGHBOURS — DERIVED, not golden. Rebuilt per run by 5.4 and 5.7.\n`);
  console.log(`   retriever         ${described.version}`);
  console.log(`   digest            ${described.digest}`);
  console.log(`   k                 ${LINK_CAP}`);
  console.log(`   indexed over      ${described.docCount} documents  (NOT a <=500 user slice — §12.2)`);
  console.log(`   index build       ${indexMs} ms`);

  const clusters = seeds.map((seed) => {
    const hits = retrieval.search(handle, seed.id, LINK_CAP);
    return {
      seedId: seed.id,
      quintile: seed.quintile,
      words: seed.words,
      title: seed.title,
      body: seed.body,
      retriever: described.version,
      digest: described.digest,
      k: LINK_CAP,
      corpusSha256: corpusSha,
      neighbours: hits.map((hit, i) => {
        const doc = byId.get(hit.docId);
        return {
          id: hit.docId,
          rank: i + 1,
          score: hit.score,
          title: doc.title,
          body: doc.body
        };
      })
    };
  });

  const degrees = clusters.map((c) => c.neighbours.length);
  const short = degrees.filter((d) => d < LINK_CAP).length;
  console.log(`   neighbours/seed   mean ${(degrees.reduce((a, b) => a + b, 0) / degrees.length).toFixed(2)}  ` +
    `min ${Math.min(...degrees)}  max ${Math.max(...degrees)}  under k: ${short} of ${clusters.length}`);

  const selfHit = clusters.filter((c) => c.neighbours.some((n) => n.id === c.seedId));
  console.log(`   self-retrieval    ${selfHit.length} of ${clusters.length}  (excluded by construction — §7.3)`);
  if (selfHit.length > 0) {
    console.error('A seed appears in its own neighbour list. retrieval/index.js should make this impossible.');
    process.exit(1);
  }

  // ---- C. WRITE ------------------------------------------------------------

  // One JSON object per line, seeds in ascending numeric id order so the file
  // is a deterministic function of its inputs and a diff between two builds is
  // readable. NO TIMESTAMP anywhere in either output: this artifact
  // REGENERATES BYTE-IDENTICALLY and a generation time would be the one field
  // stopping it.
  const ordered = clusters.slice().sort((a, b) => Number(a.seedId) - Number(b.seedId));
  const jsonl = `${ordered.map((c) => JSON.stringify(c)).join('\n')}\n`;

  const manifest = {
    phase: '5.2',
    what: 'Generation golden set — 30 seed documents. Neighbours are DERIVED and are one arm, not the definition.',
    selection: {
      population: 'data/splits/cooking.dev.txt — all 2,304 dev queries',
      whyDev: 'roadmap 5.7 needs qrels for the seeds; test is spent (EVALUATION.md §19.9)',
      rule: `word count over title+body, ${QUINTILES} quintiles, ${PER_QUINTILE} evenly spaced per quintile by ascending numeric id`,
      whyStratified: 'the defect 5.3 baselines is truncation, which moves along the length axis',
      deterministic: true,
      seeds: ordered.length,
      strata
    },
    neighbours: {
      status: 'DERIVED — rebuilt per run by 5.4 and 5.7',
      retriever: described.version,
      digest: described.digest,
      k: LINK_CAP,
      indexedOver: described.docCount,
      notAUserSlice: 'the app indexes <=500 notes; this indexes the whole corpus. EVALUATION.md §12.2, §28.2'
    },
    inputs: {
      corpus: { file: 'data/corpus/cooking.jsonl', sha256: corpusSha, documents: docs.length },
      split: { file: 'data/splits/cooking.dev.txt', sha256: devSha, queries: devIds.length }
    },
    output: { file: 'data/gen-eval/clusters.jsonl', sha256: sha256(jsonl), bytes: Buffer.byteLength(jsonl) }
  };

  console.log(`\nC. OUTPUT\n`);
  console.log(`   clusters.jsonl    ${manifest.output.bytes} bytes  sha256 ${manifest.output.sha256}`);
  console.log(`   regenerates byte-identically — no timestamp, no RNG, no wall time`);

  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_CLUSTERS, jsonl);
    fs.writeFileSync(OUT_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\n   wrote ${path.relative(REPO, OUT_CLUSTERS)}`);
    console.log(`   wrote ${path.relative(REPO, OUT_MANIFEST)}`);
  } else {
    console.log('\n   (dry run — pass --write to commit these to disk)');
  }
}

if (require.main === module) main();

module.exports = { wordCount, evenlySpaced, SEEDS, QUINTILES, PER_QUINTILE };
