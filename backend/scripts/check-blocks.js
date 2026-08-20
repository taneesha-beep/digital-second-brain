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

// README.md IS IN THIS LIST AND IS NOT IN check:claims'. Phase 4.6's README
// pass, and the asymmetry is decided rather than sloppy.
//
// It is the ONLY PUBLISHED DOCUMENT — everything under docs/ is gitignored —
// and until now it was scanned by NEITHER tool. That gap has fired twice: 4.4
// updated four documents and left README saying the global graph "compares
// every pair of notes", which survived four sessions until a manual read found
// it; the README pass then found eight more false claims, six of them outside
// the section anyone re-reads.
//
// WHAT ADDING IT HERE ACTUALLY BUYS, STATED NARROWLY, BECAUSE IT IS LESS THAN
// THE MOTIVATION ABOVE IMPLIES: rules 1 and 2 check that commands run and paths
// resolve. NOT ONE of the eight claims was a command or a path — they were
// false sentences about behaviour, and no checker in this repo can see those.
// So this guards a DIFFERENT class from the one that prompted it: a renamed
// script or a moved file silently breaking the instructions a stranger follows.
// Worth one line; not worth mistaking for the fix.
//
// TWO LIMITS A READER SHOULD HAVE. Rule 2 resolves against the WORKING TREE, so
// it cannot see that a path is gitignored — README's two references to
// docs/EVALUATION.md resolved here and were dead for everyone else, and the
// README pass removed them by hand rather than by this tool. And adding any
// writeup slightly LOOSENS rule 3, whose reverse coverage counts a file as
// documented if its basename appears anywhere.
//
// check:claims deliberately does NOT gain README: §25.4 removed a test count
// from it precisely so that the published file holds no figure that rots, and
// the right rule there is "no decimals", which is not a thing that checker says.
//
// Same five documents as check:claims plus README, so "it passed the checks"
// has one domain — but NOT the same verdict rule, and the difference is the
// point.
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
// `published` IS LOAD-BEARING AND WAS ADDED THE DAY CI FIRST RAN.
//
// Four of these five are gitignored on purpose — they hold personal career
// material — so a fresh clone, and therefore every CI checkout, has exactly ONE
// of them. Rule 3 asks "is this file named by a writeup", which is
// unanswerable when the writeups that would name it are absent: the first real
// CI run flagged all 50 files in the covered roots and went red on a repository
// with no documentation gap at all.
//
// DECLARED, NOT PROBED, which is tests/helpers/preconditions.js's argument
// reused verbatim: a probe answers "was the file there", satisfied by accident,
// and a declaration answers "was it meant to be there". So an absent
// `published: false` writeup is an EXPECTED absence that skips rule 3 loudly,
// and an absent `published: true` one is a FAILURE — README.md going missing is
// not an environment, it is a defect.
const WRITEUPS = [
  { file: 'README.md', mode: 'current', published: true },
  { file: 'docs/EVALUATION.md', mode: 'current', published: false },
  { file: 'docs/PRIMER.md', mode: 'current', published: false },
  { file: 'docs/ROADMAP.md', mode: 'forward-looking', published: false },
  { file: 'docs/END-STATE.md', mode: 'forward-looking', published: false }
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
  ['fixtures/mini-corpus.json', '§20.8 — END-STATE\'s planned tree said .json; the fixture is mini-corpus.jsonl'],
  // 4.1. Not merely a path that does not exist — a path that MUST NOT, which is
  // a distinction this tool cannot draw on its own. END-STATE §1 planned the
  // corpus adapter here; tests/retrieval.interface.test.js fails any require
  // resolving outside backend/retrieval/, and an adapter requires
  // ../models/Note by definition. Worth noting the tool could never have found
  // it: END-STATE is forward-looking, where an unresolved path is the document
  // doing its job.
  ['backend/retrieval/adapters/mongoNotes.js', '§21.2 — END-STATE planned the adapter here; the location is FORBIDDEN by the no-I/O test, not merely absent. It is services/noteCorpus.service.js']
]);

