#!/usr/bin/env node
'use strict';

/**
 * analyze-ground-truth.js — Phase 1.5
 *
 * Measures the three biases documented in docs/EVALUATION.md §5:
 * incompleteness, linking behaviour, and time.
 *
 * READ-ONLY BY DESIGN. This script writes nothing, and in particular it does
 * not touch data/qrels/. The qrels SHA-256 is a published reproducibility
 * anchor, so the numbers for §5 are produced by a separate reader rather than
 * by extending build-qrels.js — a script that only reads cannot invalidate the
 * artifact it is describing.
 *
 * It reads PostLinks.xml directly for one field build-qrels.js discards:
 * `CreationDate` on the link row. Without it the temporal section can only say
 * "older posts hold more judgments", which has an obvious and wrong
 * explanation (recent posts have not had time). With it, that explanation is
 * measurably refuted — see the LAG section — and the real mechanism, that
 * links point backwards in time, can be measured instead.
 *
 * Zero runtime dependencies, matching build-corpus.js and build-qrels.js.
 *
 *   cd backend && npm run bias:analyze -- --site cooking
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Same attribute pattern as build-corpus.js / build-qrels.js. Exact for this
// format because `"` inside an XML attribute value must be escaped as &quot;.
const ATTR_RE = /([A-Za-z]+)="([^"]*)"/g;

const MS_PER_DAY = 86400000;

function parseArgs(argv) {
  const args = { site: 'cooking', hubs: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--site' && argv[i + 1]) { args.site = argv[i + 1]; i += 1; }
    else if (argv[i] === '--hubs' && argv[i + 1]) { args.hubs = Number(argv[i + 1]); i += 1; }
  }
  return args;
}

function parseAttrs(line) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

/**
 * Post and link timestamps are both stored without a timezone (see §2 on why no
 * `Z` is appended to the corpus field). Both come from the same dump under the
 * same unstated convention, so parsing both as UTC makes every *difference*
 * below correct regardless of what that convention actually is — the offset
 * cancels in the subtraction. Only an absolute wall-clock claim would need it
 * resolved, and this script makes none.
 */
function parseDumpDate(s) {
  return Date.parse(`${s}Z`);
}

// --- small statistics helpers ---------------------------------------------

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// Nearest-rank, matching the convention build-qrels.js uses for §3.3.
function percentile(values, p) {
  const s = values.slice().sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i];
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Ranks with ties averaged, so Spearman is correct on the heavily tied
// distributions here (most documents have degree 0 and most scores are small).
function rankAverage(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function spearman(xs, ys) {
  const rx = rankAverage(xs);
  const ry = rankAverage(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// Gini over a non-negative distribution. 0 = every document equal, 1 = one
// document holds everything.
function gini(values) {
  const s = values.slice().sort((a, b) => a - b);
  const n = s.length;
  const m = mean(s);
  if (n === 0 || m === 0) return NaN;
  let num = 0;
  for (let i = 0; i < n; i += 1) num += (2 * (i + 1) - n - 1) * s[i];
  return num / (n * n * m);
}

function decile(sorted, k) {
  const lo = Math.floor(k * sorted.length / 10);
  const hi = Math.floor((k + 1) * sorted.length / 10);
  return sorted.slice(lo, hi);
}

function pad(v, n) { return String(v).padStart(n); }
function fixed(v, d, n) { return Number(v).toFixed(d).padStart(n); }

// --- readers ---------------------------------------------------------------

async function readCorpus(file) {
  const docs = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line) continue;
    const d = JSON.parse(line);
    docs.set(d.id, { title: d.title, score: d.score, t: parseDumpDate(d.creationDate), year: d.creationDate.slice(0, 4) });
  }
  return docs;
}

async function readQrels(file) {
  // Judgments are symmetric (§3.2), so a document's line count as `qid` is its
  // full degree in the judgment graph.
  const degree = new Map();
  const byGrade = new Map();
  let lines = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;
    const [qid, , , grade] = line.trim().split(/\s+/);
    degree.set(qid, (degree.get(qid) || 0) + 1);
    if (!byGrade.has(qid)) byGrade.set(qid, { g1: 0, g2: 0 });
    byGrade.get(qid)[grade === '2' ? 'g2' : 'g1'] += 1;
  }
  return { degree, byGrade, lines };
}

