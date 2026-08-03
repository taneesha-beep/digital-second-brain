#!/usr/bin/env node
'use strict';

/**
 * build-corpus.js — Phase 1.2
 *
 * Streams a Stack Exchange `Posts.xml` dump, keeps questions (PostTypeId="1"),
 * and emits one JSON object per line to data/corpus/<site>.jsonl.
 *
 * Two properties this script exists to guarantee:
 *
 *   1. Posts.xml is never fully resident. It is read in 1 MiB chunks, split into
 *      lines incrementally, and written out with backpressure honoured. Peak RSS
 *      is one line + one chunk + the id set, not the file.
 *
 *   2. Reruns are byte-identical. Output order is Posts.xml document order, key
 *      order is fixed, there is no sort and no Map iteration, and the file is
 *      swapped into place with an atomic rename. The SHA-256 is printed every run
 *      so a rerun proves itself rather than being asserted.
 *
 * Text decoding is the part that quietly destroys the evaluation if it is wrong.
 * See decodeLevel1 / stripTags / decodeLevel2 below, and docs/EVALUATION.md.
 *
 * Title and Body are escaped to DIFFERENT depths, and conflating them is a bug:
 *
 *   Body  is HTML, escaped twice — the HTML encoder turned prose `<` into `&lt;`,
 *         then the XML writer turned that into `&amp;lt;`. Needs A -> B -> C -> D.
 *   Title is plain text, escaped once — a prose `<` is just `&lt;`. Needs A -> D.
 *         Running the tag stripper over a title would delete real prose the first
 *         time a title contains something shaped like `<div>`. Measured on this
 *         dump: 1 title has a raw `<` after step A, 0 titles are altered by step
 *         B, 0 titles contain a level-2 reference — so the distinction changes no
 *         bytes here, and matters on any dump whose titles discuss markup.
 *
 * Zero runtime dependencies, deliberately: an XML or entity library at a
 * different version shifts output bytes, and Phase 1.6 pins the environment in
 * order to make the corpus checksum reproducible.
 *
 * Usage: npm run corpus:build -- --site cooking
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

// ---------------------------------------------------------------------------
// Entity tables
// ---------------------------------------------------------------------------

// Level 1 — XML attribute values. These five are the only named references XML
// predefines. Anything else appearing here would be malformed XML; it is left
// literal and counted rather than guessed at.
const XML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

// Level 2 — HTML entities inside the Body text, i.e. what survives level 1 as
// `&name;`. This table is the set actually observed in the cooking dump plus
// the XML five (which recur at this level), not a speculative superset. Anything
// unrecognised is left literal and reported by name with a count — HTML5's own
// rule for an unmatched reference, and the honest option: `&space;`, `&degC;`,
// `&dev;` and `&A;` occur in this dump and are user typos, not entities. Decoding
// them would be inventing data.
const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', thinsp: ' ',
  deg: '°', mdash: '—', ndash: '–', hellip: '…',
  ldquo: '“', rdquo: '”', raquo: '»',
  frac12: '½', half: '½', frac14: '¼', frac34: '¾',
  frac13: '⅓',
  trade: '™', reg: '®', times: '×', ast: '*',
  dagger: '†', approx: '≈', rarr: '→', rlarr: '⇄',
  pi: 'π', mu: 'μ',
  eacute: 'é', iacute: 'í',
};

const REF_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

// Known references that must NOT survive to the final text. Used by guard G2.
// Deliberately excludes the unrecognised names above, which are expected to
// survive and are reported separately by guard G3.
const KNOWN_REF_RESIDUE_RE =
  /&(?:amp|lt|gt|quot|apos|nbsp|#[0-9]+|#[xX][0-9a-fA-F]+);/g;

// Control characters to drop in step D. Tab / LF / CR are omitted because the
// whitespace collapse that follows handles them; C1 (U+0080–U+009F) is included
// because `&#151;`-style Windows-1252 artifacts decode into that range.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// ---------------------------------------------------------------------------
// Decoding pipeline
// ---------------------------------------------------------------------------

function decodeNumericRef(match, ref) {
  const cp = ref[1] === 'x' || ref[1] === 'X'
    ? parseInt(ref.slice(2), 16)
    : parseInt(ref.slice(1), 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return match;
  if (cp >= 0xd800 && cp <= 0xdfff) return match; // lone surrogate
  try {
    return String.fromCodePoint(cp);
  } catch {
    return match;
  }
}

/**
 * Decode references against `table`. A callback-based replace never rescans its
 * own output, which is what makes this exactly one decode per escaping level:
 * `&amp;amp;` yields `&amp;`, not `&`.
 */
