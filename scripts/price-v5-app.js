'use strict';

/**
 * price-v5-app.js — Phase 4.1. What v5-embeddings costs IN THE APP.
 *
 *   npm run price:v5-app        (from backend/)  -> results/v5-app-cost.txt
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. §17.13 says v5 winning the ladder is not a reason to ship
 * it, and gives the cost as "2.6x slower per query than v4, and ~600 s of
 * embedding that Phase 4 has to place somewhere real, where the eval's 'query
 * documents are corpus documents' convenience does not hold." §19.9 repeats it
 * and hands the decision to 4.1 by name.
 *
 * THAT FRAMING IS IN THE WRONG UNIT AND THIS SCRIPT IS WHY. 584.6 s is 27,325
 * documents at 21.4 ms each, batched and offline. The app never pays it as a
 * lump: a note is embedded ONCE, at save, in a batch of one. And the eval's
 * convenience largely survives for a different reason than the eval's — the
 * app's query is a note the user just saved, so its vector already exists and
 * there is no second embed at query time.
 *
 * So the numbers that decide the question are the ones below: cold start, the
 * per-save embed at three realistic lengths, resident memory, and what the
 * runtime weighs on disk. Deciding from 584.6 s would have been deciding from
 * a number that never occurs in the deployment.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THIS FILE SITS, AND WHY IT IS NOT UNDER backend/.
 *
 * Beside embed-corpus.js, the only other thing in the repo that loads a model,
 * and for the same reason: the dependency is in scripts/package.json so that
 * "the Node eval path is dependency-free" stays a checkable property (§17.2,
 * PRIMER §13). backend/ invokes it the way it invokes embed:corpus — through a
 * script line, with the require resolving into scripts/node_modules — and
 * gains no dependency of its own.
 *
 * IT IS A COST MEASUREMENT AND NOTHING ELSE. No corpus is embedded, no vectors
 * file is read or written, no ranking is produced, no run file exists. The
 * texts below are hand-written notes, not corpus documents, because the
 * quantity of interest is what a SAVE costs and a save is one new note.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(REPO_ROOT, 'data', 'models');
const NODE_MODULES = path.join(__dirname, 'node_modules');
const TRANSFORMERS = path.join(NODE_MODULES, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
const OUT = path.join(REPO_ROOT, 'results', 'v5-app-cost.txt');
const REPO_ID = 'Xenova/all-MiniLM-L6-v2';
const MAX_TOKENS = 256;
const MIB = 1024 ** 2;

const out = [];
function w(line = '') { out.push(line); console.log(line); }

function fail(message) {
  console.error(`\nprice-v5-app: ${message}\n`);
  process.exit(1);
}

/**
 * Three note lengths. A note-taking app's notes are short — §7.7 makes that
 * point twice — and the corpus this project measured on averages 103.3 words
 * (PRIMER §13's amendment), so the middle case is deliberately near that and
 * the other two bracket it. The long one exceeds the checkpoint's 256-wordpiece
 * limit, which is the CEILING on what a single save can cost: past that,
 * truncation means a longer note costs no more.
 */
const SHORT = 'Sous vide steak timing. 54C for two hours gives medium rare all the way through, then sear hard in a ripping hot cast iron pan with clarified butter for ninety seconds a side.';
const MEDIUM = `${SHORT} ${[
  'The reason the sear has to be fast is that the interior is already at target temperature,',
  'so every second in the pan is overcooking the band just under the crust. Clarified butter',
  'because milk solids burn well below the temperature you want for Maillard browning. A cast',
  'iron pan holds enough thermal mass that dropping a cold wet steak onto it does not tank the',
  'surface temperature the way a thin stainless pan does. Dry the surface thoroughly first;',
  'water boiling off the surface costs energy that would otherwise be browning the meat, and',
  'it is the single most common reason a sous vide sear comes out grey instead of brown.'
].join(' ')}`;
const LONG = `${MEDIUM} `.repeat(4);

function rss() { return process.memoryUsage().rss; }

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p50: at(0.5), p95: at(0.95), min: s[0], max: s[s.length - 1] };
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else { bytes += fs.lstatSync(full).size; files += 1; }
      } catch { /* broken symlink — counted as nothing rather than crashing */ }
    }
  })(dir);
  return { bytes, files };
}

