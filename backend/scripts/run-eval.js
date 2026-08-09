#!/usr/bin/env node
'use strict';

/**
 * run-eval.js — Phase 2.2
 *
 * Load corpus + split, index once, run every query, write a TREC run file, and
 * print a metrics table.
 *
 *   npm run eval -- --retriever v1-overlap --split dev
 *   npm run eval -- --retriever v1-overlap --split dev \
 *                   --param cap=null --label v1-overlap-uncapped
 *   npm run eval -- --retriever v1-overlap --split dev \
 *                   --param threshold=0 --label t0 --outdir results/sweeps/runs
 *
 * TEST IS OPENED ONCE PER LABEL, AND THAT IS NOW ENFORCED RATHER THAN PROMISED
 * (3.6). A --split test run appends to results/runs/test-openings.json and is
 * REFUSED if the label is already there; --reopen-test "<reason>" is the only
 * route through and it appends a second row. --split test also refuses any
 * --outdir but the default, because a grid point on test is not a test run.
 * See guardTestSplit() for the policy this implements, decided before test
 * was opened.
 *
 * ============================================================================
 * VALIDATED AT ROADMAP 2.4. eval/metrics.js agrees with pytrec_eval to within
 * 1e-6 — max |delta| 1.11e-16 over 29,952 per-query comparisons on each of two
 * run files. Evidence: results/metric-validation.txt. Re-check after any change
 * to metrics.js or to what this script feeds it:
 *
 *   scripts/.venv/bin/python scripts/validate_metrics.py
 *
 * One scope limit that survived validation: MRR is reported as recip_rank@kMax,
 * because this script truncates every list at kMax before the scorer sees it.
 * ============================================================================
 *
 * ALL FILE LOADING LIVES HERE, NOT IN backend/retrieval/. A test walks that
 * directory's require graph and fails if anything resolves outside it, which is
 * the property letting Phase 4.1 hand the app and this harness one import path.
 * The retriever receives plain objects; this script is what turns bytes into
 * them.
 *
 * WHAT MAKES A RUN FILE TRACEABLE SIX MONTHS LATER. TREC's format is
 * `qid Q0 docid rank score runid` and has no field for parameters, so the
 * provenance goes in two places:
 *
 *   1. runid = <label>.<split>.<digest8>, where digest8 is the first 8 hex of
 *      describe(handle).digest — SHA-256 over canonical {version, params}. It
 *      is on every line, so a run file copied out of this repo to pytrec_eval
 *      still names the configuration that produced it.
 *   2. A sidecar <run>.json holding the full describe() output, the SHA-256 of
 *      every input re-hashed at run time, the environment, timings, and the git
 *      commit. Re-running index() with those params must reproduce the digest,
 *      so the sidecar cannot drift from the run without the check failing.
 *
 * The input hashes are RECOMPUTED here rather than copied out of the Phase 1
 * manifests. Copying a hash proves that a manifest exists, not that the bytes
 * on disk match it, which is the only thing worth asserting.
 *
 * TWO KINDS OF EMPTY, AND THE RUN FILE ONLY SHOWS ONE. A query the retriever
 * returned nothing for gets NO LINES — that is the TREC convention, and a
 * placeholder line would be a fabricated retrieval. It scores 0 and stays in
 * the mean, because dropping it would inflate every metric by exactly the
 * failure rate. A query whose judged documents are all outside the corpus is a
 * different thing entirely: it is unanswerable, its nDCG is 0/0, and it is
 * excluded and counted. The first is read from the run, the second from
 * qrels ∩ corpus — different sources, which is what keeps them separable.
 *
 * ASSERTIONS RUN BEFORE THE FIRST search(). CLAUDE.md names qrels ids not
 * matching corpus ids as a diagnosis for a sub-0.05 nDCG, and the failure mode
 * of a broken join is not a crash — it is a plausible-looking low number. Every
 * check below turns one of those into an exit 1.
 *
 * VECTORS ARE A FOURTH INPUT, ADDED AT 3.4, AND THEY GET THE SAME TREATMENT AS
 * THE OTHER THREE. If the resolved params carry a `vectors` slug, this script
 * loads data/vectors/<site>.<slug>.f32, re-hashes it against its manifest, and
 * attaches row i to corpus document i as `doc.vector`. Embedding is corpus
 * preparation (§7.1) and a model cannot live behind a pure-function contract,
 * so v5 receives vectors as data exactly as v1 receives text.
 *
 * THE ALIGNMENT CHECK IS THE POINT, and it is the dense rung's equivalent of
 * self-retrieval. If the vectors were built from a different corpus, or the
 * rows are off by one, every score is nonsense and NOTHING ELSE IN THE PIPELINE
 * WOULD NOTICE — the run file is well-formed, the assertions pass, the metrics
 * land in a plausible band. So the manifest carries the corpus SHA-256 it was
 * built from and an idsSha256 over the doc ids in row order, and both are
 * recomputed here from the corpus actually loaded. That makes misalignment
 * impossible rather than unlikely, which is the standard §7.3 set for
 * self-retrieval and the same reason it is worth the code.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { index, search, describe, versions, resolvedParamsFor } = require('../retrieval');
const { scoreQuery, aggregate } = require('../eval/metrics');
const { retrieverSource } = require('../eval/source-digest');
// The TREC loaders live in one place from 3.7. See scripts/lib/run-io.js for
// which copies were absorbed, which two were deliberately left, and why.
const { readLines, sha256File, loadQrelsStrict } = require('./lib/run-io');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_KS = [1, 5, 8, 10];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { site: 'cooking', ks: DEFAULT_KS, params: {}, label: null, outDir: 'results/runs' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--retriever' && value) { args.retriever = value; i += 1; }
    else if (flag === '--split' && value) { args.split = value; i += 1; }
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--label' && value) { args.label = value; i += 1; }
    else if (flag === '--limit' && value) { args.limit = Number.parseInt(value, 10); i += 1; }
    // Repo-relative output directory, default results/runs. Added at 2.7 so a
    // 330-point sweep does not deposit 330 runs and 330 sidecars beside the
    // named runs every later phase cites. The boundary it enforces is
    // EVALUATION.md §8.5's, extended there: a NAMED configuration gets a
    // sidecar in results/runs/; a GRID POINT gets a row in a CSV and its run
    // lands in the ignored results/sweeps/runs/. Nothing about scoring,
    // indexing or the written run file's contents depends on this flag.
    else if (flag === '--outdir' && value) { args.outDir = value; i += 1; }
    // 3.6. The escape hatch on the test ledger, and it takes a MANDATORY
    // reason. Matched on the flag alone, so `--reopen-test` with nothing after
    // it reports the missing reason rather than falling through to the generic
    // unknown-flag error. See openTestSplit() for why the hatch exists at all.
    else if (flag === '--reopen-test') {
      if (!value || value.startsWith('--')) {
        throw new Error('--reopen-test requires a reason, quoted: --reopen-test "why this test run is being repeated"');
      }
      args.reopenTest = value;
      i += 1;
    }
    else if (flag === '--param' && value) {
      const eq = value.indexOf('=');
      if (eq < 1) throw new Error(`--param expects key=value (got ${value})`);
      const key = value.slice(0, eq);
      const raw = value.slice(eq + 1);
      // JSON first so null/true/false/numbers arrive as themselves; a bare word
      // like `none` is not JSON and stays a string. A param that silently
      // arrives as the string "8" instead of the number 8 changes the digest
      // without changing the behaviour, which is a run that lies about itself.
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      args.params[key] = parsed;
      i += 1;
    } else if (flag.startsWith('--')) {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!args.retriever) throw new Error('missing --retriever (known: ' + versions().join(', ') + ')');
  if (!args.split) throw new Error('missing --split (train, dev or test)');
  return args;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------


function loadCorpus(file) {
  const docs = [];
  const lines = readLines(file);
  for (let i = 0; i < lines.length; i += 1) {
    let doc;
    try {
      doc = JSON.parse(lines[i]);
    } catch (err) {
      throw new Error(`${file}:${i + 1} is not valid JSON — ${err.message}`);
    }
    docs.push(doc);
  }
  return docs;
}

/**
 * Attach precomputed embeddings to the corpus documents, and prove they belong
 * to this corpus before doing so.
 *
 * Returns the input record for the sidecar, so vectors are pinned in the run's
 * provenance exactly as the corpus, qrels and split are. Called only when the
 * resolved params carry a `vectors` slug, so every rung below v5 is untouched
 * and their run files cannot move.
 */