function decodeRefs(s, table, unknownCounts) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(REF_RE, (match, ref) => {
    if (ref[0] === '#') return decodeNumericRef(match, ref);
    const value = table[ref];
    if (value !== undefined) return value;
    if (unknownCounts) unknownCounts.set(ref, (unknownCounts.get(ref) || 0) + 1);
    return match; // unmatched named reference is emitted literally
  });
}

// Step A — XML attribute decode. Before this runs there are no `<` characters at
// all; after it, every raw `<` is markup, because the HTML encoder had already
// escaped prose `<` into `&lt;` before XML escaping ran.
const decodeLevel1 = (s, unknown) => decodeRefs(s, XML_ENTITIES, unknown);

// Step B — strip tags. Replacement is a SPACE, never '': deleting the tags in
// `<li>eggs</li><li>milk</li>` welds the words into the single token `eggsmilk`.
function stripTags(s) {
  if (s.indexOf('<') === -1) return s;
  return s.replace(/<[^>]*>/g, ' ');
}

// Step C — HTML entity decode. Must run AFTER step B. This dump contains 231
// occurrences of `&amp;lt;` — prose "<" a user typed. Decoding first would turn
// them into real `<` and the tag stripper would then eat them plus everything up
// to the next `>`, silently deleting prose. Stripping first means only genuine
// markup is removed.
const decodeLevel2 = (s, unknown) => decodeRefs(s, HTML_ENTITIES, unknown);

// Step D — drop control characters, collapse whitespace, trim. JS `\s` covers
// U+00A0 and U+2009, so a decoded `&nbsp;` / `&thinsp;` becomes an ordinary
// space here rather than surviving as the token `nbsp`.
function normalizeWhitespace(s) {
  return s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tokeniser replica, for the markup-leak canary (guard G4)
// ---------------------------------------------------------------------------

// Mirrors backend/utils/keywords.js `tokenise` minus the stopword filter, which
// contains none of the canary terms. Copied rather than imported so the corpus
// builder stays independent of app code.
function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// `lt` and `gt` are absent: at 2 characters they cannot survive the tokeniser,
// so they are not a leak this canary can detect.
const CANARY_TERMS = [
  'amp', 'quot', 'nbsp', 'href', 'https', 'blockquote',
  'code', 'pre', 'img', 'src', 'strong', 'span', 'div',
];

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

const ROW_START_RE = /^\s*<row\s/;
const ATTR_RE = /([A-Za-z]+)="([^"]*)"/g;

/**
 * `"` inside an XML attribute value must be escaped as `&quot;`, so `[^"]*`
 * can neither under- nor over-run a value regardless of `>` or `/` appearing
 * inside it. That is why this never needs to locate the closing `/>`.
 */
function parseAttributes(line) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

