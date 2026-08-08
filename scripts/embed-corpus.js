'use strict';

/**
 * embed-corpus.js — Phase 3.4. Corpus preparation for retriever v5.
 *
 *   node scripts/embed-corpus.js --fetch
 *   node scripts/embed-corpus.js --site cooking
 *   node scripts/embed-corpus.js --site cooking --max-tokens 128
 *   node scripts/embed-corpus.js --site cooking --title-repeat 2
 *
 * Reads data/corpus/<site>.jsonl, writes data/vectors/<site>.<slug>.f32 and a
 * manifest beside it. Nothing else in the repo imports this file.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT PART OF THE RETRIEVER.
 *
 * EVALUATION.md §7.1: corpus preparation is anything needing I/O or a model;
 * the retriever is everything that is a pure function of the documents. This
 * needs 86 MiB of weights off disk, so it is preparation, and the vectors reach
 * v5-embeddings.js as DATA exactly as text does. backend/retrieval/ may require
 * nothing outside itself (crypto excepted) and a test enforces it, so an import
 * of this library inside the retriever breaks the suite rather than shipping.
 *
 * A COST §7.1 DID NOT FORESEE, recorded here because this is where it is paid.
 * §7.1's argument for keeping keyword extraction INSIDE the retriever was that
 * ablations then become param flips landing in describe(handle).digest. For v5
 * that inverts: every ablation except `normalise` is a corpus-prep change
 * costing a full re-embed. The boundary is still right — a model cannot live
 * behind a pure-function contract — but the reason §7.1 gave for it does not
 * extend to this rung.
 * ─────────────────────────────────────────────────────────────────────────
 * REPRODUCIBILITY, AND WHAT IS AND IS NOT CLAIMED.
 *
 * Phase 1.6 proved cooking.jsonl regenerates BYTE-IDENTICALLY across OS, libc
 * and architecture, because the eval scripts have zero runtime dependencies.
 * THAT PROPERTY DOES NOT EXTEND TO THIS OUTPUT AND IS NOT CLAIMED FOR IT.
 * ONNX Runtime dispatches to architecture-specific SIMD kernels whose reduction
 * orders differ, so a 384-dim mean-pool over a transformer stack will differ in
 * the last few ULPs between arm64 and x86_64. Asserting otherwise would be the
 * single worst thing this rung could do to the project's credibility.
 *
 * What replaces it: THE VECTORS CHANGE CLASS, from a regenerable output to a
 * PINNED INPUT. That class already exists here — nothing regenerates Posts.xml
 * either, and §1 pins it by SHA-256 while saying plainly that the URL does not
 * pin the bytes. The vectors join it. Everything downstream of the vectors
 * stays exactly as reproducible as it was.
 *
 * So the pins are:
 *   model         HF revision COMMIT SHA, not a branch name, plus a SHA-256 per
 *                 downloaded file. 6.1 pins images by digest for this reason.
 *   libraries     scripts/package-lock.json, committed, installed with `npm ci`.
 *                 npm's per-package integrity hash is the analogue of
 *                 requirements.txt's --require-hashes.
 *   weights       fetched by an explicit --fetch step into data/models/, and the
 *                 embed run sets allowRemoteModels=false so it is OFFLINE BY
 *                 CONSTRUCTION. Roadmap 1.6 warned that fetching at run time
 *                 makes "reproducible" depend on a network call; this is that
 *                 note satisfied without needing a container to satisfy it.
 *   batching      batchSize is IN THE MANIFEST, because it is load-bearing and
 *                 almost nobody notices: padding to the batch maximum changes
 *                 matmul shapes and therefore kernel tiling, so the same
 *                 document embedded in a differently-composed batch can differ
 *                 in the last ULP. Batches are taken in CORPUS ORDER at a fixed
 *                 size — not sorted by length, which would be faster and would
 *                 make the output a function of the length distribution.
 *
 * Same-machine byte determinism is MEASURED, not assumed: run twice and cmp.
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE MODEL SEES, AND THE ONE CONFOUND THAT MATTERS.
 *
 * Text is `${title}\n${body}`. THE TITLE IS NOT DOUBLED, and that is a decision
 * rather than an omission: keywords.js:59's doubling is a term-frequency trick
 * with no analogue in attention, it consumes truncation budget, and it is not
 * what a sentence-transformers checkpoint was trained on. §16.9(c) measured the
 * doubling at +0.0119 for BM25, so it is the first thing a reader will ask
 * about — `--title-repeat 2` is the ablation that answers it, at the cost of a
 * full re-embed.
 *
 * TRUNCATION IS THE CONFOUND. all-MiniLM-L6-v2 accepts 256 wordpieces. BM25
 * reads every token of a 2,185-token document; this model reads the first 256.
 * That is not a tuning choice, it is the checkpoint's limit, and it sits inside
 * any v4-vs-v5 comparison. The script therefore COUNTS how many documents are
 * truncated rather than leaving it to be estimated, and `--max-tokens 128` is
 * the sensitivity probe: if halving the window barely moves nDCG, truncation is
 * not what limits v5 and the headline is clean.
 *
 * VECTORS ARE STORED UNNORMALISED, deliberately. Normalising here would bake
 * the choice into the data and make cosine-vs-dot-product a re-embed instead of
 * a param flip. v5's `normalise` param does it at rank time, so the one free
 * ablation stays free.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(REPO_ROOT, 'data', 'models');

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

/**
 * A branch name is not a pin. HuggingFace repositories are mutable and a
 * re-upload under `main` would silently change every vector in this project,
 * with no checksum in the chain moving to say so. This is the commit.
 */
