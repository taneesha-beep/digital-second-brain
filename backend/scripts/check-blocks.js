#!/usr/bin/env node
'use strict';

/**
 * check-blocks.js — Phase 3.7
 *
 *   cd backend && npm run check:blocks
 *   cd backend && npm run check:blocks -- --verbose
 *
 * THE PROBLEM, WHICH HAS NOW HAPPENED THREE TIMES. `check:claims` verifies that
 * every decimal in a writeup traces to an artifact. Nothing verifies that the
 * NON-NUMERIC content of a writeup still describes the repository:
 *
 *   3.4  shipped a function-signature block that no longer matched the function
 *   3.5  shipped a directory listing naming files that had moved
 *   3.6  found the status line at the top of EVALUATION.md had said
 *        "Phase 3.1 complete" for four sessions
 *
 * Three instances is a pattern and the noticed-list has carried it forward
 * twice. This closes the two thirds of it that are mechanically checkable.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES
 * ---------------------------------------------------------------------------
 *
 *   1. RUNNABLE COMMANDS. Every `npm run <script>` appearing anywhere in a
 *      writeup must exist in backend/package.json or scripts/package.json.
 *      This is the class a reader ACTS on: a command in a document is an
 *      invitation to type it, and one that exits 1 is worse than no command.
 *
 *   2. NAMED PATHS. Every repo-relative path with a file extension, written in
 *      backticks or inside a fenced block, must exist on disk — or be on the
 *      PLANNED list below, which is the honest way to write about a file that
 *      does not exist yet.
 *
 * Rule 2 is the one that catches 3.5's stale directory listing, and it catches
 * it whether the listing is in a fence or in prose, because the failure has
 * nothing to do with fences.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CATCH, STATED SO A PASS IS NOT READ AS MORE THAN IT IS
 * ---------------------------------------------------------------------------
 *
 * IT DOES NOT CATCH 3.4's CASE. A fenced block quoting a function signature,
 * or any code copied verbatim into prose, is not checked at all — there is
 * nothing in the block tying it to a source file, so there is nothing to diff
 * against. Fixing that needs a convention these documents do not have: a source
 * marker on every quoted block, retrofitted across four writeups and ~370,000
 * words. Named here rather than left implicit, because a check that covers two
 * of three instances and is described as covering "stale code blocks" is
 * exactly the kind of half-guarantee that stops people looking.
 *
 * It also does not check that a path is mentioned in a SENSIBLE place, any more
 * than check:claims checks that 0.3269 sits beside the right rung's name. Both
 * tools verify existence, not aptness.
 *
 * Same writeup list as check:claims, deliberately: the two checks should have
 * one domain, so "it passed the checks" means one thing.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Same four documents as check:claims, so "it passed the checks" has one
// domain — but NOT the same verdict rule, and the difference is the point.
//
//   current          the document describes what EXISTS. An unresolved path is
//                    staleness and it FAILS. This is where all three recorded
//                    instances happened.
//   forward-looking  the document describes what the project is FOR. ROADMAP
//                    names deliverables of phases 4 through 8; END-STATE is
//                    entirely a description of a repository that does not exist
//                    yet. An unresolved path there is the document doing its
//                    job, so it is REPORTED and does not fail.
//
// Rule 1 does not make this distinction: a command is checked everywhere,
// because a reader types a command out of any document without asking which
// phase wrote it. Commands that do not exist yet go on PLANNED_SCRIPTS.
const WRITEUPS = [
  { file: 'docs/EVALUATION.md', mode: 'current' },
  { file: 'docs/PRIMER.md', mode: 'current' },
  { file: 'docs/ROADMAP.md', mode: 'forward-looking' },
  { file: 'docs/END-STATE.md', mode: 'forward-looking' }
];

const MANIFESTS = ['backend/package.json', 'scripts/package.json', 'frontend/package.json', 'package.json'];

// Paths a writeup names on purpose while they do not yet exist. Every entry is
// a PLANNED deliverable with the phase that creates it, so the list cannot
// quietly become a junk drawer for typos.
// Paths a writeup names IN ORDER TO SAY THEY ARE WRONG. This is the same
// category check-claims runs into with a document that records its own errors:
// naming the defect is the point, so the reference must not resolve, and a tool
// that cannot tell "stale" from "reported as stale" would force the finding to
// be written vaguely. Each entry names the section doing the reporting.
const QUOTED = new Map([
  ['backend/eval/run-file.js', '§20.8 — the shared loader ROADMAP proposed; it was built as scripts/lib/run-io.js'],
  ['fixtures/mini-corpus.json', '§20.8 — END-STATE\'s planned tree said .json; the fixture is mini-corpus.jsonl']
]);

// Scripts a writeup names for a phase that has not run yet.
const PLANNED_SCRIPTS = new Map([
  ['eval:gen', 'Phase 5.4 — the generation eval harness, ROADMAP 5.4']
]);

const PLANNED = new Map([
  ['docs/FAILURE-MODES.md', 'Phase 7 deliverable, END-STATE §2.12'],
  ['docs/ARCHITECTURE.md', 'Phase 8 deliverable'],
  ['docs/OBSERVABILITY.md', 'Phase 6 deliverable, END-STATE §2.11'],
  ['docs/INTERVIEW-NOTES.md', 'gitignored planning doc, may be absent'],
  ['frontend/src/components/graph/LinkExplainPanel.jsx', 'Phase 7.4 deliverable, END-STATE §2.13'],
  ['frontend/src/components/editor/LinkExplainPanel.jsx', 'Phase 7.4 deliverable, END-STATE §2.13']
]);

// Extensions that make a token a FILE reference rather than prose. Deliberately
// narrow: adding `.md` catches the doc cross-references, and everything here is
// a real extension used in this repo. A wide list would start matching version
// numbers and sentence fragments, which is how a check earns a reputation for
// noise and gets switched off.
const FILE_EXT = /\.(js|jsx|json|md|py|yml|yaml|txt|csv|jsonl|qrels|xml|sh|env|lock|toml|html|css)$/;

// THESE DOCUMENTS WRITE PATHS RELATIVE TO A CONTEXTUAL ROOT, and that is a
// property of how they read rather than sloppiness: §7 discusses
// `retrieval/index.js` while talking about backend/, §8.5 discusses
// `comparisons/registry.json` while talking about results/. Requiring
// repo-relative everywhere would mean editing hundreds of correct references to
// satisfy a tool, which is the tool serving itself.
//
// So a token resolves if it exists under ANY of these. The cost is a weaker
// check — `index.js` alone would resolve against several roots — and that cost
// is bounded by requiring a slash in the token, so a bare filename is never
// checked at all.
const ROOTS = ['', 'backend', 'results', 'frontend', 'frontend/src', 'scripts', 'data'];

// Placeholder syntax. `data/corpus/<site>.jsonl` and
// `data/splits/cooking.{train,dev,test}.txt` are templates describing a family
// of files; neither is a path and neither should be looked up.
const PLACEHOLDER = /[<>{}*]/;

// EVERYTHING UNDER data/ IS GITIGNORED BY DESIGN — the corpus, the qrels, the
// splits, the raw dumps and the vectors are all absent from a fresh clone and
// are pinned by SHA-256 in a manifest instead (.gitignore, §8.5). So resolving
// a data/ path against THIS working tree would make the check pass or fail on
// which dumps happen to be downloaded, which is a property of the machine and
// not of the document. Reported, never failed.
const UNTRACKED_BY_DESIGN = /^data\//;

function fail(message) {
  const err = new Error(message);
  err.assertion = true;
  throw err;
}

function parseArgs(argv) {
  const args = { verbose: false };
  for (const flag of argv) {
    if (flag === '--verbose') args.verbose = true;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

function lineIndexer(text) {
  const starts = [];
  for (let i = 0; i < text.length; i += 1) if (i === 0 || text[i - 1] === '\n') starts.push(i);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Every `npm run <script>` in a blob, with its offset. */