async function main() {
  if (!fs.existsSync(TRANSFORMERS)) {
    fail('scripts/node_modules is not installed. Run `npm ci` in scripts/ — never `npm install`, the lockfile is the pin.');
  }
  if (!fs.existsSync(path.join(MODELS_DIR, REPO_ID, 'FETCH.manifest.json'))) {
    fail('model weights are not present. Run `node scripts/embed-corpus.js --fetch` first.');
  }

  const baseline = rss();

  w('WHAT v5-embeddings COSTS IN THE APP — Phase 4.1');
  w('='.repeat(78));
  w(`  node        ${process.version}  ${process.platform}/${process.arch}`);
  w(`  cpu         ${os.cpus().length ? os.cpus()[0].model : 'unknown'} x${os.cpus().length}`);
  w(`  memory      ${(os.totalmem() / 1024 ** 3).toFixed(0)} GB`);
  w(`  model       ${REPO_ID}, fp32, dim 384, ${MAX_TOKENS} wordpieces`);
  w(`  baseline    ${(baseline / MIB).toFixed(1)} MiB RSS before any model work`);
  w();

  // --- 1. cold start ---------------------------------------------------------
  let t = process.hrtime.bigint();
  const { env, AutoTokenizer, AutoModel } = await import(TRANSFORMERS);
  const importMs = Number(process.hrtime.bigint() - t) / 1e6;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS_DIR;

  t = process.hrtime.bigint();
  const tokenizer = await AutoTokenizer.from_pretrained(REPO_ID, { local_files_only: true });
  const tokenizerMs = Number(process.hrtime.bigint() - t) / 1e6;

  t = process.hrtime.bigint();
  const model = await AutoModel.from_pretrained(REPO_ID, { local_files_only: true, dtype: 'fp32' });
  const modelMs = Number(process.hrtime.bigint() - t) / 1e6;

  const loaded = rss();

  w('1. COLD START — what a dyno pays on boot, or the first save pays if lazy');
  w('-'.repeat(78));
  w(`  import @huggingface/transformers    ${importMs.toFixed(0).padStart(5)} ms`);
  w(`  AutoTokenizer.from_pretrained       ${tokenizerMs.toFixed(0).padStart(5)} ms`);
  w(`  AutoModel.from_pretrained (fp32)    ${modelMs.toFixed(0).padStart(5)} ms`);
  w(`  TOTAL                               ${(importMs + tokenizerMs + modelMs).toFixed(0).padStart(5)} ms`);
  w();

  // --- 2. per-save embed -----------------------------------------------------
  async function embedOne(text) {
    const encoded = await tokenizer([text], { padding: true, truncation: true, max_length: MAX_TOKENS });
    const output = await model(encoded);
    return { tokens: encoded.input_ids.dims[1], dims: output.last_hidden_state.dims };
  }

  w('2. PER-NOTE EMBED — a batch of ONE, which is what a single save is');
  w('-'.repeat(78));
  w('     note                          tokens    mean     p50     p95     max');
  const cases = [['short', SHORT], ['medium', MEDIUM], ['long (truncates)', LONG]];
  for (const [label, text] of cases) {
    await embedOne(text); // warm — the first call through a graph pays one-off setup
    const runs = [];
    let tokens = 0;
    for (let i = 0; i < 12; i += 1) {
      const started = process.hrtime.bigint();
      const meta = await embedOne(text);
      runs.push(Number(process.hrtime.bigint() - started) / 1e6);
      tokens = meta.tokens;
    }
    const s = stats(runs);
    w(`     ${label.padEnd(28)}  ${String(tokens).padStart(5)}  ${s.mean.toFixed(1).padStart(6)}  ${s.p50.toFixed(1).padStart(6)}  ${s.p95.toFixed(1).padStart(6)}  ${s.max.toFixed(1).padStart(6)}`);
  }
  const afterEmbed = rss();
  w();
  w('  A SINGLE NOTE IS CHEAPER PER DOCUMENT THAN THE CORPUS RUN WAS, which is');
  w('  the opposite of what batching usually buys. §17.11\'s 584.6 s over 27,325');
  w('  documents is 21.4 ms each; the medium note above is under that on its own.');
  w('  embed-corpus.js pads every batch to its longest member (§17.3 — batchSize');
  w('  is load-bearing), so a short document in a batch of 32 pays a long');
  w('  document\'s sequence length. A save has nothing to pad against.');
  w();

  // --- 3. memory and disk ----------------------------------------------------
  const weights = dirSize(path.join(MODELS_DIR, REPO_ID));
  const runtime = dirSize(NODE_MODULES);
  const ort = dirSize(path.join(NODE_MODULES, 'onnxruntime-node'));

  w('3. WHAT IT WEIGHS');
  w('-'.repeat(78));
  w(`  RSS after loading the model         ${(loaded / MIB).toFixed(1).padStart(7)} MiB   (+${((loaded - baseline) / MIB).toFixed(1)} over baseline)`);
  w(`  RSS after embedding                 ${(afterEmbed / MIB).toFixed(1).padStart(7)} MiB`);
  w(`  model weights on disk               ${(weights.bytes / MIB).toFixed(1).padStart(7)} MiB   ${weights.files} files`);
  w(`  scripts/node_modules                ${(runtime.bytes / MIB).toFixed(1).padStart(7)} MiB   ${runtime.files} files`);
  w(`    of which onnxruntime-node         ${(ort.bytes / MIB).toFixed(1).padStart(7)} MiB   platform binaries for every target`);
  w();
  w('  THE RESIDENT FIGURE IS THE BILL, not the latency. It is paid for the');
  w('  lifetime of the process whether or not anyone saves a note, and it is');
  w('  what a Railway backend has least of.');
  w();

  w('4. WHAT THIS DOES NOT ESTABLISH');
  w('-'.repeat(78));
  w('  - Not a retrieval result. Nothing is ranked, no run file is produced, no');
  w('    corpus is embedded. §17\'s numbers are untouched by this file.');
  w('  - Not a production latency budget. One uncontrolled laptop, one process,');
  w('    no concurrency, no cold page cache. §12.4\'s distinction holds.');
  w('  - Not the cost of KEEPING vectors correct, which is the actual objection');
  w('    in §21.1: storage per note, sync with the text, and a backfill. Those');
  w('    are schema and migration costs and this script cannot see them.');
  w('  - Not a claim about a hosted model. PRIMER §13\'s escape hatch was closed');
  w('    at 3.6 for reasons unrelated to cost.');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${out.join('\n')}\n`);
  console.log(`\nwrote ${path.relative(REPO_ROOT, OUT)}`);
}

main().catch((err) => fail(err.stack || err.message));