const MODEL = {
  repo: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dim: 384,
  maxTokensLimit: 256,
  // fp32, NOT a quantized export. int8 would add a second axis of
  // nondeterminism and weaken the model, and this rung's conclusion is already
  // conditional on the model being small — "and quantized" would let the caveat
  // swallow the result.
  onnxFile: 'onnx/model.onnx',
  files: [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model.onnx'
  ]
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`\nembed-corpus: ${message}\n`);
  process.exit(1);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** Atomic write — 1.2's rule, so an interrupted run cannot leave a truncated file. */
function writeAtomic(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const args = { site: 'cooking', maxTokens: 256, titleRepeat: 1, batchSize: 32, fetch: false, slug: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--fetch') args.fetch = true;
    else if (flag === '--site' && value) { args.site = value; i += 1; }
    else if (flag === '--max-tokens' && value) { args.maxTokens = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--title-repeat' && value) { args.titleRepeat = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--batch-size' && value) { args.batchSize = Number.parseInt(value, 10); i += 1; }
    else if (flag === '--slug' && value) { args.slug = value; i += 1; }
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isInteger(args.maxTokens) || args.maxTokens < 8 || args.maxTokens > MODEL.maxTokensLimit) {
    throw new Error(`--max-tokens must be an integer in [8, ${MODEL.maxTokensLimit}] (the checkpoint's own limit)`);
  }
  if (!Number.isInteger(args.titleRepeat) || args.titleRepeat < 0 || args.titleRepeat > 4) {
    throw new Error('--title-repeat must be an integer in [0, 4]');
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) {
    throw new Error('--batch-size must be a positive integer');
  }
  return args;
}

/**
 * The slug names the DATA, and v5 carries it as a param so the params digest
 * moves when the vectors move. Without that, a 256-token run and a 128-token
 * run would share a digest and differ only in an input hash — and §11.4's
 * parameter diff, the thing that says how many variables changed, reads the
 * digest.
 */
function slugFor(args) {
  if (args.slug) return args.slug;
  const base = `minilm-l6-v2-fp32-${args.maxTokens}`;
  return args.titleRepeat === 1 ? base : `${base}-title${args.titleRepeat}`;
}

// ---------------------------------------------------------------------------
// --fetch: the one step that touches the network
// ---------------------------------------------------------------------------