function npmScriptsIn(text) {
  const re = /npm run ([a-z][a-z0-9]*(?::[a-z0-9]+)*)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ script: m[1], index: m.index });
  return out;
}

/**
 * Every repo-relative path in a blob.
 *
 * Sources: backticked spans, and bare tokens inside fenced blocks. A path in
 * running prose without backticks is NOT collected — these documents write
 * ordinary sentences containing words like "e.g." and "vs.", and matching those
 * would bury the real findings.
 */
function pathsIn(text) {
  const out = [];
  const consider = (raw, index) => {
    let token = raw.trim().replace(/^\.\//, '');
    // Trailing punctuation from prose, and a trailing colon from a listing.
    token = token.replace(/[),.:;'"]+$/, '');
    if (PLACEHOLDER.test(token)) return;
    if (!FILE_EXT.test(token)) return;
    if (token.includes(' ')) return;
    if (/^https?:/.test(token) || token.startsWith('@')) return;
    // Must look repo-relative: contain a slash, and not start with one.
    if (!token.includes('/') || token.startsWith('/')) return;
    out.push({ token, index });
  };

  const backtick = /`([^`\n]+)`/g;
  let m;
  while ((m = backtick.exec(text)) !== null) consider(m[1], m.index);

  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1];
    const base = m.index + m[0].indexOf(body);
    const wordRe = /[A-Za-z0-9_./-]+/g;
    let w;
    while ((w = wordRe.exec(body)) !== null) consider(w[0], base + w.index);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- what scripts exist ---------------------------------------------------
  const known = new Set();
  const manifestsFound = [];
  for (const rel of MANIFESTS) {
    const file = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(file)) continue;
    manifestsFound.push(rel);
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const name of Object.keys(pkg.scripts || {})) known.add(name);
  }
  if (known.size === 0) fail('no package.json with a scripts block was found — nothing to check against');

  const badScripts = [];
  const badPaths = [];
  const softPaths = [];
  const plannedHit = new Map();
  const quotedHit = new Map();
  const plannedScriptHit = new Map();
  let scriptsChecked = 0;
  let pathsChecked = 0;
  const writeupsFound = [];

  for (const { file: rel, mode } of WRITEUPS) {
    const file = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(file)) continue;
    writeupsFound.push(rel);
    const text = fs.readFileSync(file, 'utf8');
    const lineOf = lineIndexer(text);

    for (const { script, index } of npmScriptsIn(text)) {
      scriptsChecked += 1;
      if (known.has(script)) continue;
      if (PLANNED_SCRIPTS.has(script)) {
        plannedScriptHit.set(script, (plannedScriptHit.get(script) || 0) + 1);
        continue;
      }
      badScripts.push({ file: rel, line: lineOf(index), script });
    }

    const seen = new Set();
    for (const { token, index } of pathsIn(text)) {
      const key = `${token}@${lineOf(index)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pathsChecked += 1;
      if (PLANNED.has(token)) {
        plannedHit.set(token, (plannedHit.get(token) || 0) + 1);
        continue;
      }
      if (QUOTED.has(token)) { quotedHit.set(token, (quotedHit.get(token) || 0) + 1); continue; }
      if (ROOTS.some((root) => fs.existsSync(path.join(REPO_ROOT, root, token)))) continue;
      const row = { file: rel, line: lineOf(index), token };
      if (mode === 'forward-looking' || UNTRACKED_BY_DESIGN.test(token)) softPaths.push(row);
      else badPaths.push(row);
    }
  }

  // --- report ---------------------------------------------------------------
  console.log('check:blocks — every command a writeup tells you to run must exist,');
  console.log('and every file it names must be there.\n');
  console.log(`  writeups         ${writeupsFound.length}  (${WRITEUPS.filter((w) => w.mode === 'current').length} current, the rest forward-looking)`);
  console.log(`  manifests        ${manifestsFound.join(', ')}  (${known.size} scripts)`);
  console.log(`  npm run checked  ${scriptsChecked}`);
  console.log(`  paths checked    ${pathsChecked}`);
  console.log('');

  if (plannedScriptHit.size > 0) {
    console.log('  PLANNED SCRIPTS — named for a phase that has not run.');
    for (const [name, n] of [...plannedScriptHit].sort()) {
      console.log(`    npm run ${name.padEnd(44)} x${n}  ${PLANNED_SCRIPTS.get(name)}`);
    }
    console.log('');
  }

  if (softPaths.length > 0) {
    console.log(`  NOT RESOLVED, NOT A FAILURE — ${softPaths.length} path(s). A deliverable a`);
    console.log('  forward-looking document names, or a data/ file that is gitignored by');
    console.log('  design and absent from a fresh clone.');
    const shown = args.verbose ? softPaths : softPaths.slice(0, 10);
    for (const r of shown) console.log(`    ${r.file}:${r.line}  ${r.token}`);
    if (softPaths.length > shown.length) console.log(`    ... and ${softPaths.length - shown.length} more (--verbose)`);
    console.log('');
  }

  if (quotedHit.size > 0) {
    console.log('  QUOTED AS A DEFECT — must NOT resolve; naming it is the point.');
    for (const [token, n] of [...quotedHit].sort()) {
      console.log(`    ${token.padEnd(52)} x${n}  ${QUOTED.get(token)}`);
    }
    console.log('');
  }

  if (plannedHit.size > 0) {
    console.log('  PLANNED — named on purpose, does not exist yet. Reported every run.');
    for (const [token, n] of [...plannedHit].sort()) {
      console.log(`    ${token.padEnd(52)} x${n}  ${PLANNED.get(token)}`);
    }
    console.log('');
  }

  const failures = [...badScripts.map((b) => ({ ...b, what: `npm run ${b.script}`, why: 'no such script' })),
    ...badPaths.map((b) => ({ ...b, what: b.token, why: 'no such file' }))];

  if (failures.length === 0) {
    console.log('  IT DOES NOT CHECK CODE QUOTED VERBATIM. A fenced block holding a function');
    console.log('  signature is invisible here — see the header. That is 3.4\'s case and it');
    console.log('  is still open.');
    console.log('');
    console.log('  PASS');
    return;
  }

  console.log(`  FAIL — ${failures.length} reference(s) do not resolve:\n`);
  const byFile = new Map();
  for (const f of failures) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const [file, rows] of byFile) {
    console.log(`  ${file}`);
    const shown = args.verbose ? rows : rows.slice(0, 12);
    for (const r of shown.sort((x, y) => x.line - y.line)) {
      console.log(`    :${String(r.line).padStart(6)}  ${r.what}   — ${r.why}`);
    }
    if (rows.length > shown.length) console.log(`    ... and ${rows.length - shown.length} more (--verbose)`);
    console.log('');
  }
  console.log('  Either the writeup is stale, or the file moved and nothing followed it.');
  console.log('  If it is a deliverable that does not exist yet, add it to PLANNED with');
  console.log('  the phase that creates it.');
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\ncheck:blocks failed: ${err.message}`);
    if (!err.assertion) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { npmScriptsIn, pathsIn };