function attachVectors({ site, slug, docs }) {
  const dir = path.join(REPO_ROOT, 'data', 'vectors');
  const file = path.join(dir, `${site}.${slug}.f32`);
  const manifestFile = path.join(dir, `${site}.${slug}.manifest.json`);
  if (!fs.existsSync(file)) {
    fail(
      `${path.relative(REPO_ROOT, file)} does not exist.\n` +
      '  Vectors are corpus preparation (EVALUATION.md §7.1). Build them with:\n' +
      '    node scripts/embed-corpus.js --fetch      # once, downloads the pinned weights\n' +
      `    node scripts/embed-corpus.js --site ${site}`
    );
  }
  if (!fs.existsSync(manifestFile)) {
    fail(`${path.relative(REPO_ROOT, manifestFile)} does not exist. A vectors file with no manifest pins nothing.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  const actual = sha256File(file);
  if (manifest.output && manifest.output.sha256 && actual !== manifest.output.sha256) {
    fail(
      `${path.relative(REPO_ROOT, file)} does not match its manifest.\n` +
      `    actual   ${actual}\n    manifest ${manifest.output.sha256}`
    );
  }

  // 1. Built from THIS corpus. Without it, vectors from an earlier corpus build
  //    would attach cleanly by row count and score plausible nonsense.
  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${site}.jsonl`);
  const corpusSha = sha256File(corpusFile);
  if (manifest.binding && manifest.binding.corpusSha256 !== corpusSha) {
    fail(
      'the vectors were built from a different corpus.\n' +
      `    corpus on disk   ${corpusSha}\n` +
      `    vectors built on ${manifest.binding.corpusSha256}`
    );
  }

  // 2. Row order. The strongest of the three: it fails on an off-by-one, a
  //    reordering, and a single substituted document alike.
  const idsSha = crypto.createHash('sha256').update(`${docs.map((d) => d.id).join('\n')}\n`).digest('hex');
  if (manifest.binding && manifest.binding.idsSha256 !== idsSha) {
    fail(
      'the vectors are not aligned with the corpus rows.\n' +
      `    ids on disk    ${idsSha}\n` +
      `    ids at embed   ${manifest.binding.idsSha256}`
    );
  }

  // 3. Shape. Checked against the file's real length rather than the manifest's
  //    claim about it, so a truncated file cannot pass by describing itself.
  const dim = manifest.vectors.dim;
  const bytes = fs.statSync(file).size;
  if (bytes !== docs.length * dim * 4) {
    fail(
      `${path.relative(REPO_ROOT, file)} is ${bytes} bytes; ${docs.length} docs × ${dim} dims × 4 ` +
      `= ${docs.length * dim * 4} expected.`
    );
  }

  const buffer = fs.readFileSync(file);
  // One backing buffer, one subarray view per document — no per-document copy,
  // and buildIndex copies into its own contiguous matrix anyway.
  const all = new Float32Array(buffer.buffer, buffer.byteOffset, docs.length * dim);
  for (let i = 0; i < docs.length; i += 1) {
    docs[i].vector = all.subarray(i * dim, (i + 1) * dim);
  }

  console.log(
    `  vectors ${manifest.model.repo} @ ${manifest.model.revision.slice(0, 12)}… · dim ${dim} · ` +
    `${manifest.text.maxTokens} wordpieces · ${(100 * manifest.text.truncatedShare).toFixed(1)}% truncated`
  );
  console.log('  vectors bound to this corpus: file sha, corpus sha and row-order ids all match the manifest');

  return {
    name: 'vectors',
    file,
    actual,
    expected: manifest.output ? manifest.output.sha256 : undefined,
    manifest
  };
}


function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Assertions — every one of these turns a plausible-looking number into exit 1
// ---------------------------------------------------------------------------

function fail(message) {
  const error = new Error(message);
  error.assertion = true;
  throw error;
}

function assertInputsPinned(inputs) {
  for (const input of inputs) {
    if (!input.expected) {
      // Not fatal: a manifest can legitimately be absent on a hand-built file.
      // Reported rather than skipped silently, so a run against unpinned inputs
      // is visible in its own output.
      console.log(`  ! ${input.name}: no manifest checksum to verify against`);
      continue;
    }
    if (input.actual !== input.expected) {
      fail(
        `${input.name} does not match its manifest.\n` +
        `    file:     ${input.file}\n` +
        `    on disk:  ${input.actual}\n` +
        `    manifest: ${input.expected}\n` +
        `  The Phase 1 checksum chain is what ties a run to reproducible inputs. A run\n` +
        `  against a silently regenerated input is comparable to nothing.`
      );
    }
  }
}

function assertJoin({ queryIds, corpusIds, qrels, splitName, otherSplits }) {
  // 1. Every query is a corpus document. Without this, search() throws
  //    mid-run; with it, the diagnosis arrives before any work is done.
  const missingFromCorpus = queryIds.filter((q) => !corpusIds.has(q));
  if (missingFromCorpus.length > 0) {
    fail(
      `${missingFromCorpus.length} of ${queryIds.length} ${splitName} queries are not in the corpus.\n` +
      `  First few: ${missingFromCorpus.slice(0, 5).join(', ')}\n` +
      `  CLAUDE.md names qrels ids not matching corpus ids as a diagnosis for sub-0.05 nDCG.`
    );
  }

  // 2. Every query carries at least one judgment. The query set IS the qrels
  //    qid set by construction (build-splits.js), so a violation means the
  //    split and the qrels came from different builds.
  const unjudged = queryIds.filter((q) => !qrels.has(q));
  if (unjudged.length > 0) {
    fail(
      `${unjudged.length} ${splitName} queries carry no judgment.\n` +
      `  First few: ${unjudged.slice(0, 5).join(', ')}\n` +
      `  The query set is defined as the qrels qid set, so the split and the qrels\n` +
      `  were built from different sources.`
    );
  }

  // 3. Judged documents are in the corpus, and are not the query itself.
  //    Case B from the run-file contract: a query whose judgments all point
  //    outside the corpus is unanswerable, not failed. build-qrels.js already
  //    drops those (74 rows at 1.3), so the expected count is 0 — which is why
  //    it is asserted rather than assumed. It is a precondition inherited from
  //    another script, and on another site it stops holding.
  let judgedOutside = 0;
  let selfJudged = 0;
  const unanswerable = [];
  const badGrades = new Map();
  for (const qid of queryIds) {
    const row = qrels.get(qid);
    let inCorpus = 0;
    for (const [docId, grade] of row) {
      if (docId === qid) selfJudged += 1;
      if (!corpusIds.has(docId)) judgedOutside += 1;
      else if (docId !== qid) inCorpus += 1;
      if (grade !== 1 && grade !== 2) badGrades.set(grade, (badGrades.get(grade) || 0) + 1);
    }
    if (inCorpus === 0) unanswerable.push(qid);
  }

  if (selfJudged > 0) {
    fail(
      `${selfJudged} judgments point a query at itself.\n` +
      `  A self-judgment inflates IDCG against a document search() is structurally\n` +
      `  forbidden from returning, so the query can never reach nDCG 1.`
    );
  }
  if (judgedOutside > 0) {
    fail(
      `${judgedOutside} judged documents for ${splitName} queries are not in the corpus.\n` +
      `  build-qrels.js drops out-of-corpus endpoints, so this means the qrels and the\n` +
      `  corpus were built from different dumps.`
    );
  }
  if (badGrades.size > 0) {
    fail(
      `unexpected grades ${[...badGrades.keys()].join(', ')} in the qrels.\n` +
      `  Gain is 2^grade - 1, so an unexpected grade silently rescales every nDCG.`
    );
  }

  // 4. The seal on the test split. If the runner is ever pointed at a file
  //    overlapping test, it stops rather than quietly burning it.
  for (const [name, ids] of Object.entries(otherSplits)) {
    const overlap = queryIds.filter((q) => ids.has(q));
    if (overlap.length > 0) {
      fail(
        `${splitName} overlaps ${name} on ${overlap.length} queries.\n` +
        `  The splits are disjoint by construction (1.4). Test is opened once, at 3.6.`
      );
    }
  }

  return { unanswerable };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Write via temp file + rename, matching the Phase 1 scripts: an interrupted
 *  run cannot leave a truncated artifact for a later step to consume. */
function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

// ---------------------------------------------------------------------------
// The test-split ledger (3.6)
// ---------------------------------------------------------------------------

/**
 * §4.4 says test is opened once per retriever version and §8.5 says the test
 * sidecar is the evidence that it was. That was not true: this script writes
 * <label>.<split>.run.json in place, so a second test run OVERWRITES the
 * evidence of the first and the protocol violation leaves a diff that looks
 * like any other regenerated sidecar. A promise nothing enforces is a promise.
 *
 * So the unit of evidence moves out of the overwritable file and into an
 * APPEND-ONLY ledger, committed, keyed on (site, label):
 *
 *   - a first test run for a label APPENDS a row and proceeds;
 *   - a second one FAILS, naming the row that already exists;
 *   - --reopen-test "<reason>" appends a SECOND row carrying the reason
 *     verbatim, and the run proceeds.
 *
 * THE HATCH IS THE POINT, NOT A WEAKNESS. A rule with no legal exception gets
 * routed around invisibly — by deleting the ledger, by renaming the label, by
 * running the eval by hand. The hatch makes the only available route through a
 * committed row that says, in the operator's own words, why the split was
 * opened twice. A violation becomes legible in git history instead of absent
 * from it.
 *
 * THE POLICY THE HATCH IS FOR, decided at 3.6 BEFORE test was opened, because
 * deciding it afterwards is deciding it with the answer visible:
 *
 *   A re-run is permitted only when the fix cannot have been CHOSEN because of
 *   the test number.
 *
 *   - HARNESS bug (a parse, an assert, a metric, this runner) — it moves every
 *     rung the same way and cannot be used to pick a winner. Fix, reopen with
 *     the reason, proceed.
 *   - RETRIEVER bug — a fix changes one rung's source digest, i.e. changes
 *     which system wins, and re-running is then selection on test. Not
 *     permitted. §4.4 applies as written: the split is BURNED, recut under a
 *     new seed, and every Phase 3 number re-measured. That is expensive on
 *     purpose; the expense is what makes the once-only claim worth anything.
 */
const TEST_LEDGER = path.join(REPO_ROOT, 'results', 'runs', 'test-openings.json');

function readTestLedger() {
  if (!fs.existsSync(TEST_LEDGER)) {
    return {
      _: 'APPEND-ONLY LEDGER OF TEST-SPLIT OPENINGS — roadmap 3.6, docs/EVALUATION.md §4.4 and §8.5.',
      _why: [
        'The tuning protocol (§4.4) says test is opened ONCE per retriever version.',
        'Until 3.6 that was enforced by nobody: run-eval.js overwrites the sidecar,',
        'so a second test run replaced the evidence of the first. This file is the',
        'evidence instead, because it is APPENDED to and committed — a second',
        'opening is a second row and a visible diff, not a silent overwrite.',
        '',
        'run-eval.js refuses a second run for a (site, label) already listed here.',
        '--reopen-test "<reason>" appends another row carrying the reason, which is',
        'the only route through, and it leaves the operator words in git history.',
        '',
        'DO NOT EDIT BY HAND. A row deleted here is a test opening that happened',
        'and is no longer recorded, which is the exact failure the file exists for.'
      ],
      openings: []
    };
  }
  return JSON.parse(fs.readFileSync(TEST_LEDGER, 'utf8'));
}

/**
 * Called BEFORE the corpus is loaded, so a refusal costs nothing. Returns the
 * ledger for appendTestOpening() to add to once the run has actually produced
 * bytes — a run that fails halfway must not leave a row claiming it opened the
 * split.
 */
function guardTestSplit({ split, site, label, outDir, reopenTest }) {
  if (split !== 'test') {
    if (reopenTest) fail('--reopen-test is only meaningful with --split test');
    return null;
  }

  // A grid point on test is the thing §11.5 forbids in its own words — sweeps
  // SELECT, they do not test — and it is also how a test run would slip past
  // this ledger, since results/sweeps/runs/ is ignored wholesale. Refused here
  // rather than trusted to discipline.
  if (outDir !== 'results/runs') {
    fail(
      `--split test may only write to results/runs/ (got ${outDir}).\n` +
      '  A grid point on test is not a test run. §11.5: sweeps select; they do not test.\n' +
      '  Sweep on dev, then open test once for the configuration the sweep chose.'
    );
  }

  const ledger = readTestLedger();
  const prior = ledger.openings.filter((o) => o.site === site && o.label === label);
  if (prior.length > 0 && !reopenTest) {
    const first = prior[0];
    fail(
      `test is already open for ${site}.${label} — ${prior.length} row(s) in ` +
      `${path.relative(REPO_ROOT, TEST_LEDGER)}.\n` +
      `  first opened ${first.generatedAt} at commit ${String(first.gitCommit).slice(0, 8)}, runid ${first.runId}\n` +
      '\n' +
      '  §4.4: test is opened ONCE per retriever version and is never used to choose\n' +
      '  anything. If a test run exposed a bug, 3.6 decided the policy in advance:\n' +
      '    HARNESS bug   -> it moves every rung alike and cannot pick a winner.\n' +
      '                     Re-run with --reopen-test "<reason>", which appends a row.\n' +
      '    RETRIEVER bug -> a fix changes which system wins, so re-running is selection\n' +
      '                     on test. The split is BURNED: recut under a new seed and\n' +
      '                     re-measure Phase 3. Do not reopen.'
    );
  }
  return ledger;
}

/** Appended only after the run file and sidecar are on disk. */
function appendTestOpening(ledger, row) {
  if (ledger === null) return;
  ledger.openings.push(row);
  writeAtomic(TEST_LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * The question `dirty` answers is "does the code at `commit` reproduce this
 * run?", so it counts modifications to TRACKED files only. Untracked files are
 * excluded deliberately: run files land untracked in results/runs/, so counting
 * them would mark every run after the first as dirty for a reason that has
 * nothing to do with the code that produced it — a flag that is always set
 * carries no information.
 *
 * THAT EXCLUSION WAS NOT ENOUGH, AND THE FLAG WAS ALWAYS SET ANYWAY (3.2's
 * noticed-list). The .run file is untracked; the SIDECAR beside it is TRACKED
 * and committed, because the provenance does not regenerate (§8.5). So writing
 * one dirties the tree and the NEXT run records dirty=true — every sidecar
 * committed since 3.1 says so, and none of them means anything by it.
 *
 * The fix is to exclude THIS SCRIPT'S OWN OUTPUT DIRECTORY, and only that. A
 * blanket exclusion of results/ would be wrong in the other direction: results/
 * also holds inputs to other tools — most importantly comparisons/registry.json,
 * whose whole enforcement value (§11.5) is that an uncommitted edit to it is
 * visible. Output is excluded because it is output, not because of where it
 * lives.
 */
function gitProvenance(outDirRel) {
  const run = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const exclude = outDirRel.replace(/\/+$/, '');
  try {
    return {
      commit: run(['rev-parse', 'HEAD']),
      dirty: run([
        'status', '--porcelain', '--untracked-files=no', '--', '.', `:(exclude)${exclude}`
      ]) !== '',
      dirtyMeans:
        `uncommitted changes to tracked files outside ${exclude}/; untracked output is not counted. ` +
        'This run\'s own sidecar lives there and is tracked, so counting it would set the flag on every run.'
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

function formatCell(value) {
  return value === null || value === undefined ? '     —' : value.toFixed(4);
}

function printTable(summary, ks) {
  const pad = (s, w) => String(s).padStart(w);
  const header = `  ${pad('metric', 8)} ` + ks.map((k) => pad(`@${k}`, 8)).join(' ');
  console.log(header);
  console.log(`  ${'-'.repeat(header.length - 2)}`);
  for (const [name, row] of [['nDCG', summary.ndcg], ['P', summary.p], ['R', summary.r]]) {
    console.log(`  ${pad(name, 8)} ` + ks.map((k) => pad(formatCell(row[k]), 8)).join(' '));
  }
  // MRR@10, not MRR. The metric is unbounded by k by convention and
  // trec_eval's recip_rank searches the whole run file, but this runner
  // truncates every list at kMax before the scorer sees it, so a first
  // relevant document below rank 10 cannot be found and a capped v1 cannot
  // see below rank 8. Validated as recip_rank@10 at roadmap 2.4
  // (results/metric-validation.txt §2); the label says so rather than leaving
  // the depth to the sidecar's `k` field. Numeric value unchanged.
  console.log(`  ${pad(`MRR@${Math.max(...ks)}`, 8)} ` + pad(formatCell(summary.mrr), 8));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { site, split, retriever, ks } = args;
  const label = args.label || retriever;

  // Before anything is loaded, so a refusal is instant. Returns null off test.
  const testLedger = guardTestSplit({ split, site, label, outDir: args.outDir, reopenTest: args.reopenTest });

  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${site}.jsonl`);
  const qrelsFile = path.join(REPO_ROOT, 'data', 'qrels', `${site}.qrels`);
  const splitFile = path.join(REPO_ROOT, 'data', 'splits', `${site}.${split}.txt`);
  for (const file of [corpusFile, qrelsFile, splitFile]) {
    if (!fs.existsSync(file)) {
      fail(`${path.relative(REPO_ROOT, file)} does not exist. See docs/EVALUATION.md §1 for how to rebuild it.`);
    }
  }

  console.log(`eval ${label} on ${site}.${split}`);
  console.log('  metrics validated against pytrec_eval to 1e-6 (roadmap 2.4) -> results/metric-validation.txt\n');

  // --- load -----------------------------------------------------------------
  const tLoad = process.hrtime.bigint();
  const docs = loadCorpus(corpusFile);
  const { byQuery: qrels, judgments } = loadQrelsStrict(qrelsFile);
  const queryIds = readLines(splitFile);
  const loadMs = Number(process.hrtime.bigint() - tLoad) / 1e6;

  const corpusManifest = readManifest(path.join(REPO_ROOT, 'data', 'corpus', `${site}.manifest.json`));
  const qrelsManifest = readManifest(path.join(REPO_ROOT, 'data', 'qrels', `${site}.manifest.json`));
  const splitsManifest = readManifest(path.join(REPO_ROOT, 'data', 'splits', `${site}.manifest.json`));

  const inputs = [
    { name: 'corpus', file: corpusFile, actual: sha256File(corpusFile), expected: corpusManifest?.output?.sha256 },
    { name: 'qrels', file: qrelsFile, actual: sha256File(qrelsFile), expected: qrelsManifest?.output?.sha256 },
    { name: 'split', file: splitFile, actual: sha256File(splitFile), expected: splitsManifest?.splits?.[split]?.sha256 }
  ];

  // A fourth input, and only for rungs that declare one. `vectors` is resolved
  // through the retriever's own defaults so `--param vectors=<slug>` selects a
  // different file and lands in the params digest — which is what makes the
  // 256-vs-128 truncation ablation a one-variable change the comparison report
  // can see, rather than two runs sharing a digest.
  const resolved = resolvedParamsFor(retriever, args.params);
  let vectorsManifest = null;
  if (resolved.vectors !== undefined) {
    const record = attachVectors({ site, slug: resolved.vectors, docs });
    vectorsManifest = record.manifest;
    inputs.push({ name: 'vectors', file: record.file, actual: record.actual, expected: record.expected });
  }
  assertInputsPinned(inputs);

  // --- assert ---------------------------------------------------------------
  const corpusIds = new Set(docs.map((d) => d.id));
  if (corpusIds.size !== docs.length) fail('corpus contains duplicate ids');

  const otherSplits = {};
  for (const other of ['train', 'dev', 'test']) {
    if (other === split) continue;
    const file = path.join(REPO_ROOT, 'data', 'splits', `${site}.${other}.txt`);
    if (fs.existsSync(file)) otherSplits[other] = new Set(readLines(file));
  }

  const { unanswerable } = assertJoin({ queryIds, corpusIds, qrels, splitName: split, otherSplits });

  const expectedQueries = splitsManifest?.splits?.[split]?.queries;
  if (expectedQueries !== undefined && expectedQueries !== queryIds.length) {
    fail(`${split} holds ${queryIds.length} queries, manifest says ${expectedQueries}`);
  }
  const expectedJudgments = qrelsManifest?.output?.judgments;
  if (expectedJudgments !== undefined && expectedJudgments !== judgments) {
    fail(`qrels holds ${judgments} judgments, manifest says ${expectedJudgments}`);
  }

  console.log(`  corpus ${docs.length} docs · qrels ${judgments} judgments over ${qrels.size} queries · ${split} ${queryIds.length} queries`);
  console.log(`  assertions passed: ids join, grades in {1,2}, no duplicate or self judgment, splits disjoint`);

  // --- index ----------------------------------------------------------------
  const tIndex = process.hrtime.bigint();
  const handle = index(retriever, docs, args.params);
  const indexMs = Number(process.hrtime.bigint() - tIndex) / 1e6;

  const provenance = describe(handle);
  if (provenance.docCount !== docs.length) fail('handle docCount disagrees with the corpus line count');
  const runId = `${label}.${split}.${provenance.digest.slice(0, 8)}`;
  console.log(`\n  ${JSON.stringify(provenance.params)}`);
  console.log(`  digest ${provenance.digest}`);
  console.log(`  source ${retrieverSource(retriever).digest}  (${retrieverSource(retriever).files.length} files under backend/retrieval/)`);
  console.log(`  runid  ${runId}`);
  console.log(`  index() ${indexMs.toFixed(0)} ms\n`);

  // --- search ---------------------------------------------------------------
  const kMax = Math.max(...ks);
  const ids = args.limit ? queryIds.slice(0, args.limit) : queryIds;
  const lines = [];
  const perQuery = [];
  const zeroResultIds = [];
  const latencies = new Float64Array(ids.length);

  const tSearch = process.hrtime.bigint();
  for (let i = 0; i < ids.length; i += 1) {
    const qid = ids[i];
    const t0 = process.hrtime.bigint();
    const hits = search(handle, qid, kMax);
    latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6;

    // No lines for an empty result. TREC run files hold retrieved documents;
    // a placeholder would be a retrieval that did not happen.
    for (let rank = 0; rank < hits.length; rank += 1) {
      lines.push(`${qid} Q0 ${hits[rank].docId} ${rank + 1} ${hits[rank].score.toFixed(6)} ${runId}`);
    }
    if (hits.length === 0) zeroResultIds.push(qid);

    perQuery.push(scoreQuery(hits.map((h) => h.docId), qrels.get(qid) || new Map(), ks));
  }
  const searchMs = Number(process.hrtime.bigint() - tSearch) / 1e6;

  const summary = aggregate(perQuery, ks);

  // --- write ----------------------------------------------------------------
  const outDir = path.resolve(REPO_ROOT, args.outDir);
  const runFile = path.join(outDir, `${label}.${split}.run`);
  const runBody = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  writeAtomic(runFile, runBody);

  // Post-condition on the written bytes. assertHits covers each search() call
  // but not the writer, and self-retrieval is the failure this project is most
  // determined not to have.
  for (const line of readLines(runFile)) {
    const f = line.split(' ');
    if (f[0] === f[2]) fail(`run file contains a self-retrieval line: ${line}`);
    if (f[5] !== runId) fail(`run file line carries runid ${f[5]}, expected ${runId}`);
  }

  const zeroFile = path.join(outDir, `${label}.${split}.zero.txt`);
  writeAtomic(zeroFile, zeroResultIds.length > 0 ? `${zeroResultIds.join('\n')}\n` : '');

  const sorted = Float64Array.from(latencies).sort();
  const quantile = (q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  const meanLatency = ids.length === 0 ? null : Number(latencies.reduce((a, b) => a + b, 0)) / ids.length;

  const sidecar = {
    provisional: false,
    metricsValidation: {
      reference: 'pytrec-eval-terrier 0.5.10',
      tolerance: 1e-6,
      maxAbsDelta: 1.11e-16,
      evidence: 'results/metric-validation.txt',
      recheck: 'scripts/.venv/bin/python scripts/validate_metrics.py'
    },
    runId,
    label,
    site,
    split,
    retriever: provenance,
    // The param digest covers {version, params} and nothing else, so two rungs
    // sharing code can drift with no change to either digest — v2 imports v1's
    // buildIndex, v3 imports its tokeniser. This is the source side of the same
    // question, added at 3.2 to close the first item on 3.1's noticed-list.
    // eval/source-digest.js documents what is hashed and what is deliberately
    // not traversed.
    retrieverSource: retrieverSource(retriever),
    // 3.4. Present only for a rung that carries vectors. The file's SHA-256 is
    // already in `inputs` above; what is copied here is the part that does NOT
    // regenerate — which model, at which revision, under which truncation — so
    // a v5 run file separated from data/ still names the model that produced
    // it. That is the same argument §8.1 made for putting the param digest on
    // every TREC line.
    vectors: vectorsManifest === null ? null : {
      slug: vectorsManifest.slug,
      model: vectorsManifest.model.repo,
      revision: vectorsManifest.model.revision,
      dim: vectorsManifest.model.dim,
      dtype: vectorsManifest.model.dtype,
      pooling: vectorsManifest.model.pooling,
      text: vectorsManifest.text,
      batching: vectorsManifest.batching,
      normalisedAtRest: vectorsManifest.vectors.normalised,
      binding: vectorsManifest.binding,
      embedEnvironment: vectorsManifest.environment,
      notReproducibleByteWise: vectorsManifest._notReproducibleByteWise
    },
    k: kMax,
    ksReported: ks,
    command: `npm run eval -- --retriever ${retriever} --split ${split}` +
      Object.entries(args.params).map(([k, v]) => ` --param ${k}=${JSON.stringify(v)}`).join('') +
      (args.label ? ` --label ${args.label}` : '') +
      (args.outDir === 'results/runs' ? '' : ` --outdir ${args.outDir}`),
    inputs: inputs.map((i) => ({
      name: i.name,
      file: path.relative(REPO_ROOT, i.file),
      sha256: i.actual,
      matchesManifest: i.expected ? i.actual === i.expected : null
    })),
    output: {
      run: path.relative(REPO_ROOT, runFile),
      lines: lines.length,
      bytes: Buffer.byteLength(runBody),
      sha256: sha256File(runFile)
    },
    queries: {
      total: ids.length,
      scored: summary.scored,
      unjudgeable: summary.unjudgeable,
      unjudgeableIds: unanswerable,
      zeroResult: summary.zeroResult,
      zeroResultFile: path.relative(REPO_ROOT, zeroFile)
    },
    metrics: { ndcg: summary.ndcg, p: summary.p, r: summary.r, mrr: summary.mrr },
    conventions: {
      gain: '2^grade - 1',
      discount: '1 / log2(rank + 1)',
      idcg: 'judged grades sorted descending, truncated at k',
      zeroResultQueries: 'scored 0, included in the mean',
      unjudgeableQueries: 'excluded from the mean, counted separately',
      mrr: `recip_rank@${kMax} — the list is truncated at k before scoring`
    },
    latencyMs: {
      note: 'per-query search() only; index build reported separately',
      mean: meanLatency,
      p50: quantile(0.5),
      p95: quantile(0.95),
      max: sorted.length === 0 ? null : sorted[sorted.length - 1]
    },
    timingsMs: { load: loadMs, index: indexMs, search: searchMs, total: loadMs + indexMs + searchMs },
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu: os.cpus()[0] ? os.cpus()[0].model : null,
      cpus: os.cpus().length,
      totalMemMiB: Math.round(os.totalmem() / 1048576),
      peakRssMiB: Math.round(process.memoryUsage().rss / 1048576)
    },
    git: gitProvenance(args.outDir),
    generatedAt: new Date().toISOString()
  };
  writeAtomic(`${runFile}.json`, `${JSON.stringify(sidecar, null, 2)}\n`);

  // Last, and only once both artifacts exist: a row here asserts that the split
  // was opened and that there is something to show for it. The sidecar's own
  // SHA-256 is recorded because the sidecar is the overwritable half — if it is
  // ever regenerated, this row is what says the bytes moved.
  appendTestOpening(testLedger, {
    site,
    label,
    runId,
    paramDigest: provenance.digest,
    sourceDigest: sidecar.retrieverSource.digest,
    runSha256: sidecar.output.sha256,
    sidecarSha256: sha256File(`${runFile}.json`),
    ndcg8: summary.ndcg[8],
    gitCommit: sidecar.git.commit,
    gitDirty: sidecar.git.dirty,
    generatedAt: sidecar.generatedAt,
    reopenReason: args.reopenTest || null
  });

  // --- report ---------------------------------------------------------------
  printTable(summary, ks);
  console.log('');
  console.log(`  queries          ${ids.length} (${summary.scored} scored, ${summary.unjudgeable} unjudgeable and excluded)`);
  console.log(`  zero results     ${summary.zeroResult} (${((summary.zeroResult / Math.max(summary.scored, 1)) * 100).toFixed(2)}%) -> ${path.relative(REPO_ROOT, zeroFile)}`);
  console.log(`  latency/query    mean ${meanLatency.toFixed(3)} ms · p50 ${quantile(0.5).toFixed(3)} · p95 ${quantile(0.95).toFixed(3)} ms`);
  console.log(`  wall             load ${loadMs.toFixed(0)} + index ${indexMs.toFixed(0)} + search ${searchMs.toFixed(0)} = ${(loadMs + indexMs + searchMs).toFixed(0)} ms`);
  console.log(`  run file         ${path.relative(REPO_ROOT, runFile)} (${lines.length} lines)`);
  console.log(`  sidecar          ${path.relative(REPO_ROOT, runFile)}.json`);

  // The plausibility band from CLAUDE.md. Printed, never enforced: refusing to
  // show an implausible number would be worse than showing it, and letting it
  // past unremarked would be worse still.
  const headline = summary.ndcg[8];
  if (headline !== null && headline !== undefined) {
    if (headline > 0.7) {
      console.log(`\n  !! nDCG@8 ${headline.toFixed(4)} is above ~0.7. CLAUDE.md: assume a bug before assuming`);
      console.log('     success. Most often self-retrieval — the query in its own candidate pool.');
    } else if (headline < 0.05) {
      console.log(`\n  !! nDCG@8 ${headline.toFixed(4)} is below ~0.05. CLAUDE.md: suspect a tokenizer mismatch,`);
      console.log('     undecoded HTML entities, or qrels ids not matching corpus ids.');
    } else if (headline >= 0.1 && headline <= 0.4) {
      console.log(`\n  nDCG@8 ${headline.toFixed(4)} is inside CLAUDE.md's 0.1-0.4 plausibility band for lexical`);
      console.log('  retrieval on Stack Exchange duplicate/related judgments.');
    } else {
      // Between the alarm thresholds but outside the "unremarkable" band. Named
      // as its own case rather than rounded into either: 0.06 is not a bug
      // signal and is not unremarkable, and reporting it as either would be a
      // claim the band does not support.
      console.log(`\n  nDCG@8 ${headline.toFixed(4)} is outside CLAUDE.md's 0.1-0.4 "unremarkable" band but does`);
      console.log('  not trip either alarm threshold (~0.05, ~0.7). Neither reassuring nor alarming;');
      console.log('  worth explaining rather than reporting flat.');
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`\neval failed: ${err.message}`);
  if (!err.assertion) console.error(err.stack);
  process.exit(1);
}