async function fetchWeights() {
  const dest = path.join(MODELS_DIR, MODEL.repo);
  console.log(`fetch ${MODEL.repo} @ ${MODEL.revision}`);
  console.log(`  -> ${path.relative(REPO_ROOT, dest)}\n`);

  const hashes = {};
  for (const rel of MODEL.files) {
    const url = `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${rel}`;
    const out = path.join(dest, rel);
    if (fs.existsSync(out)) {
      hashes[rel] = { bytes: fs.statSync(out).size, sha256: sha256File(out) };
      console.log(`  = ${rel.padEnd(26)} ${hashes[rel].bytes} bytes (already present)`);
      continue;
    }
    const response = await fetch(url);
    if (!response.ok) fail(`GET ${url} -> ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    writeAtomic(out, buffer);
    hashes[rel] = { bytes: buffer.length, sha256: sha256File(out) };
    console.log(`  + ${rel.padEnd(26)} ${hashes[rel].bytes} bytes  ${hashes[rel].sha256.slice(0, 16)}…`);
  }

  const manifest = {
    _: 'Model weights for retriever v5. data/ is gitignored; the SHA-256s below are the pin and are recorded in docs/EVALUATION.md §17.',
    repo: MODEL.repo,
    revision: MODEL.revision,
    revisionIsCommit: true,
    fetchedAt: new Date().toISOString(),
    files: hashes
  };
  writeAtomic(path.join(dest, 'FETCH.manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  console.log(`\n  manifest ${path.relative(REPO_ROOT, path.join(dest, 'FETCH.manifest.json'))}`);
  console.log('  the embed run is offline: allowRemoteModels=false, local_files_only=true\n');
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embed(args) {
  const slug = slugFor(args);
  const corpusFile = path.join(REPO_ROOT, 'data', 'corpus', `${args.site}.jsonl`);
  if (!fs.existsSync(corpusFile)) {
    fail(`${path.relative(REPO_ROOT, corpusFile)} does not exist. See docs/EVALUATION.md §1.`);
  }
  const weightsManifestFile = path.join(MODELS_DIR, MODEL.repo, 'FETCH.manifest.json');
  if (!fs.existsSync(weightsManifestFile)) {
    fail('model weights are not present. Run `node scripts/embed-corpus.js --fetch` first.');
  }
  const weightsManifest = JSON.parse(fs.readFileSync(weightsManifestFile, 'utf8'));
  if (weightsManifest.revision !== MODEL.revision) {
    fail(
      `the fetched weights are revision ${weightsManifest.revision} but this script pins ` +
      `${MODEL.revision}. Delete data/models/ and re-fetch.`
    );
  }
  // Re-verify the bytes rather than trusting the manifest. §8.1's rule: a copied
  // hash proves a manifest exists, not that the bytes match it.
  for (const [rel, entry] of Object.entries(weightsManifest.files)) {
    const actual = sha256File(path.join(MODELS_DIR, MODEL.repo, rel));
    if (actual !== entry.sha256) {
      fail(`${rel} does not match its fetch manifest.\n    actual   ${actual}\n    manifest ${entry.sha256}`);
    }
  }

  const corpusSha256 = sha256File(corpusFile);
  const docs = readLines(corpusFile).map((line) => JSON.parse(line));
  const n = docs.length;
  const ids = docs.map((d) => d.id);
  // Binds the row order of the vectors file to the corpus, so a misalignment is
  // impossible rather than unlikely. Row/document misalignment is the dense
  // rung's equivalent of self-retrieval: it produces a plausible-looking number
  // from complete nonsense, and nothing else in the pipeline would notice.
  const idsSha256 = sha256Text(`${ids.join('\n')}\n`);

  console.log(`embed ${args.site} — ${n} documents`);
  console.log(`  model      ${MODEL.repo} @ ${MODEL.revision.slice(0, 12)}…  fp32  dim ${MODEL.dim}`);
  console.log(`  text       title${args.titleRepeat === 1 ? '' : ` ×${args.titleRepeat}`} + "\\n" + body, truncated at ${args.maxTokens} wordpieces`);
  console.log(`  batching   ${args.batchSize} in corpus order, padded to the batch maximum`);
  console.log(`  slug       ${slug}\n`);

  const { env, AutoTokenizer, AutoModel } = await import('@huggingface/transformers');
  // Offline by construction. If a weight file were missing this throws rather
  // than reaching for the network, which is the difference between a pinned
  // artifact and a pinned URL.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_DIR;

  const tokenizer = await AutoTokenizer.from_pretrained(MODEL.repo, { local_files_only: true });
  const model = await AutoModel.from_pretrained(MODEL.repo, { local_files_only: true, dtype: 'fp32' });

  const texts = docs.map((d) => {
    const title = (d.title || '').trim();
    const body = (d.body || '').trim();
    const parts = [];
    for (let r = 0; r < args.titleRepeat; r += 1) parts.push(title);
    parts.push(body);
    return parts.join('\n');
  });

  // Truncation is counted, not estimated. Two passes over the tokenizer is
  // cheap next to 27,325 forward passes, and "11% of documents are truncated"
  // is a number the writeup needs beside the headline.
  let truncated = 0;
  let totalTokens = 0;
  let maxTokensSeen = 0;
  for (let i = 0; i < n; i += 1) {
    const length = tokenizer.encode(texts[i]).length;
    totalTokens += Math.min(length, args.maxTokens);
    if (length > maxTokensSeen) maxTokensSeen = length;
    if (length > args.maxTokens) truncated += 1;
  }
  console.log(`  truncation ${truncated} of ${n} documents (${(100 * truncated / n).toFixed(1)}%) exceed ${args.maxTokens} wordpieces; longest is ${maxTokensSeen}`);

  const out = new Float32Array(n * MODEL.dim);
  const started = process.hrtime.bigint();
  let done = 0;

  for (let start = 0; start < n; start += args.batchSize) {
    const end = Math.min(start + args.batchSize, n);
    const batch = texts.slice(start, end);
    const encoded = await tokenizer(batch, {
      padding: true,
      truncation: true,
      max_length: args.maxTokens
    });
    const output = await model(encoded);

    // MEAN POOLING OVER THE ATTENTION MASK — what this checkpoint's
    // sentence-transformers configuration specifies. Padding contributes
    // nothing, which is why batch composition affects only the last ULP rather
    // than the value.
    const hidden = output.last_hidden_state;
    const [batchSize, seqLength, dim] = hidden.dims;
    if (dim !== MODEL.dim) fail(`model emitted dim ${dim}, expected ${MODEL.dim}`);
    const hiddenData = hidden.data;
    const mask = encoded.attention_mask.data;

    for (let b = 0; b < batchSize; b += 1) {
      const rowBase = (start + b) * MODEL.dim;
      let kept = 0;
      for (let s = 0; s < seqLength; s += 1) {
        if (Number(mask[b * seqLength + s]) === 0) continue;
        kept += 1;
        const base = (b * seqLength + s) * dim;
        for (let d = 0; d < dim; d += 1) out[rowBase + d] += hiddenData[base + d];
      }
      if (kept === 0) fail(`document ${ids[start + b]} produced an all-padding sequence`);
      for (let d = 0; d < dim; d += 1) out[rowBase + d] /= kept;
    }

    done = end;
    if (start % (args.batchSize * 50) === 0 || done === n) {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      process.stdout.write(`\r  ${done}/${n}  ${(done / elapsed).toFixed(0)} docs/s  ${elapsed.toFixed(0)}s   `);
    }
  }
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write('\n');

  // --- guards on the produced vectors ---------------------------------------
  // A dense rung fails quietly: NaNs sort, zero vectors give cosine 0, and a
  // collapsed embedding gives every pair cosine 0.99 and a plausible nDCG.
  let minNorm = Infinity;
  let maxNorm = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let d = 0; d < MODEL.dim; d += 1) {
      const value = out[i * MODEL.dim + d];
      if (!Number.isFinite(value)) fail(`document ${ids[i]} has a non-finite component at dim ${d}`);
      sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (!(norm > 0)) fail(`document ${ids[i]} has a zero-norm vector`);
    if (norm < minNorm) minNorm = norm;
    if (norm > maxNorm) maxNorm = norm;
  }

  // Degeneracy probe: if mean pairwise cosine is near 1 the embedding has
  // collapsed and any nDCG it produces is an artifact. Deterministic sample —
  // a fixed stride, not a PRNG, because this figure goes in a manifest.
  const sample = [];
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 500))) sample.push(i);
  const unit = sample.map((i) => {
    const v = out.subarray(i * MODEL.dim, (i + 1) * MODEL.dim);
    let sum = 0;
    for (let d = 0; d < MODEL.dim; d += 1) sum += v[d] * v[d];
    const inv = 1 / Math.sqrt(sum);
    return Float64Array.from(v, (x) => x * inv);
  });
  let cosSum = 0;
  let cosMax = -1;
  let pairs = 0;
  for (let a = 0; a < unit.length; a += 1) {
    for (let b = a + 1; b < unit.length; b += 1) {
      let dot = 0;
      for (let d = 0; d < MODEL.dim; d += 1) dot += unit[a][d] * unit[b][d];
      cosSum += dot;
      if (dot > cosMax) cosMax = dot;
      pairs += 1;
    }
  }
  const meanPairwiseCosine = cosSum / pairs;
  if (meanPairwiseCosine > 0.9) {
    fail(
      `mean pairwise cosine is ${meanPairwiseCosine.toFixed(4)} over ${pairs} sampled pairs. ` +
      'The embedding has collapsed — every document is nearly the same vector — and any ' +
      'nDCG computed from it would be an artifact rather than a result.'
    );
  }

  // --- write -----------------------------------------------------------------
  const outFile = path.join(REPO_ROOT, 'data', 'vectors', `${args.site}.${slug}.f32`);
  // Little-endian float32, row-major, row i is corpus line i. Node writes
  // Float32Array in host byte order; arm64 and x86_64 are both little-endian,
  // and the manifest records it so a big-endian reader fails loudly rather than
  // silently reading garbage.
  writeAtomic(outFile, Buffer.from(out.buffer, out.byteOffset, out.byteLength));

  const manifest = {
    _: 'Vectors for retriever v5 (Phase 3.4). data/ is gitignored; the SHA-256s here are recorded in docs/EVALUATION.md §17.',
    _notReproducibleByteWise: [
      'THIS FILE IS A PINNED INPUT, NOT A REGENERABLE OUTPUT, and that is stated',
      'rather than discovered. Phase 1.6 proved cooking.jsonl regenerates',
      'byte-identically across OS, libc and architecture because the corpus',
      'scripts have zero runtime dependencies. ONNX Runtime does not have that',
      'property: it dispatches to architecture-specific SIMD kernels whose',
      'reduction orders differ, so these bytes are not expected to reproduce on',
      'another architecture. Same machine, same pins, same batchSize DOES',
      'reproduce and is measured by running twice and comparing this hash.',
      '',
      'Everything downstream of this file is exactly as reproducible as before:',
      'run files, metrics and comparisons are pure functions of it.'
    ],
    site: args.site,
    slug,
    model: {
      repo: MODEL.repo,
      revision: MODEL.revision,
      dtype: 'fp32',
      dim: MODEL.dim,
      pooling: 'mean over attention mask',
      files: weightsManifest.files
    },
    text: {
      template: args.titleRepeat === 1 ? 'title + "\\n" + body' : `title × ${args.titleRepeat} + "\\n" + body`,
      titleRepeat: args.titleRepeat,
      maxTokens: args.maxTokens,
      truncatedDocuments: truncated,
      truncatedShare: truncated / n,
      longestDocumentTokens: maxTokensSeen,
      meanTokensAfterTruncation: totalTokens / n
    },
    batching: {
      batchSize: args.batchSize,
      order: 'corpus order — NOT sorted by length',
      padding: 'to the batch maximum',
      why: 'padding changes matmul shapes and therefore kernel tiling, so batchSize is load-bearing on the last ULP and is pinned here'
    },
    vectors: {
      normalised: false,
      why: 'stored raw so v5\'s `normalise` param makes cosine-vs-dot-product a param flip rather than a re-embed',
      dtype: 'float32',
      byteOrder: 'little-endian',
      layout: 'row-major, row i is corpus line i',
      rows: n,
      dim: MODEL.dim,
      normRange: [minNorm, maxNorm],
      meanPairwiseCosineSample: meanPairwiseCosine,
      maxPairwiseCosineSample: cosMax,
      sampledPairs: pairs
    },
    binding: {
      corpus: path.relative(REPO_ROOT, corpusFile),
      corpusSha256,
      idsSha256,
      idsSha256Is: 'SHA-256 over the corpus doc ids joined by \\n, with a trailing \\n, in row order',
      why: 'run-eval.js recomputes both from the loaded corpus. Row misalignment is the dense equivalent of self-retrieval — it produces a plausible number from nonsense — so it is made impossible rather than unlikely'
    },
    output: {
      file: path.relative(REPO_ROOT, outFile),
      bytes: out.byteLength,
      sha256: sha256File(outFile)
    },
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpus: os.cpus().length ? os.cpus()[0].model : 'unknown',
      transformersJs: JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8')).version,
      onnxruntimeNode: JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', 'onnxruntime-node', 'package.json'), 'utf8')).version,
      wallMs,
      docsPerSecond: n / (wallMs / 1000)
    },
    command: `node scripts/embed-corpus.js --site ${args.site}` +
      (args.maxTokens === 256 ? '' : ` --max-tokens ${args.maxTokens}`) +
      (args.titleRepeat === 1 ? '' : ` --title-repeat ${args.titleRepeat}`) +
      (args.batchSize === 32 ? '' : ` --batch-size ${args.batchSize}`)
  };
  const manifestFile = path.join(REPO_ROOT, 'data', 'vectors', `${args.site}.${slug}.manifest.json`);
  writeAtomic(manifestFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  console.log('');
  console.log(`  wall       ${(wallMs / 1000).toFixed(1)} s  (${(n / (wallMs / 1000)).toFixed(0)} docs/s)`);
  console.log(`  norms      [${minNorm.toFixed(4)}, ${maxNorm.toFixed(4)}]`);
  console.log(`  pairwise   mean cos ${meanPairwiseCosine.toFixed(4)}, max ${cosMax.toFixed(4)} over ${pairs} sampled pairs`);
  console.log(`  vectors    ${path.relative(REPO_ROOT, outFile)}  ${out.byteLength} bytes`);
  console.log(`             sha256 ${manifest.output.sha256}`);
  console.log(`  manifest   ${path.relative(REPO_ROOT, manifestFile)}`);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.fetch) {
    await fetchWeights();
    return;
  }
  await embed(args);
}

main().catch((err) => fail(err.stack || err.message));