// Scripts a writeup names for a phase that has not run yet.
//
// `eval:gen` LIVED HERE AND CAME OUT AT 5.4, WHICH IS THE ENTRY WORKING. It was
// added when ROADMAP named a command no phase had built; the phase built it, so
// the forgiveness is withdrawn and the script is now checked like any other. An
// entry left here after its phase ships is a permanent exemption for a command
// that exists — which would let a later rename break a stranger's instructions
// silently, the exact class rule 1 guards.
const PLANNED_SCRIPTS = new Map([]);

// Paths a writeup names that the READER is supposed to create. Not planned, not
// quoted-as-wrong — correct instructions about a file that must not be in the
// repository. §27 spotted this class in prose ("`backend/.env` has the same
// shape") and nothing acted on it; the first CI run turned it into a red build,
// because README tells a reader to create `backend/.env` and a fresh checkout
// rightly has none.
const CREATED_BY_READER = new Map([
  ['backend/.env', 'README tells the reader to create it; .env.example is the tracked template']
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

// ---------------------------------------------------------------------------
// RULE 3 — REVERSE COVERAGE. Phase 4.3.
// ---------------------------------------------------------------------------
//
// Rules 1 and 2 check that everything a document NAMES exists. Nothing checked
// the opposite direction, and that gap has now fired twice: 4.1 shipped six
// source files and four artifacts, and END-STATE's tree and CLAUDE.md's
// architecture map were both missing the corpus adapter until a deliberate
// manual sweep found it; 4.2 found four more gaps only on a SECOND sweep. Both
// sessions put "a reverse check is mechanisable" on the noticed list and
// deferred it, correctly, as a tool change on top of a structural one. Three
// deferrals is where a deferral becomes a habit, so it is built here.
//
// IT IS SCOPED TO ENUMERATED ROOTS, and that is what bounds the false-positive
// risk 4.1 established is the worst output this tool can produce. A repo-wide
// version would flag every fixture, every frozen frontend component and every
// file in node_modules, and would be switched off in a week. These four roots
// are where the reorientation adds files, and they are the ones the two
// recorded misses were in.
//
// A FILE IS "NAMED" IF ITS BASENAME APPEARS IN ANY WRITEUP, forward-looking
// ones included — END-STATE's planned tree is a legitimate place to introduce a
// file, and requiring the repo-relative path would fail the many correct
// references written relative to a contextual root (see ROOTS above). Basename
// matching is deliberately the LOOSE direction: it errs toward passing, so a
// failure here is strong evidence and never noise.
const COVERED_ROOTS = [
  { dir: 'backend/services', ext: /\.js$/ },
  { dir: 'backend/migrations', ext: /\.js$/ },
  { dir: 'backend/scripts/lib', ext: /\.js$/ },
  { dir: 'results', ext: /\.txt$/ }
];

// Files under a covered root that no writeup names ON PURPOSE. Every entry
// carries the reason, so this cannot quietly become the place undocumented
// files go to be forgiven.
const UNDOCUMENTED = new Map([]);

/**
 * Expand `a{x,y}b` into `axb` and `ayb`, so a brace form counts as naming both
 * files.
 *
 * THIS FUNCTION EXISTS BECAUSE THE RULE ABOVE FAILED ON ITS FIRST RUN AND WAS
 * WRONG. It reported results/contamination-linkdate.test.txt as named by
 * nothing. §19.6 names it — as `results/contamination-linkdate.{dev,test}.txt`,
 * which is a convention this repo uses deliberately and readably in at least
 * four places (`results/parity/v1-{shipped,harness}.txt`,
 * `data/splits/{train,dev,test}.ids`). Rule 2 already skips brace tokens as
 * PLACEHOLDERs; rule 3 was doing a literal substring search and could not see
 * through them.
 *
 * A FALSE POSITIVE DRESSED AS A COVERAGE FINDING IS THE WORST OUTPUT THIS TOOL
 * CAN PRODUCE — 4.1 established that when the hyphen bug reported a working
 * command as missing, and the cheap fix there was to rename the script to dodge
 * the checker. The equivalent cheap fix here was to add the file to
 * UNDOCUMENTED, or to rewrite §19.6's brace form as two paths. Both would have
 * left the tool wrong about every future brace reference. The rule is fixed
 * instead, and check-blocks.test.js pins it.
 */
function expandBraces(text) {
  const out = [];
  const re = /([\w./-]*)\{([\w.,-]+)\}([\w./-]*)/g;
  let match = re.exec(text);
  while (match !== null) {
    const [, prefix, alternatives, suffix] = match;
    for (const alt of alternatives.split(',')) out.push(`${prefix}${alt}${suffix}`);
    match = re.exec(text);
  }
  return out.join('\n');
}

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

/**
 * Every `npm run <script>` in a blob, with its offset.
 *
 * ↳ 4.1 ADDED THE HYPHEN, and the bug it fixes is the worst kind this tool can
 * have. Every script name up to 3.7 was `word` or `word:word`, so the class
 * excluded `-` and nobody noticed. 4.1 added `price:v5-app`, the name truncated
 * at the hyphen, and the report said `npm run price:v5 — no such script`:
 * a FALSE POSITIVE WEARING THE COSTUME OF A REAL STALENESS FINDING, against a
 * command that runs perfectly. A checker whose failures cannot be trusted is
 * one people learn to skim, which is the failure mode §20.8 named from the
 * other direction — the fix there was to stop the tool demanding that hundreds
 * of correct references be rewritten to satisfy it.
 *
 * Renaming the script to dodge this was the cheaper option and would have been
 * the tool serving itself. The class now allows `-` and `:` internally while
 * still requiring the name to start and end alphanumeric, so a trailing `--`
 * (as in `npm run check:blocks -- --verbose`) is not swallowed.
 */
function npmScriptsIn(text) {
  const re = /npm run ([a-z](?:[a-z0-9:-]*[a-z0-9])?)/g;
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
  const readerHit = new Map();
  let scriptsChecked = 0;
  let pathsChecked = 0;
  const writeupsFound = [];
  // Absent writeups, split by whether their absence is the design or a defect.
  const absentUnpublished = [];
  const absentPublished = [];

  for (const { file: rel, mode, published } of WRITEUPS) {
    const file = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(file)) {
      (published ? absentPublished : absentUnpublished).push(rel);
      continue;
    }
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
      if (CREATED_BY_READER.has(token)) {
        readerHit.set(token, (readerHit.get(token) || 0) + 1);
        continue;
      }
      if (ROOTS.some((root) => fs.existsSync(path.join(REPO_ROOT, root, token)))) continue;
      const row = { file: rel, line: lineOf(index), token };
      if (mode === 'forward-looking' || UNTRACKED_BY_DESIGN.test(token)) softPaths.push(row);
      else badPaths.push(row);
    }
  }

  // --- rule 3: reverse coverage ---------------------------------------------
  //
  // RUNS ONLY WHEN EVERY WRITEUP IS PRESENT. With four of the five gitignored,
  // a CI checkout holds one, and asking "does any writeup name this file"
  // against a fifth of the corpus answers a different question than the one the
  // rule exists for — it reported all 50 covered files as undocumented on the
  // first CI run this repository ever produced. Skipping is not weakening it:
  // it was ALWAYS a local-only guard, and this makes that fact declared instead
  // of accidental. The skip is announced with the names, because §22.6's whole
  // lesson is that a check which quietly does not run looks exactly like one
  // that passed.
  const coverageRan = absentUnpublished.length === 0 && absentPublished.length === 0;
  const raw = writeupsFound.map((rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')).join('\n');
  const corpus = `${raw}\n${expandBraces(raw)}`;
  const undocumented = [];
  const undocumentedHit = new Map();
  let coverageChecked = 0;
  const rootsScanned = [];

  for (const root of coverageRan ? COVERED_ROOTS : []) {
    const dir = path.join(REPO_ROOT, root.dir);
    if (!fs.existsSync(dir)) continue;
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && root.ext.test(e.name))
      .map((e) => e.name)
      .sort();
    rootsScanned.push(`${root.dir}/ (${names.length})`);
    for (const name of names) {
      coverageChecked += 1;
      const rel = `${root.dir}/${name}`;
      if (UNDOCUMENTED.has(rel)) {
        undocumentedHit.set(rel, UNDOCUMENTED.get(rel));
        continue;
      }
      if (!corpus.includes(name)) undocumented.push(rel);
    }
  }

  // --- report ---------------------------------------------------------------
  console.log('check:blocks — every command a writeup tells you to run must exist,');
  console.log('every file it names must be there, and every file in a covered root');
  console.log('must be named somewhere.\n');
  console.log(`  writeups         ${writeupsFound.length}  (${WRITEUPS.filter((w) => w.mode === 'current').length} current, the rest forward-looking)`);
  console.log(`  manifests        ${manifestsFound.join(', ')}  (${known.size} scripts)`);
  console.log(`  npm run checked  ${scriptsChecked}`);
  console.log(`  paths checked    ${pathsChecked}`);
  console.log(`  files covered    ${coverageRan ? `${coverageChecked}  in ${rootsScanned.join(', ')}` : 'RULE 3 SKIPPED — see below'}`);
  console.log('');

  if (absentUnpublished.length > 0) {
    console.log('  RULE 3 DID NOT RUN, AND THAT IS DECLARED RATHER THAN SILENT.');
    console.log('  Reverse coverage — "every file in a covered root is named by a writeup" —');
    console.log('  needs the writeups. These are gitignored by design and absent here:');
    console.log('');
    for (const rel of absentUnpublished) console.log(`    ${rel}`);
    console.log('');
    console.log('  So this run checked rules 1 and 2 only, over the writeups that ARE here:');
    console.log(`    ${writeupsFound.join(', ') || '(none)'}`);
    console.log('');
    console.log('  Those two are the ones that matter to a stranger: they check that every');
    console.log('  command README tells you to run exists and every path it names resolves.');
    console.log('  Rule 3 is a local guard and always was. Run it with docs/ present.');
    console.log('');
  }

  if (readerHit.size > 0) {
    console.log('  CREATED BY THE READER — named correctly, and must not be in the repo.');
    for (const [token, why] of [...readerHit.keys()].sort().map((k) => [k, CREATED_BY_READER.get(k)])) {
      console.log(`    ${token.padEnd(52)}  ${why}`);
    }
    console.log('');
  }

  if (undocumentedHit.size > 0) {
    console.log('  UNDOCUMENTED ON PURPOSE — in a covered root, named by no writeup.');
    for (const [rel, why] of [...undocumentedHit].sort()) {
      console.log(`    ${rel.padEnd(52)}  ${why}`);
    }
    console.log('');
  }

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

  // The other direction of the declaration. An absent gitignored writeup is the
  // design; an absent PUBLISHED one is a defect, and it must not be able to
  // disable rule 3 quietly on its way past.
  if (absentPublished.length > 0) {
    console.log(`  FAIL — ${absentPublished.length} writeup(s) declared published are missing:\n`);
    for (const rel of absentPublished) console.log(`    ${rel}`);
    console.log('');
    console.log('  These are tracked files. Absent means deleted or renamed, not gitignored,');
    console.log('  and rule 3 was skipped as a consequence rather than as a decision.');
    console.log('');
    process.exitCode = 1;
  }

  if (undocumented.length > 0) {
    console.log(`  FAIL — ${undocumented.length} file(s) exist in a covered root and no writeup names them:\n`);
    for (const rel of undocumented) console.log(`    ${rel}`);
    console.log('');
    console.log('  This is the direction rules 1 and 2 cannot see. Either name the file');
    console.log('  in END-STATE\'s tree, EVALUATION\'s writeup or the ROADMAP entry that');
    console.log('  created it, or add it to UNDOCUMENTED with the reason it is not named.');
    console.log('');
    process.exitCode = 1;
  }

  if (failures.length === 0 && undocumented.length === 0 && absentPublished.length === 0) {
    console.log('  IT DOES NOT CHECK CODE QUOTED VERBATIM. A fenced block holding a function');
    console.log('  signature is invisible here — see the header. That is 3.4\'s case and it');
    console.log('  is still open.');
    console.log('');
    console.log('  PASS');
    return;
  }

  // Guarded, because rule 3 can fail on its own: printing "FAIL — 0
  // reference(s) do not resolve" beside a real rule-3 failure is a false
  // positive in the report even when the verdict is right, and 4.1 established
  // that a checker whose output cannot be trusted is one people skim.
  if (failures.length === 0) return;

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

module.exports = { npmScriptsIn, pathsIn, expandBraces, COVERED_ROOTS, UNDOCUMENTED };