async function readPostLinks(file, docs) {
  const rows = [];
  let total = 0;
  let outsideCorpus = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!/^\s*<row\s/.test(line)) continue;
    total += 1;
    const a = parseAttrs(line);
    const src = docs.get(a.PostId);
    const tgt = docs.get(a.RelatedPostId);
    if (!src || !tgt) { outsideCorpus += 1; continue; }
    rows.push({
      postId: a.PostId,
      relatedPostId: a.RelatedPostId,
      linkType: a.LinkTypeId,
      linkT: parseDumpDate(a.CreationDate),
      srcT: src.t,
      tgtT: tgt.t,
      srcScore: src.score,
      tgtScore: tgt.score
    });
  }
  return { rows, total, outsideCorpus };
}

// --- sections --------------------------------------------------------------

function sectionIncompleteness(docs, degree, qrelsLines) {
  console.log('\n=== 1. INCOMPLETENESS ===');
  let judged = 0;
  for (const id of docs.keys()) if (degree.has(id)) judged += 1;
  const unjudged = docs.size - judged;
  console.log(`corpus documents          ${pad(docs.size, 7)}`);
  console.log(`judgments                 ${pad(qrelsLines, 7)}`);
  console.log(`judged documents          ${pad(judged, 7)}`);
  console.log(`unjudged documents        ${pad(unjudged, 7)}   ${fixed(unjudged / docs.size * 100, 1, 5)}% of the corpus`);
  console.log('every judgment is positive; PostLinks records no non-relevant rows');
  return { judged, unjudged };
}

function sectionHubs(docs, degree, n) {
  console.log('\n=== 2. LINKING BEHAVIOUR ===');
  const ranked = [...degree.entries()]
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  const total = ranked.reduce((s, r) => s + r[1], 0);

  console.log(`\n-- the ${n} largest hubs --`);
  for (const [id, d] of ranked.slice(0, n)) {
    const title = (docs.get(id) || {}).title || '(not in corpus)';
    console.log(`${pad(d, 4)}  ${pad(id, 6)}  ${title.slice(0, 76)}`);
  }

  console.log('\n-- concentration --');
  for (const frac of [0.001, 0.01, 0.05, 0.1, 0.25, 0.5]) {
    const k = Math.max(1, Math.round(ranked.length * frac));
    let s = 0;
    for (let i = 0; i < k; i += 1) s += ranked[i][1];
    console.log(`top ${fixed(frac * 100, 1, 5)}% of judged docs (${pad(k, 5)})  hold ${pad(s, 6)} judgments  ${fixed(s / total * 100, 1, 5)}%`);
  }
  const allDegrees = [...docs.keys()].map((id) => degree.get(id) || 0);
  console.log(`Gini, judged documents only   ${fixed(gini(ranked.map((r) => r[1])), 4, 7)}`);
  console.log(`Gini, whole corpus            ${fixed(gini(allDegrees), 4, 7)}`);
  return { ranked, total };
}

function sectionScore(docs, degree, byGrade, links) {
  console.log('\n-- score against judged degree --');
  const all = [...docs.entries()].map(([id, d]) => ({ id, score: d.score, deg: degree.get(id) || 0 }));
  const judged = all.filter((a) => a.deg > 0);
  const unjudged = all.filter((a) => a.deg === 0);
  console.log(`judged    n=${pad(judged.length, 5)}  mean score ${fixed(mean(judged.map((a) => a.score)), 2, 6)}  median ${pad(median(judged.map((a) => a.score)), 4)}`);
  console.log(`unjudged  n=${pad(unjudged.length, 5)}  mean score ${fixed(mean(unjudged.map((a) => a.score)), 2, 6)}  median ${pad(median(unjudged.map((a) => a.score)), 4)}`);
  console.log(`Spearman rho(score, degree) over all ${all.length} documents = ${fixed(spearman(all.map((a) => a.score), all.map((a) => a.deg)), 4, 7)}`);

  // The aggregate correlation is weak because it averages two mechanisms that
  // pull in opposite directions. Split by the grade a document carries.
  console.log('\n-- the two mechanisms, separated by grade --');
  const groups = { 'grade 1 only': [], 'grade 2 only': [], 'both grades': [], 'unjudged': [] };
  for (const [id, d] of docs) {
    const g = byGrade.get(id);
    const key = !g ? 'unjudged' : g.g2 === 0 ? 'grade 1 only' : g.g1 === 0 ? 'grade 2 only' : 'both grades';
    groups[key].push(d.score);
  }
  for (const [key, scores] of Object.entries(groups)) {
    console.log(`${key.padEnd(13)} n=${pad(scores.length, 5)}  mean score ${fixed(mean(scores), 2, 6)}  median ${pad(median(scores), 4)}`);
  }

  // Sharper still: it is the ROLE in a link, not the document, that carries the
  // score effect. PostId is the question doing the linking (or being closed);
  // RelatedPostId is the question being pointed at.
  console.log('\n-- score by role in the link --');
  for (const [label, type] of [['Linked    (1)', '1'], ['Duplicate (3)', '3']]) {
    const rs = links.filter((r) => r.linkType === type);
    const src = rs.map((r) => r.srcScore);
    const tgt = rs.map((r) => r.tgtScore);
    console.log(`${label}  n=${pad(rs.length, 5)}`);
    console.log(`                 PostId        (links / is closed)  mean ${fixed(mean(src), 2, 6)}  median ${pad(median(src), 4)}`);
    console.log(`                 RelatedPostId (is pointed at)      mean ${fixed(mean(tgt), 2, 6)}  median ${pad(median(tgt), 4)}`);
  }
}

