#!/usr/bin/env node
'use strict';

/**
 * build-qrels.js — Phase 1.3
 *
 * Turns `PostLinks.xml` into a TREC qrels file — the answer key every retriever
 * on the Phase 3 ladder is scored against.
 *
 *   data/raw/<site>/PostLinks.xml  ->  data/qrels/<site>.qrels
 *   LinkTypeId 1 (Linked)     -> grade 1
 *   LinkTypeId 3 (Duplicate)  -> grade 2
 *
 * Four decisions, each of which silently changes every number downstream if it
 * is wrong. All four are resolved on ONE key — the unordered pair — in one
 * order: canonicalise -> resolve grade -> symmetrise. Resolving after
 * symmetrising is what lets the two directions drift apart.
 *
 *   1. OUT OF CORPUS. A row survives only if BOTH endpoints are in
 *      data/corpus/<site>.jsonl. That set is exactly what the retriever will
 *      index, so it is the only membership that matters, and a single test
 *      catches answers, deleted posts and migrated posts without needing to
 *      tell them apart. Pass --explain-drops to break the reason down against
 *      Posts.xml (a 97 MB scan, which is why it is not on by default).
 *
 *   2. REPEATED PAIRS AND GRADE CONFLICTS. One judgment per unordered pair,
 *      MAX grade wins.
 *        - Not first- or last-seen: PostLinks.xml is not in Id order (row 1 is
 *          Id=690350, row 3 is Id=457), so an order-dependent rule makes the
 *          answer key a function of arbitrary file order, and an answer key
 *          that cannot be reproduced is not an answer key.
 *        - Not min: the grades are ordinal, and a duplicate closure — which
 *          takes multiple independent close votes — is the stronger signal.
 *        - Not "keep both": emitting the same (qid, docid) at two grades is a
 *          malformed key, not an alternative reading. The document enters the
 *          ideal ranking twice, inflating IDCG and so deflating nDCG, and
 *          trec_eval's behaviour on a repeated qid/docid is
 *          implementation-defined. The report prints that count explicitly, as
 *          `judgments if pair+grade not collapsed`, because an earlier pass over
 *          this dump recorded it (18,284) as the judgment count.
 *
 *   3. SELF-LINKS. Dropped unconditionally. A self-judgment plants the
 *      self-retrieval trap in the ground truth itself, where excluding the query
 *      id from its own results no longer saves you — the key would reward
 *      returning the query. Zero in the cooking dump; the guard stays because a
 *      future dump may differ.
 *
 *   4. SYMMETRISATION. Each surviving pair emits both directions at one grade,
 *      so the two directions cannot disagree by construction. "Duplicate" is
 *      directional in Stack Exchange semantics — the new question is closed as a
 *      duplicate OF the old one — but for retrieval, looking at the old
 *      question, the new one is still a relevant result.
 *
 * Output lines are sorted by (qid, docid) numerically, so the SHA-256 is a
 * property of the judgments and not of PostLinks.xml row order.
 *
 * Zero runtime dependencies, for the same reason build-corpus.js has none: a
 * library version bump must not be able to shift the bytes Phase 1.6 pins.
 *
 * Usage: npm run qrels:build -- --site cooking [--explain-drops]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

// LinkTypeId -> relevance grade. The Stack Exchange schema documents 1 and 3;
// LinkTypeId 2 is not published in the dumps, so there is nothing to decide
// about it. Anything outside this table is counted and dropped, never guessed.
const LINK_TYPE_GRADE = { 1: 1, 3: 2 };

const ROW_START_RE = /^\s*<row\s/;
const ATTR_RE = /([A-Za-z]+)="([^"]*)"/g;
const NUMERIC_ID_RE = /^[0-9]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { site: 'cooking', explainDrops: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--site' && argv[i + 1]) { args.site = argv[i + 1]; i += 1; }
    else if (argv[i] === '--explain-drops') args.explainDrops = true;
  }
  return args;
}

/**
 * `"` inside an XML attribute value must be escaped as `&quot;`, so `[^"]*` can
 * neither under- nor over-run a value. Same reasoning as build-corpus.js.
 */