// Tags bypass the tag stripper entirely. This dump is pipe-delimited
// (`|baking|cookies|`); the angle-delimited legacy form is parsed explicitly so
// that a future dump in that shape is not eaten by stripTags.
function parseTags(raw, unknown) {
  const decoded = decodeLevel1(raw || '', unknown);
  if (!decoded) return [];
  let parts;
  if (decoded.indexOf('|') !== -1) {
    parts = decoded.split('|');
  } else if (decoded.indexOf('<') !== -1) {
    parts = [];
    let m;
    const re = /<([^>]*)>/g;
    while ((m = re.exec(decoded)) !== null) parts.push(m[1]);
  } else {
    parts = [decoded];
  }
  return parts
    .map((t) => normalizeWhitespace(decodeLevel2(t, unknown)))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { site: 'cooking' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--site' && argv[i + 1]) { args.site = argv[i + 1]; i += 1; }
  }
  return args;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  const t0 = process.hrtime.bigint();
  const { site } = parseArgs(process.argv.slice(2));

  // Resolved from this file, not process.cwd(), so `docker compose run corpus`
  // with ./data mounted works regardless of the working directory.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const inputPath = path.join(repoRoot, 'data', 'raw', site, 'Posts.xml');
  const outDir = path.join(repoRoot, 'data', 'corpus');
  const outPath = path.join(outDir, `${site}.jsonl`);
  const tmpPath = path.join(outDir, `${site}.jsonl.tmp`);
  const manifestPath = path.join(outDir, `${site}.manifest.json`);

  if (!fs.existsSync(inputPath)) {
    console.error(`build-corpus: missing input ${inputPath}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const stats = {
    linesTotal: 0,
    rowsTotal: 0,
    nonRowLines: 0,
    rowsNotSelfClosing: 0,
    questions: 0,
    missingBody: 0,
    missingScore: 0,
    missingCreationDate: 0,
    emptyBodyAfterClean: 0,
    shortBodyAfterClean: 0, // < 10 chars
    g1TagResidueDocs: 0,
    g1TagResidueOccurrences: 0,
    g2RefResidueDocs: 0,
    g2RefResidueOccurrences: 0,
    peakRssSampledBytes: 0,
  };
  const unknownLevel1 = new Map();
  const unknownLevel2 = new Map();
  const canaryDocs = new Map(CANARY_TERMS.map((t) => [t, 0]));
  const residueExamples = [];
  const seenIds = new Set();

  const inputHash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmpPath, { flags: 'w' });
  const decoder = new TextDecoder('utf-8');

  const write = async (chunk) => {
    if (!out.write(chunk)) await once(out, 'drain');
  };

  const handleLine = async (rawLine) => {
    stats.linesTotal += 1;
    if (stats.linesTotal % 5000 === 0) {
      const rss = process.memoryUsage().rss;
      if (rss > stats.peakRssSampledBytes) stats.peakRssSampledBytes = rss;
    }

    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!ROW_START_RE.test(line)) {
      if (line.trim() !== '') stats.nonRowLines += 1;
      return;
    }
    stats.rowsTotal += 1;
    if (!line.trimEnd().endsWith('/>')) stats.rowsNotSelfClosing += 1;

    const attrs = parseAttributes(line);
    if (attrs.PostTypeId !== '1') return;
    stats.questions += 1;

    const id = decodeLevel1(attrs.Id || '', unknownLevel1);
    if (seenIds.has(id)) {
      throw new Error(`duplicate Id ${id} — corpus ids must be unique`);
    }
    seenIds.add(id);

    if (attrs.Body === undefined) stats.missingBody += 1;
    if (attrs.Score === undefined) stats.missingScore += 1;
    if (attrs.CreationDate === undefined) stats.missingCreationDate += 1;

    // --- Title and Body are escaped to DIFFERENT depths; see the note above ---
    //
    // Title is plain text, XML-escaped once: steps A and D only.
    const titleText = normalizeWhitespace(
      decodeLevel1(attrs.Title || '', unknownLevel1)
    );

    // Body is HTML, escaped twice: the full A -> B -> C -> D pipeline.
    const bodyLvl1 = decodeLevel1(attrs.Body || '', unknownLevel1);
    const bodyStripped = stripTags(bodyLvl1);

    // Guard G1: after stripping the body, no raw `<` should remain. Prose `<` in
    // a body is still `&lt;` at this point, so anything here is an unterminated
    // tag. This applies to Body only — a `<` in a Title is ordinary prose.
    let tagResidue = 0;
    for (let i = 0; i < bodyStripped.length; i += 1) {
      if (bodyStripped.charCodeAt(i) === 60) tagResidue += 1;
    }

    const bodyText = normalizeWhitespace(decodeLevel2(bodyStripped, unknownLevel2));

    if (tagResidue > 0) {
      stats.g1TagResidueDocs += 1;
      stats.g1TagResidueOccurrences += tagResidue;
      if (residueExamples.length < 10) {
        residueExamples.push(`G1 id=${id} ${bodyText.slice(0, 120)}`);
      }
    }

    // Guard G2: no known reference may survive to the final text.
    const combined = `${titleText} ${bodyText}`;
    const refResidue = combined.match(KNOWN_REF_RESIDUE_RE);
    if (refResidue) {
      stats.g2RefResidueDocs += 1;
      stats.g2RefResidueOccurrences += refResidue.length;
      if (residueExamples.length < 10) {
        residueExamples.push(`G2 id=${id} ${refResidue.slice(0, 5).join(' ')}`);
      }
    }

    // Guard G4: markup-leak canary, over the app's own tokenisation rules.
    const tokens = new Set(tokenise(combined));
    for (const term of CANARY_TERMS) {
      if (tokens.has(term)) canaryDocs.set(term, canaryDocs.get(term) + 1);
    }

    if (bodyText.length === 0) stats.emptyBodyAfterClean += 1;
    else if (bodyText.length < 10) stats.shortBodyAfterClean += 1;

    const scoreRaw = attrs.Score === undefined ? '0' : attrs.Score;
    const score = Number.parseInt(scoreRaw, 10);

    // Fixed key order. `id` is a string so that qrels ids (Phase 1.3) and corpus
    // ids have exactly one representation and no 1 !== "1" join bug is available.
    // `creationDate` is stored verbatim from the dump — no timezone is appended,
    // because the dump states none.
    const record = {
      id,
      title: titleText,
      body: bodyText,
      tags: parseTags(attrs.Tags, unknownLevel1),
      score: Number.isFinite(score) ? score : 0,
      creationDate: decodeLevel1(attrs.CreationDate || '', unknownLevel1),
    };

    await write(`${JSON.stringify(record)}\n`);
  };

  // --- streaming read: hash raw bytes and split lines in a single pass ---
  const input = fs.createReadStream(inputPath, { highWaterMark: 1 << 20 });
  let carry = '';
  for await (const chunk of input) {
    inputHash.update(chunk);
    const text = decoder.decode(chunk, { stream: true });
    const parts = (carry + text).split('\n');
    carry = parts.pop();
    for (const line of parts) await handleLine(line);
  }
  carry += decoder.decode();
  if (carry.charCodeAt(0) === 0xfeff) carry = carry.slice(1); // defensive BOM strip
  if (carry.trim() !== '') await handleLine(carry);

  out.end();
  await once(out, 'finish');

  // fsync before rename so the bytes are durable, then swap atomically: an
  // interrupted run leaves the previous complete file or the new complete file,
  // never a truncated one for Phase 1.3 to consume.
  const fd = fs.openSync(tmpPath, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, outPath);

  const outputSha = await sha256File(outPath);
  const inputSha = inputHash.digest('hex');
  const outputBytes = fs.statSync(outPath).size;
  const inputBytes = fs.statSync(inputPath).size;

  // Manifest carries content only — no timestamp, no Node version — so that it
  // is byte-identical wherever the corpus is, and Phase 1.6 can diff it directly.
  const manifest = {
    site,
    schema: ['id', 'title', 'body', 'tags', 'score', 'creationDate'],
    source: {
      file: `data/raw/${site}/Posts.xml`,
      bytes: inputBytes,
      sha256: inputSha,
      rows: stats.rowsTotal,
    },
    output: {
      file: `data/corpus/${site}.jsonl`,
      bytes: outputBytes,
      sha256: outputSha,
      documents: stats.questions,
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const usage = process.resourceUsage();

  // --- report ---
  const pct = (n) => `${((n / Math.max(stats.questions, 1)) * 100).toFixed(4)}%`;
  console.log('');
  console.log(`corpus:build — site=${site}`);
  console.log('');
  console.log('  input');
  console.log(`    file                    data/raw/${site}/Posts.xml`);
  console.log(`    bytes                   ${inputBytes.toLocaleString('en-US')}`);
  console.log(`    sha256                  ${inputSha}`);
  console.log(`    lines                   ${stats.linesTotal.toLocaleString('en-US')}`);
  console.log(`    <row> elements          ${stats.rowsTotal.toLocaleString('en-US')}`);
  console.log(`    non-row lines           ${stats.nonRowLines}`);
  console.log(`    rows not self-closing   ${stats.rowsNotSelfClosing}`);
  console.log('');
  console.log('  output');
  console.log(`    file                    data/corpus/${site}.jsonl`);
  console.log(`    documents               ${stats.questions.toLocaleString('en-US')}`);
  console.log(`    bytes                   ${outputBytes.toLocaleString('en-US')}`);
  console.log(`    sha256                  ${outputSha}`);
  console.log('');
  console.log('  decode guards');
  console.log(`    G1 tag residue          ${stats.g1TagResidueDocs} docs / ${stats.g1TagResidueOccurrences} occ  (${pct(stats.g1TagResidueDocs)})`);
  console.log(`    G2 known-ref residue    ${stats.g2RefResidueDocs} docs / ${stats.g2RefResidueOccurrences} occ  (${pct(stats.g2RefResidueDocs)})`);
  console.log(`    G3 unknown refs L1      ${unknownLevel1.size === 0 ? 'none' : [...unknownLevel1].map(([k, v]) => `&${k};×${v}`).join(' ')}`);
  console.log(`    G3 unknown refs L2      ${unknownLevel2.size === 0 ? 'none' : [...unknownLevel2].map(([k, v]) => `&${k};×${v}`).join(' ')}`);
  console.log(`    G4 canary (docs)        ${CANARY_TERMS.map((t) => `${t}=${canaryDocs.get(t)}`).join('  ')}`);
  if (residueExamples.length) {
    console.log('    examples:');
    for (const e of residueExamples) console.log(`      ${e}`);
  }
  console.log('');
  console.log('  data quality');
  console.log(`    missing Body            ${stats.missingBody}`);
  console.log(`    missing Score           ${stats.missingScore}`);
  console.log(`    missing CreationDate    ${stats.missingCreationDate}`);
  console.log(`    empty body after clean  ${stats.emptyBodyAfterClean}`);
  console.log(`    body < 10 chars         ${stats.shortBodyAfterClean}`);
  console.log('');
  console.log('  run');
  console.log(`    wall time               ${wallMs.toFixed(0)} ms`);
  console.log(`    peak RSS (maxRSS)       ${usage.maxRSS.toLocaleString('en-US')} (resourceUsage units)`);
  console.log(`    peak RSS (sampled)      ${(stats.peakRssSampledBytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`    node                    ${process.version} ${process.platform}/${process.arch}`);
  console.log('');

  // Hard failures. Structural problems are absolute; decode residue is allowed a
  // 0.05% floor so a single malformed post cannot block a 27k-document build,
  // while a systematic decode-order error (which affects thousands) still does.
  const residueLimit = Math.floor(stats.questions * 0.0005);
  const failures = [];
  if (stats.rowsNotSelfClosing > 0) failures.push(`${stats.rowsNotSelfClosing} rows not self-closing`);
  if (stats.nonRowLines > 3) failures.push(`${stats.nonRowLines} unexpected non-row lines`);
  if (stats.g1TagResidueDocs > residueLimit) failures.push(`G1 tag residue in ${stats.g1TagResidueDocs} docs > limit ${residueLimit}`);
  if (stats.g2RefResidueDocs > residueLimit) failures.push(`G2 reference residue in ${stats.g2RefResidueDocs} docs > limit ${residueLimit}`);
  if (stats.questions === 0) failures.push('no questions emitted');

  if (failures.length) {
    console.error('build-corpus FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('build-corpus: fatal —', err && err.stack ? err.stack : err);
  process.exit(1);
});