function sectionTemporal(docs, degree, links, totalRows, outsideCorpus) {
  console.log('\n=== 3. TIME ===');

  console.log('\n-- judgments by year the question was asked --');
  const byYear = new Map();
  for (const [id, d] of docs) {
    if (!byYear.has(d.year)) byYear.set(d.year, { n: 0, deg: 0, judged: 0 });
    const b = byYear.get(d.year);
    const deg = degree.get(id) || 0;
    b.n += 1; b.deg += deg; if (deg > 0) b.judged += 1;
  }
  console.log('year    docs  judgments   mean deg   % judged');
  for (const y of [...byYear.keys()].sort()) {
    const b = byYear.get(y);
    console.log(`${y}  ${pad(b.n, 6)}  ${pad(b.deg, 9)}   ${fixed(b.deg / b.n, 3, 8)}   ${fixed(b.judged / b.n * 100, 1, 8)}%`);
  }
  const allDocs = [...docs.entries()];
  console.log(`Spearman rho(creationDate, degree) = ${fixed(spearman(allDocs.map(([, d]) => d.t), allDocs.map(([id]) => degree.get(id) || 0)), 4, 7)}`);

  // The obvious explanation for that decline is right-censoring: recent posts
  // have not had time to accumulate links. This is where it gets tested.
  console.log('\n-- lag: link creation minus the LATER endpoint\'s post date --');
  console.log(`PostLinks rows ${totalRows}, of which ${links.length} have both endpoints in the corpus (${outsideCorpus} dropped)`);
  const lagOf = (r) => (r.linkT - Math.max(r.srcT, r.tgtT)) / MS_PER_DAY;
  const report = (label, rs) => {
    const lags = rs.map(lagOf);
    console.log(`${label.padEnd(14)} n=${pad(lags.length, 5)}  p25 ${fixed(percentile(lags, 0.25), 1, 7)}  median ${fixed(percentile(lags, 0.5), 1, 7)}  p75 ${fixed(percentile(lags, 0.75), 1, 7)}  p90 ${fixed(percentile(lags, 0.9), 1, 8)}  p99 ${fixed(percentile(lags, 0.99), 1, 8)}  max ${fixed(percentile(lags, 1), 0, 6)}`);
  };
  report('all links', links);
  report('Linked (1)', links.filter((r) => r.linkType === '1'));
  report('Duplicate (3)', links.filter((r) => r.linkType === '3'));

  console.log('\ncumulative share of links, by age of the pair when linked:');
  for (const d of [1, 7, 30, 90, 365, 730]) {
    const n = links.filter((r) => lagOf(r) <= d).length;
    console.log(`  within ${pad(d, 4)} days   ${pad(n, 5)}   ${fixed(n / links.length * 100, 1, 5)}%`);
  }

  const negatives = links.filter((r) => lagOf(r) < 0);
  if (negatives.length) {
    const worstSeconds = Math.max(...negatives.map((r) => -lagOf(r) * MS_PER_DAY / 1000));
    console.log(`\nlinks timestamped before the later post: ${negatives.length} of ${links.length} (${fixed(negatives.length / links.length * 100, 2, 4)}%), worst by ${worstSeconds.toFixed(1)}s — sub-second clock skew, not a data defect`);
  }

  // How much of the corpus could plausibly be censored at the dump boundary.
  const cutoff = Math.max(...[...docs.values()].map((d) => d.t));
  console.log('\n-- exposure to censoring at the dump boundary --');
  console.log(`latest question in corpus  ${new Date(cutoff).toISOString().slice(0, 19)}`);
  console.log(`latest link in PostLinks   ${new Date(Math.max(...links.map((r) => r.linkT))).toISOString().slice(0, 19)}`);
  for (const w of [365, 730]) {
    const n = [...docs.values()].filter((d) => (cutoff - d.t) / MS_PER_DAY < w).length;
    console.log(`documents younger than ${pad(w, 4)} days   ${pad(n, 5)}   ${fixed(n / docs.size * 100, 1, 5)}% of the corpus`);
  }

  // If censoring is not the mechanism, this is: links point backwards, so a
  // document's degree depends on how much corpus came after it.
  console.log('\n-- direction: does a link point at the older question? --');
  for (const [label, sel] of [['all', () => true], ['Linked    (1)', (r) => r.linkType === '1'], ['Duplicate (3)', (r) => r.linkType === '3']]) {
    const rs = links.filter(sel);
    const older = rs.filter((r) => r.tgtT < r.srcT).length;
    console.log(`${label.padEnd(14)} n=${pad(rs.length, 5)}  target is older ${pad(older, 5)}  ${fixed(older / rs.length * 100, 1, 5)}%   target is newer ${pad(rs.length - older, 5)}`);
  }

  console.log('\n-- degree against how much corpus was created afterwards --');
  const times = [...docs.values()].map((d) => d.t).sort((a, b) => a - b);
  const createdAfter = (t) => {
    let lo = 0; let hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    return times.length - lo;
  };
  const rows = [...docs.entries()]
    .map(([id, d]) => ({ after: createdAfter(d.t), deg: degree.get(id) || 0 }))
    .sort((a, b) => a.after - b.after);
  console.log('decile of "documents created after this one"   mean degree   % judged');
  for (let k = 0; k < 10; k += 1) {
    const seg = decile(rows, k);
    const judged = seg.filter((r) => r.deg > 0).length;
    console.log(`  D${pad(k + 1, 2)}  ${pad(seg[0].after, 5)}..${pad(seg[seg.length - 1].after, 5)}                       ${fixed(mean(seg.map((r) => r.deg)), 3, 8)}    ${fixed(judged / seg.length * 100, 1, 6)}%`);
  }
  console.log(`Spearman rho(documents created after, degree) = ${fixed(spearman(rows.map((r) => r.after), rows.map((r) => r.deg)), 4, 7)}`);
}

