'use strict';

/**
 * vectors.js — the corpus-vector binding check, extracted at Phase 5.7.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS EXTRACTED RATHER THAN COPIED, AND §33.9a IS THE REASON
 * ---------------------------------------------------------------------------
 *
 * 5.7 runs Study Pack over v5-embeddings neighbours, so build-gen-clusters.js
 * now needs the same vector loading run-eval.js has had since 3.5. Copying it
 * would put the three binding assertions in two files, and §33.9a is this
 * project's record of what that costs: `err.cause.message` was correct in
 * run-studypack-eval.js and wrong in run-judge-eval.js, THE SAME LINE, and
 * nothing distinguished them by reading. The harness held 100% delivery at 57x
 * slow for an hour.
 *
 * A drifted copy of THIS code is worse than that one was. The whole point of
 * the three checks is that vectors from a different corpus build attach
 * cleanly by row count and score plausible nonsense — a silent wrong answer,
 * not an error. So there is one copy, and run-eval.js calls it.
 *
 * ---------------------------------------------------------------------------
 * `fail` AND `log` ARE INJECTED, WHICH KEEPS THE EXTRACTION BEHAVIOUR-NEUTRAL
 * ---------------------------------------------------------------------------
 *
 * run-eval.js throws an Error carrying `assertion = true`, which its own top
 * level formats and exits on; build-gen-clusters.js prints and exits directly.
 * Passing the reporter in means neither caller's failure behaviour changes as
 * a result of the move — the extraction is not allowed to be two variables.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { sha256File } = require('./run-io');

/**
 * Attach precomputed embeddings to the corpus documents, and prove they belong
 * to this corpus before doing so.
 *
 * Returns the input record for a run sidecar, so vectors are pinned in the
 * run's provenance exactly as the corpus, qrels and split are. Called only when
 * the resolved params carry a `vectors` slug, so every rung below v5 is
 * untouched and their run files cannot move.
 */
function attachVectors({ site, slug, docs, repoRoot, fail, log = () => {} }) {
  const dir = path.join(repoRoot, 'data', 'vectors');
  const file = path.join(dir, `${site}.${slug}.f32`);
  const manifestFile = path.join(dir, `${site}.${slug}.manifest.json`);
  if (!fs.existsSync(file)) {
    fail(
      `${path.relative(repoRoot, file)} does not exist.\n` +
      '  Vectors are corpus preparation (EVALUATION.md §7.1). Build them with:\n' +
      '    node scripts/embed-corpus.js --fetch      # once, downloads the pinned weights\n' +
      `    node scripts/embed-corpus.js --site ${site}`
    );
  }
  if (!fs.existsSync(manifestFile)) {
    fail(`${path.relative(repoRoot, manifestFile)} does not exist. A vectors file with no manifest pins nothing.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  const actual = sha256File(file);
  if (manifest.output && manifest.output.sha256 && actual !== manifest.output.sha256) {
    fail(
      `${path.relative(repoRoot, file)} does not match its manifest.\n` +
      `    actual   ${actual}\n    manifest ${manifest.output.sha256}`
    );
  }

  // 1. Built from THIS corpus. Without it, vectors from an earlier corpus build
  //    would attach cleanly by row count and score plausible nonsense.
  const corpusFile = path.join(repoRoot, 'data', 'corpus', `${site}.jsonl`);
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
      `${path.relative(repoRoot, file)} is ${bytes} bytes; ${docs.length} docs × ${dim} dims × 4 ` +
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

  log(
    `  vectors ${manifest.model.repo} @ ${manifest.model.revision.slice(0, 12)}… · dim ${dim} · ` +
    `${manifest.text.maxTokens} wordpieces · ${(100 * manifest.text.truncatedShare).toFixed(1)}% truncated`
  );
  log('  vectors bound to this corpus: file sha, corpus sha and row-order ids all match the manifest');

  return {
    name: 'vectors',
    file,
    actual,
    expected: manifest.output ? manifest.output.sha256 : undefined,
    manifest
  };
}

module.exports = { attachVectors };