function parseAttributes(line) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1]] = m[2];
  return attrs;
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

/**
 * Read a file line by line in 1 MiB chunks, hashing the raw bytes as it goes.
 * The BOM is stripped from the head of the stream — PostLinks.xml carries one —
 * and a multi-byte character split across a chunk boundary is handled by the
 * streaming TextDecoder.
 */
async function forEachLine(file, onLine) {
  const hash = crypto.createHash('sha256');
  const decoder = new TextDecoder('utf-8');
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let carry = '';
  let first = true;
  for await (const chunk of stream) {
    hash.update(chunk);
    let text = decoder.decode(chunk, { stream: true });
    if (first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    const parts = (carry + text).split('\n');
    carry = parts.pop();
    for (const line of parts) onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
  carry += decoder.decode();
  if (carry.trim() !== '') onLine(carry.endsWith('\r') ? carry.slice(0, -1) : carry);
  return hash.digest('hex');
}

// Nearest-rank percentile over an ascending array: the ceil(p/100 * n)-th value.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = process.hrtime.bigint();
  const { site, explainDrops } = parseArgs(process.argv.slice(2));

  // Resolved from this file, not process.cwd(), so a container with ./data
  // mounted works regardless of the working directory.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const linksPath = path.join(repoRoot, 'data', 'raw', site, 'PostLinks.xml');
  const postsPath = path.join(repoRoot, 'data', 'raw', site, 'Posts.xml');
  const corpusPath = path.join(repoRoot, 'data', 'corpus', `${site}.jsonl`);
  const outDir = path.join(repoRoot, 'data', 'qrels');
  const outPath = path.join(outDir, `${site}.qrels`);
  const tmpPath = path.join(outDir, `${site}.qrels.tmp`);
  const manifestPath = path.join(outDir, `${site}.manifest.json`);

  for (const [label, file] of [['PostLinks', linksPath], ['corpus', corpusPath]]) {
    if (!fs.existsSync(file)) {
      console.error(`build-qrels: missing ${label} input ${file}`);
      if (label === 'corpus') {
        console.error('  run: npm run corpus:build -- --site ' + site);
      }
      process.exit(1);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  // --- corpus id set: the only membership test that matters ---------------
  const corpusIds = new Set();
  let corpusNonNumeric = 0;
  const corpusSha = await forEachLine(corpusPath, (line) => {
    if (line === '') return;
    const id = JSON.parse(line).id;
    if (!NUMERIC_ID_RE.test(id)) corpusNonNumeric += 1;
    corpusIds.add(id);
  });

  // Numeric ids are load-bearing twice over: the canonical pair key orders its
  // two endpoints numerically, and the output is sorted numerically. A
  // non-numeric id would sort as a string and silently reorder the file.
  if (corpusNonNumeric > 0) {
    console.error(`build-qrels: ${corpusNonNumeric} corpus ids are not numeric — canonical ordering assumes they are`);
    process.exit(1);
  }

  // --- classify every PostLinks row ---------------------------------------
  const stats = {
    linesTotal: 0,
    rowsTotal: 0,
    nonRowLines: 0,
    byLinkType: new Map(),
    missingAttributes: 0,
    unknownLinkType: 0,
    selfLinks: 0,
    droppedOutsideCorpus: 0,
    droppedPostIdOutside: 0,
    droppedRelatedIdOutside: 0,
    droppedByLinkType: new Map(),
    surviving: 0,
  };
  const outsideIds = new Set();

  // Unordered pair -> max grade. This single map is where decisions 2 and 4 are
  // both applied, which is why they cannot drift apart.
  const pairGrade = new Map();
  // Rows per pair, for the repeat / conflict statistics and for the
  // reconciliation counter.
  const pairRows = new Map();

  const pairKey = (a, b) => (Number(a) < Number(b) ? `${a}|${b}` : `${b}|${a}`);

  const linksSha = await forEachLine(linksPath, (line) => {
    stats.linesTotal += 1;
    if (!ROW_START_RE.test(line)) {
      if (line.trim() !== '') stats.nonRowLines += 1;
      return;
    }
    stats.rowsTotal += 1;

    const a = parseAttributes(line);
    const post = a.PostId;
    const related = a.RelatedPostId;
    const type = a.LinkTypeId;

    if (post === undefined || related === undefined || type === undefined) {
      stats.missingAttributes += 1;
      return;
    }
    stats.byLinkType.set(type, (stats.byLinkType.get(type) || 0) + 1);

    if (!(type in LINK_TYPE_GRADE)) { stats.unknownLinkType += 1; return; }

    // Decision 3 — self-links.
    if (post === related) { stats.selfLinks += 1; return; }

    // Decision 1 — out of corpus.
    const postIn = corpusIds.has(post);
    const relatedIn = corpusIds.has(related);
    if (!postIn || !relatedIn) {
      stats.droppedOutsideCorpus += 1;
      if (!postIn) { stats.droppedPostIdOutside += 1; outsideIds.add(post); }
      if (!relatedIn) { stats.droppedRelatedIdOutside += 1; outsideIds.add(related); }
      stats.droppedByLinkType.set(type, (stats.droppedByLinkType.get(type) || 0) + 1);
      return;
    }

    stats.surviving += 1;
    const grade = LINK_TYPE_GRADE[type];
    const key = pairKey(post, related);

    // Decision 2 — max grade wins, one judgment per unordered pair.
    const prev = pairGrade.get(key);
    pairGrade.set(key, prev === undefined ? grade : Math.max(prev, grade));

    if (!pairRows.has(key)) pairRows.set(key, []);
    pairRows.get(key).push({ post, related, grade });
  });

  // --- pair-level statistics ----------------------------------------------
  let pairsWithRepeats = 0;
  let pairsSameGradeRepeat = 0;
  let pairsGradeConflict = 0;
  let pairsConflictSameDirection = 0;
  let pairsConflictOppositeDirection = 0;
  let pairsBothDirections = 0;
  const pairGradeKeys = new Set(); // decision-2 reconciliation: (pair, grade)

  for (const [key, rows] of pairRows) {
    for (const r of rows) pairGradeKeys.add(`${key}|${r.grade}`);
    if (rows.length === 1) continue;
    pairsWithRepeats += 1;
    const grades = new Set(rows.map((r) => r.grade));
    const directions = new Set(rows.map((r) => `${r.post}>${r.related}`));
    if (directions.size > 1) pairsBothDirections += 1;
    if (grades.size > 1) {
      pairsGradeConflict += 1;
      if (directions.size === 1) pairsConflictSameDirection += 1;
      else pairsConflictOppositeDirection += 1;
    } else {
      pairsSameGradeRepeat += 1;
    }
  }

  // --- decision 4 — symmetrise, then sort ---------------------------------
  const judgments = [];
  for (const [key, grade] of pairGrade) {
    const sep = key.indexOf('|');
    const a = key.slice(0, sep);
    const b = key.slice(sep + 1);
    judgments.push([a, b, grade], [b, a, grade]);
  }
  // Numeric sort on both fields. Independent of PostLinks row order and of Map
  // iteration order — this is what makes the output SHA-256 meaningful.
  judgments.sort((x, y) => (Number(x[0]) - Number(y[0])) || (Number(x[1]) - Number(y[1])));

  // --- per-query distribution and grade counts ----------------------------
  const perQuery = new Map();
  let grade2 = 0;
  let grade1 = 0;
  for (const [qid, , grade] of judgments) {
    perQuery.set(qid, (perQuery.get(qid) || 0) + 1);
    if (grade === 2) grade2 += 1; else grade1 += 1;
  }
  const counts = [...perQuery.values()].sort((a, b) => a - b);
  const J = judgments.length;
  const Q = perQuery.size;

  // --- guards, before anything is written ---------------------------------
  const failures = [];
  const seenLines = new Set();
  const gradeByDirected = new Map();
  for (const [qid, docid, grade] of judgments) {
    const k = `${qid}|${docid}`;
    if (seenLines.has(k)) failures.push(`Q4 duplicate judgment ${qid} ${docid}`);
    seenLines.add(k);
    gradeByDirected.set(k, grade);
    if (qid === docid) failures.push(`Q2 self-judgment ${qid}`);
    if (!corpusIds.has(qid) || !corpusIds.has(docid)) {
      failures.push(`Q1 judgment outside corpus ${qid} ${docid}`);
    }
    if (grade !== 1 && grade !== 2) failures.push(`Q5 bad grade ${grade} on ${qid} ${docid}`);
    if (failures.length > 5) break;
  }
  // Q3 — exact symmetry. Checked against the emitted lines rather than trusted
  // from the construction above, because "symmetric by construction" is exactly
  // the kind of claim that survives a refactor after it stops being true.
  if (failures.length <= 5) {
    for (const [qid, docid, grade] of judgments) {
      const mirror = gradeByDirected.get(`${docid}|${qid}`);
      if (mirror === undefined) { failures.push(`Q3 missing mirror for ${qid} ${docid}`); break; }
      if (mirror !== grade) { failures.push(`Q3 grade disagreement ${qid} ${docid}: ${grade} vs ${mirror}`); break; }
    }
  }

  if (failures.length) {
    console.error('build-qrels FAILED — no file written:');
    for (const f of failures.slice(0, 6)) console.error(`  - ${f}`);
    process.exit(1);
  }

  // --- optional drop-reason breakdown against Posts.xml -------------------
  let dropReasons = null;
  if (explainDrops) {
    if (!fs.existsSync(postsPath)) {
      console.error(`build-qrels: --explain-drops needs ${postsPath}`);
      process.exit(1);
    }
    const postType = new Map();
    await forEachLine(postsPath, (line) => {
      if (!ROW_START_RE.test(line)) return;
      const id = /\sId="([^"]*)"/.exec(line);
      if (!id || !outsideIds.has(id[1])) return;
      const ty = /\sPostTypeId="([^"]*)"/.exec(line);
      postType.set(id[1], ty ? ty[1] : 'unknown');
    });
    dropReasons = { answer: 0, otherPostType: 0, absent: 0, byType: {} };
    for (const id of outsideIds) {
      if (!postType.has(id)) { dropReasons.absent += 1; continue; }
      const t = postType.get(id);
      dropReasons.byType[t] = (dropReasons.byType[t] || 0) + 1;
      if (t === '2') dropReasons.answer += 1; else dropReasons.otherPostType += 1;
    }
  }

  // --- write ---------------------------------------------------------------
  const out = fs.createWriteStream(tmpPath, { flags: 'w' });
  const write = async (chunk) => { if (!out.write(chunk)) await once(out, 'drain'); };
  // TREC qrels: `qid 0 docid grade`. The 0 is the vestigial iteration field.
  // No header and no comments — pytrec_eval reads this file directly, and
  // metadata belongs in the manifest, not in the format.
  let buf = '';
  for (const [qid, docid, grade] of judgments) {
    buf += `${qid} 0 ${docid} ${grade}\n`;
    if (buf.length > (1 << 20)) { await write(buf); buf = ''; }
  }
  if (buf) await write(buf);
  out.end();
  await once(out, 'finish');

  const fd = fs.openSync(tmpPath, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, outPath);

  const outputSha = await sha256File(outPath);
  const outputBytes = fs.statSync(outPath).size;

  // Manifest carries content only — no timestamp, no Node version — so it is
  // byte-stable wherever the qrels are, and Phase 1.6 can diff it directly.
  const manifest = {
    site,
    format: 'TREC qrels: qid 0 docid grade',
    grades: {
      1: 'PostLinks LinkTypeId=1 (Linked)',
      2: 'PostLinks LinkTypeId=3 (Duplicate)',
    },
    rules: {
      outOfCorpus: 'both endpoints must be present in the built corpus',
      repeatedPairs: 'one judgment per unordered pair, max grade wins',
      selfLinks: 'dropped',
      symmetrisation: 'canonicalise -> resolve grade -> symmetrise',
    },
    source: {
      postLinks: {
        file: `data/raw/${site}/PostLinks.xml`,
        bytes: fs.statSync(linksPath).size,
        sha256: linksSha,
        rows: stats.rowsTotal,
      },
      corpus: {
        file: `data/corpus/${site}.jsonl`,
        bytes: fs.statSync(corpusPath).size,
        sha256: corpusSha,
        documents: corpusIds.size,
      },
    },
    rows: {
      total: stats.rowsTotal,
      byLinkType: Object.fromEntries([...stats.byLinkType].sort()),
      missingAttributes: stats.missingAttributes,
      unknownLinkType: stats.unknownLinkType,
      selfLinks: stats.selfLinks,
      droppedOutsideCorpus: stats.droppedOutsideCorpus,
      droppedByLinkType: Object.fromEntries([...stats.droppedByLinkType].sort()),
      surviving: stats.surviving,
    },
    pairs: {
      distinct: pairGrade.size,
      withRepeatedRows: pairsWithRepeats,
      sameGradeRepeat: pairsSameGradeRepeat,
      gradeConflict: pairsGradeConflict,
      gradeConflictSameDirection: pairsConflictSameDirection,
      gradeConflictOppositeDirection: pairsConflictOppositeDirection,
      bothDirectionsPresent: pairsBothDirections,
    },
    output: {
      file: `data/qrels/${site}.qrels`,
      bytes: outputBytes,
      sha256: outputSha,
      judgments: J,
      queries: Q,
      grade2,
      grade1,
    },
    distribution: {
      mean: Number((J / Q).toFixed(4)),
      median: median(counts),
      p90: percentile(counts, 90),
      p95: percentile(counts, 95),
      p99: percentile(counts, 99),
      max: counts[counts.length - 1],
    },
    reconciliation: {
      note: 'judgmentsIfPairGradeNotCollapsed is the malformed variant: it keeps a pair that is both Linked and Duplicate as two judgments at two grades',
      pairGradeKeys: pairGradeKeys.size,
      judgmentsIfPairGradeNotCollapsed: pairGradeKeys.size * 2,
      judgmentsIfNoDedup: stats.surviving * 2,
    },
  };
  if (dropReasons) manifest.rows.dropReasons = dropReasons;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const usage = process.resourceUsage();
  const n = (x) => x.toLocaleString('en-US');

  console.log('');
  console.log(`qrels:build — site=${site}`);
  console.log('');
  console.log('  input');
  console.log(`    PostLinks               data/raw/${site}/PostLinks.xml`);
  console.log(`    sha256                  ${linksSha}`);
  console.log(`    <row> elements          ${n(stats.rowsTotal)}`);
  console.log(`    by LinkTypeId           ${[...stats.byLinkType].sort().map(([k, v]) => `${k}=${n(v)}`).join('  ')}`);
  console.log(`    corpus                  data/corpus/${site}.jsonl (${n(corpusIds.size)} docs)`);
  console.log(`    corpus sha256           ${corpusSha}`);
  console.log('');
  console.log('  rows dropped');
  console.log(`    missing attributes      ${stats.missingAttributes}`);
  console.log(`    unknown LinkTypeId      ${stats.unknownLinkType}`);
  console.log(`    self-links              ${stats.selfLinks}`);
  console.log(`    endpoint outside corpus ${stats.droppedOutsideCorpus}   (PostId ${stats.droppedPostIdOutside}, RelatedPostId ${stats.droppedRelatedIdOutside}; ${outsideIds.size} distinct ids)`);
  console.log(`      by LinkTypeId         ${[...stats.droppedByLinkType].sort().map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}`);
  if (dropReasons) {
    console.log(`      ...is an answer       ${dropReasons.answer} ids`);
    console.log(`      ...other PostTypeId   ${dropReasons.otherPostType} ids  ${JSON.stringify(dropReasons.byType)}`);
    console.log(`      ...absent from Posts  ${dropReasons.absent} ids`);
  } else {
    console.log('      (rerun with --explain-drops to classify these against Posts.xml)');
  }
  console.log(`    surviving rows          ${n(stats.surviving)}`);
  console.log('');
  console.log('  pair resolution');
  console.log(`    distinct pairs          ${n(pairGrade.size)}`);
  console.log(`    pairs w/ repeated rows  ${pairsWithRepeats}`);
  console.log(`      same grade            ${pairsSameGradeRepeat}`);
  console.log(`      conflicting grades    ${pairsGradeConflict}   (same direction ${pairsConflictSameDirection}, opposite ${pairsConflictOppositeDirection})`);
  console.log(`      both directions       ${pairsBothDirections}`);
  console.log('');
  console.log('  output');
  console.log(`    file                    data/qrels/${site}.qrels`);
  console.log(`    judgments  J            ${n(J)}`);
  console.log(`    queries    Q            ${n(Q)}`);
  console.log(`    grade 2 (duplicate)     ${n(grade2)}  (${((grade2 / J) * 100).toFixed(1)}%)`);
  console.log(`    grade 1 (linked)        ${n(grade1)}  (${((grade1 / J) * 100).toFixed(1)}%)`);
  console.log(`    bytes                   ${n(outputBytes)}`);
  console.log(`    sha256                  ${outputSha}`);
  console.log('');
  console.log('  judgments per query');
  console.log(`    mean                    ${(J / Q).toFixed(4)}`);
  console.log(`    median                  ${median(counts)}`);
  console.log(`    p90 / p95 / p99         ${percentile(counts, 90)} / ${percentile(counts, 95)} / ${percentile(counts, 99)}`);
  console.log(`    max                     ${counts[counts.length - 1]}`);
  console.log('');
  console.log('  reconciliation — variants that are NOT the deliverable');
  console.log(`    no dedup at all         ${n(stats.surviving * 2)}`);
  console.log(`    (pair, grade) kept      ${n(pairGradeKeys.size * 2)}   <- malformed: same (qid,docid) at two grades`);
  console.log(`    THIS FILE               ${n(J)}`);
  console.log('');
  console.log('  guards');
  console.log('    Q1 all ids in corpus    pass');
  console.log('    Q2 no self-judgment     pass');
  console.log('    Q3 exact symmetry       pass');
  console.log('    Q4 no duplicate line    pass');
  console.log('    Q5 grades in {1,2}      pass');
  console.log('');
  console.log('  run');
  console.log(`    wall time               ${wallMs.toFixed(0)} ms`);
  console.log(`    peak RSS (maxRSS)       ${n(usage.maxRSS)} (resourceUsage units)`);
  console.log(`    node                    ${process.version} ${process.platform}/${process.arch}`);
  console.log('');

  if (stats.nonRowLines > 3) {
    console.error(`build-qrels FAILED: ${stats.nonRowLines} unexpected non-row lines`);
    process.exit(1);
  }
  if (J === 0) {
    console.error('build-qrels FAILED: no judgments emitted');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('build-qrels: fatal —', err && err.stack ? err.stack : err);
  process.exit(1);
});