// --- main ------------------------------------------------------------------

async function main() {
  const t0 = process.hrtime.bigint();
  const { site, hubs } = parseArgs(process.argv.slice(2));

  // Resolved from this file rather than process.cwd(), matching the other
  // build scripts, so the working directory does not matter.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const corpusPath = path.join(repoRoot, 'data', 'corpus', `${site}.jsonl`);
  const qrelsPath = path.join(repoRoot, 'data', 'qrels', `${site}.qrels`);
  const linksPath = path.join(repoRoot, 'data', 'raw', site, 'PostLinks.xml');

  for (const p of [corpusPath, qrelsPath, linksPath]) {
    if (!fs.existsSync(p)) {
      console.error(`analyze-ground-truth: missing input ${p}`);
      process.exit(1);
    }
  }

  console.log(`analyze-ground-truth — site "${site}"`);
  console.log(`corpus     ${path.relative(repoRoot, corpusPath)}`);
  console.log(`qrels      ${path.relative(repoRoot, qrelsPath)}`);
  console.log(`postlinks  ${path.relative(repoRoot, linksPath)}`);
  console.log('read-only: this script writes nothing');

  const docs = await readCorpus(corpusPath);
  const { degree, byGrade, lines } = await readQrels(qrelsPath);
  const { rows, total, outsideCorpus } = await readPostLinks(linksPath, docs);

  sectionIncompleteness(docs, degree, lines);
  sectionHubs(docs, degree, hubs);
  sectionScore(docs, degree, byGrade, rows);
  sectionTemporal(docs, degree, rows, total, outsideCorpus);

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const maxRssKb = process.resourceUsage().maxRSS;
  console.log(`\ndone in ${ms.toFixed(0)} ms, peak RSS ${(maxRssKb / 1024).toFixed(1)} MiB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
