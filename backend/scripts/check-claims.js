#!/usr/bin/env node
'use strict';

/**
 * check-claims.js — Phase 3.6
 *
 *   cd backend && npm run check:claims
 *   cd backend && npm run check:claims -- --verbose
 *
 * CLAUDE.md: "never claim a number without the file it came from." Until now
 * that was enforced by care, and care failed the same way in two consecutive
 * sessions:
 *
 *   3.4  a commit message quoted four nDCG values whose digits past the fourth
 *        were extrapolated from a rounded display rather than read from a file
 *   3.5  §18.5's two ablation ABSOLUTES were first drafted as 0.311971 and
 *        0.310689, obtained by adding a report's delta to a four-decimal
 *        display, where the sidecars say 0.311965 and 0.310715
 *
 * Both were caught by re-deriving every figure from the JSON before pushing,
 * which §18.10 calls "a habit and not a mechanism" and says should be a script.
 * This is the script. It runs before 3.6's writeup rather than after it, so §19
 * is the first section produced under the mechanism.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS THIS RULE
 * ---------------------------------------------------------------------------
 *
 * A quoted decimal with d places must be the correct rounding TO d PLACES of
 * some decimal that appears in a committed artifact.
 *
 *   0.3269      passes   the sidecar has 0.3268933101824833, which rounds to it
 *   0.311965    passes   the sidecar has exactly that
 *   0.311971    FAILS    nothing in any artifact rounds to it at 6 places
 *
 * Rounding is the load-bearing part. An exact-substring check would reject
 * every legitimately rounded figure in the document, which is most of them, and
 * a check that everyone disables is worth less than no check. A prefix check
 * would accept 0.3268 and reject 0.3269, i.e. reject correct rounding and
 * accept truncation — backwards.
 *
 * ONLY FOUR OR MORE DECIMAL PLACES ARE IN SCOPE, and that is a scoping decision
 * rather than a shortcut. It is exactly the class that bit: figures quoted past
 * the fourth place, where a reader cannot tell a read value from an inferred
 * one. It also excludes the enormous false-positive population BY CONSTRUCTION
 * instead of by allowlist — section references (§17.8), version numbers
 * (4.2.0, v25.8.1), derived percentages (76.7%), the 0.1-0.4 plausibility band
 * and every ratio written to two places are all under four places and never
 * reach the check. An allowlist that has to name those would be longer than the
 * document and would silently swallow real errors.
 *
 * WHAT IT CANNOT DO, stated so nobody reads a pass as more than it is:
 *
 *   - It does not check that a number is quoted in the RIGHT PLACE. 0.3269 is
 *     v5's dev nDCG@8; writing it beside v4's name passes this check.
 *   - It does not check integers, counts, or anything under four places.
 *   - It does not check that the artifact is the RELEVANT one. Any artifact
 *     will satisfy any figure.
 *   - A figure computed correctly in prose from two artifact figures FAILS, and
 *     that is intended: CLAUDE.md wants the file it came from, so the fix is to
 *     put the computation in a script that writes an artifact.
 *   - A DOCUMENT THAT RECORDS ITS OWN ERRORS MAKES THOSE WRONG VALUES
 *     PERMANENTLY CITABLE. results/v6-hybrid.txt contains the sentence "the two
 *     ablation ABSOLUTES were first written as 0.311971 and 0.310689 ... the
 *     true values are 0.311965 and 0.310715", so 0.311971 is now in a committed
 *     artifact and this check will accept it forever. Found while probing the
 *     tool with the exact bug it was built for, which is how the probe came
 *     back PASS. Unavoidable in a repo whose discipline is to record mistakes
 *     rather than erase them, and better stated than quietly relied upon.
 *
 * So it catches invented digits, which is the failure that actually happened,
 * twice. It does not certify a document.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The writeups. docs/ is gitignored (personal career material lives there) but
// these are the documents every published claim is drafted in, so they are what
// has to be checked.
const WRITEUPS = [
  'docs/EVALUATION.md',
  'docs/ROADMAP.md',
  'docs/PRIMER.md',
  'docs/END-STATE.md',
  // ADDED AT 7.1, AND IT IS THE FIRST WRITEUP IN THIS LIST THAT IS PUBLISHED.
  // docs/FAILURE-MODES.md is TRACKED — README links to it from Phase 8.1, and a
  // gitignored target would be a broken link in the only document a stranger
  // reads. That inverts this list's usual situation without changing the rule:
  // a published document has MORE reason to be checked, not less.
  //
  // README.md WAS DELIBERATELY ABSENT FROM THIS LIST UNTIL 8.1, AND THE
  // ARGUMENT THAT KEPT IT OUT DOES NOT SURVIVE BEING CHECKED. It read: the rule
  // keeping a rotting figure out of README is "no numbers at all", and this
  // check only requires a decimal to TRACE to an artifact, "which would license
  // the test count 4.5 removed."
  //
  // IT WOULD NOT. A test count is an INTEGER, and this checker has never looked
  // at an integer — MIN_PLACES is 4, so 949 is out of scope here exactly as it
  // is out of scope in every other document on this list. Adding README could
  // not license it, because adding README does not check it. The real risk was
  // never mechanical: it was a reader concluding "README is in check:claims,
  // therefore numbers in README are safe" and putting back the class that rots.
  // The answer to a misreading is to write the rule down precisely, not to
  // forbid the entire class the rule was a proxy for.
  //
  // THE RULE, AS IT NOW STANDS, IN CLAUDE.md's OWN THREE CLASSES:
  //
  //   countable from code   FINE, and always was. The cap of 8, the top-10
  //                         keywords, the four rate limits, the Node pin, the
  //                         port numbers. A reader re-derives these by opening
  //                         one file; they cannot rot without the code changing
  //                         under them, and that is a diff somebody reads.
  //   measured, >= 4 dp     FINE, and now CHECKED — this entry is what makes it
  //                         so. 8.1's results table is nDCG@8 and P@8 at four
  //                         places, so every figure in it must be the correct
  //                         rounding of one in a committed artifact.
  //   measured, anything    STAYS OUT. Counts, percentages, one-to-three-place
  //   else                  decimals. Nothing can see them, so they rot in
  //                         silence in the only published document. THIS IS THE
  //                         CLASS 4.5's TEST COUNT BELONGED TO and it is still
  //                         banned — by a rule that now says which numbers and
  //                         why, rather than by a blanket that also banned the
  //                         table Phase 8 exists to print.
  //
  // WHAT THIS DOES NOT BUY — AND IT IS MUCH LESS THAN THE PARAGRAPH ABOVE
  // SOUNDS LIKE. MEASURED AT 8.1, NOT ASSUMED. The header already says this
  // tool cannot tell whether the artifact is the RELEVANT one; adding the
  // results table is what turned that caveat into a number. Two mutations of
  // the new table BOTH SURVIVED this checker on the first attempt:
  //
  //     0.3197 -> 0.3198   PASS — results/sweeps/v4-bm25-params.csv holds
  //                        0.319774, an unrelated BM25 grid point
  //     0.2391 -> 0.2394   PASS — same class of coincidence
  //
  // Sweeping every 4-place slot in the plausibility band [0.0500, 0.4500]
  // against the tracked artifact index: 1510 of 4001 are already justified by
  // something. So 37.7% of wrong values pass, and the two sweep CSVs that
  // dominate that index cluster in exactly the region real nDCG figures live —
  // which makes the true rate NEAR a correct value worse than 37.7%, not
  // better.
  //
  // So this entry catches INVENTED DIGITS in the published table and does not
  // catch a MISPLACED or DRIFTED one. tests/readme-results-table.test.js is
  // what catches those: it compares each cell against the specific sidecar it
  // claims to come from, and it is mutation-checked with eight wrong
  // implementations, eight caught — including the two that survived here.
  // The two are complements. Neither alone is the guard.
  //
  // THE p95 LATENCY COLUMN 8.1 ORIGINALLY ASKED FOR IS NOT HERE, AND THE
  // CHECKER IS THE SMALLEST OF THE THREE REASONS. results/baseline-v1.txt rules
  // that p95 is quotable "at one figure" on an uncontrolled laptop — and one
  // significant figure is an integer, i.e. the one precision this tool cannot
  // see. The two larger reasons are in README's own decision note.
  //
  // WHAT THIS BUYS IS PARTIAL AND THE DOCUMENT SAYS SO IN ITS OWN §8. The scope
  // is four-or-more decimal places (§3.6), so the handful of full-precision
  // nDCG figures are covered and every percentage and integer count in the file
  // is out of scope by construction. That is the documented trade, not a hole.
  'docs/FAILURE-MODES.md',
  // ADDED AT 6.3, THE SECOND PUBLISHED WRITEUP, AND ITS DECIMALS ARE FEW AND
  // LOAD-BEARING. docs/OBSERVABILITY.md is tracked for FAILURE-MODES.md's
  // reason — README links to it from 8.1 — and it quotes one full-precision
  // figure, the cost on the llm-call span, which must keep tracing to
  // results/tracing-attributes.txt. Its other numbers are percentages and
  // millisecond pairs, out of the four-decimal scope by construction, exactly
  // as §3.6 intends.
  'docs/OBSERVABILITY.md',
  // ADDED AT 8.1, THE THIRD PUBLISHED WRITEUP AND THE ONLY ONE A STRANGER
  // ACTUALLY OPENS. See the long note above for why the argument that kept it
  // out was wrong. Its in-scope population is small and deliberate: the six
  // rungs' nDCG@8 and P@8 on the held-out split, twelve figures. This entry
  // proves each is not invented; tests/readme-results-table.test.js proves each
  // is in the right ROW, which is the half this tool cannot do. See above.
  // ⚠️ SCOPED, AND THE ONLY SCOPED ENTRY. The pre-Phase-8 sweep, 27 Aug 2026.
  //
  // 8.1 MEASURED that the global artifact index is too permissive to protect a
  // published table: across the plausibility band [0.0500, 0.4500], **1513 of
  // 4001 four-place slots are already justified by SOMETHING** — 37.8% — because
  // results/sweeps/*.csv holds thousands of BM25 grid points that cluster
  // exactly where real nDCG figures live. So `0.3197 -> 0.3198` passed, justified
  // by an unrelated sweep row. THE CHECKER CATCHES INVENTED DIGITS AND NOT
  // MISPLACED ONES.
  //
  // Scoping is the narrow fix 8.1's noticed list named and declined. MEASURED
  // rather than assumed, the same way the problem was:
  //
  //     global   results/, 144 tracked files    1513 of 4001 = 37.8%
  //     scoped   results/runs/ + test-ladder    361 of 4001 =  9.0%
  //
  // A 4.2x reduction in the surface on which a WRONG value passes, and all 12 of
  // README's four-place decimals still trace — so it costs nothing in false
  // positives, which is the failure mode 4.1 established is the worst this tool
  // can produce.
  //
  // WHY THESE TWO PATHS: README's table is nDCG@8 and P@8 on the HELD-OUT SPLIT.
  // results/runs/*.run.json are the per-run sidecars that carry those figures,
  // and results/test-ladder.txt is the ladder writeup that tabulates them. A
  // sweep CSV is a different measurement on a different split and has no
  // business justifying a headline.
  //
  // IT IS NOT THE WHOLE GUARD AND MUST NOT BE READ AS ONE. 9.0% is not 0%, and
  // tests/readme-results-table.test.js remains the thing that catches a
  // MISPLACED figure — it pins each cell to its own sidecar, which no index over
  // values can do. The two are complements: this narrows what an invented digit
  // can hide behind, that one pins what belongs in each slot.
  { file: 'README.md', artifacts: ['results/runs/', 'results/test-ladder.txt'] },
  // ADDED AT 8.2 — nine more published documents, and all of them UNSCOPED.
  //
  // WHY UNSCOPED, WHEN README IS NOT. README quotes ONE table drawn from ONE
  // family of artifacts, so naming that family is both possible and a 4.2x
  // narrowing. These nine cite deliberately WIDE: the ladder, the comparisons,
  // the parity proofs, the write-cost fixture, the graph characterization, the
  // generation ledgers. A scope listing all of those is the global index with
  // extra steps, and a scope that MISSES one turns a correct figure red — which
  // is the false-positive failure this tool's header calls the worst output it
  // can produce. So they take the same unscoped treatment as the two published
  // documents already on this list.
  //
  // tests/check-claims.test.js asserts README is the ONLY scoped writeup and
  // that every other entry has `artifacts: null`. These additions keep that
  // true, which is the assertion working rather than a coincidence.
  //
  // WHAT IS ACTUALLY COVERED HERE IS SMALL, AND EACH DOCUMENT SAYS SO IN ITS
  // OWN TEXT. MIN_PLACES is 4, so the nDCG figures and the exponent-form
  // Sigma_t df_t^2 values are checked and every count, percentage, millisecond
  // and MiB figure in these files is out of scope BY CONSTRUCTION. That is the
  // documented trade (§3.6), not a hole — and 8.1 measured what even the
  // covered half buys: this checker catches an INVENTED digit and not a
  // MISPLACED one.
  'docs/ARCHITECTURE.md',
  'docs/adr/README.md',
  'docs/adr/0001-canonical-edge-storage.md',
  'docs/adr/0002-lexical-first-retrieval.md',
  'docs/adr/0003-no-job-queue.md',
  'docs/adr/0004-microbenchmark-not-load-test.md',
  'docs/adr/0005-no-response-caching.md',
  'docs/adr/0006-offline-retriever-interface.md',
  'docs/adr/0007-in-memory-per-user-index.md',
  'docs/adr/0008-external-ground-truth.md',
  // ADDED AT 3.7, AND IT SITS UNDER results/, WHICH IS AN ARTIFACT ROOT.
  // That makes it the first document to be both a writeup and, by path, a
  // candidate artifact — so it would justify its own figures: every decimal in
  // it would match itself and the check would report PASS having asserted
  // nothing. It is prose about numbers, not a computed report; the computed
  // report beside it is results/error-analysis.dev.txt. Excluded from the
  // artifact index below, which is the general rule and not a special case:
  // A DOCUMENT CANNOT BE ITS OWN EVIDENCE.
  'results/error-analysis.md'
];

// Where a number is allowed to come from. Committed evidence only: sidecars,
// comparison reports, sweep CSVs and manifests, the metric validation, the
// Phase 1 manifests. Deliberately NOT the writeups themselves — a document
// citing itself is the circularity this exists to break.
//
// GIT-TRACKED ONLY, and the first draft of this script got that wrong in a way
// worth recording. It walked results/ from the filesystem, which pulls in
// results/runs/*.run and results/sweeps/runs/ — both GITIGNORED, both tens of
// thousands of lines of six-decimal SCORE COLUMNS. Any four-decimal claim could
// then be "justified" by a coincidental match against an unrelated document's
// BM25 score, which is a false negative on the exact axis this tool exists to
// remove. It also contradicted the sentence directly above. §8.5's boundary is
// the right one and is now enforced rather than described: a run file is
// derived data that regenerates, the sidecar beside it is the evidence.
const ARTIFACT_ROOTS = ['results'];
const ARTIFACT_EXT = new Set(['.txt', '.json', '.csv', '.md']);

// The Phase 1 manifests, added by path rather than by tracking. NOTHING under
// data/ is tracked — the corpus, qrels, splits and vectors are gitignored for
// size — but a manifest is not derived data in the sense §8.5 rejects: it IS
// the provenance record, the thing that pins the bytes, and it is what §2.6,
// §3.3 and §4.3 quote. Same class as Posts.xml: pinned by checksum rather than
// committed. Run files stay out because they are the regenerable half.
const EXTRA_ARTIFACTS = [
  'data/corpus/cooking.manifest.json',
  'data/qrels/cooking.manifest.json',
  'data/splits/cooking.manifest.json',
  'data/vectors/cooking.minilm-l6-v2-fp32-256.manifest.json',
  'data/vectors/cooking.minilm-l6-v2-fp32-128.manifest.json',
  'data/vectors/cooking.minilm-l6-v2-fp32-256-title2.manifest.json'
];

const MIN_PLACES = 4;
const MAX_PLACES = 17;

// Decimals that are STRUCTURAL — defined by the protocol rather than measured,
// so no artifact is expected to contain them. Each one carries its reason, and
// the list is committed so that adding to it is a visible act.
const ALLOWED = new Map([
  ['0.0500', 'family-wise alpha, registry.json'],
  ['0.00714', 'alpha/7, Holm bound at the first step — arithmetic on alpha'],
  ['0.00833', 'alpha/6'],
  ['0.01000', 'alpha/5'],
  ['0.01250', 'alpha/4'],
  ['0.01667', 'alpha/3'],
  ['0.02500', 'alpha/2'],
  ['0.05000', 'alpha/1'],
  ['0.0625', 'alpha/8 — quoted only to say it is what an EIGHTH entry WOULD cost'],
  ['0.00625', 'alpha/8, same'],
  // §9.2's worked example, re-derived by hand before use. These are arithmetic
  // identities, not measurements: 3/log2(3) is 1.8928 for anyone with a
  // calculator, and each term is asserted separately in tests/metrics.test.js
  // so a failure names which stage broke. Same class as alpha/7 — defined
  // rather than measured — which is why they live here and not under GAPS.
  ['1.8928', '3/log2(3), §9.2 worked example, asserted in tests/metrics.test.js'],
  ['0.38685', '1/log2(6), same'],
  ['2.2797', 'their sum, the example DCG, same'],
  ['0.63093', '1/log2(3), the IDCG discount term, same'],
  ['3.63093', '3 + 0.63093, the example IDCG, same'],
  ['0.6309', '1/log2(3) to four places, §9.2 on the classic off-by-one'],
  // Surfaced only AFTER the sentence-final regex bug was fixed — it is written
  // "quotient 0.6278." and the old lookahead skipped it. One more term of the
  // same worked example, and a small demonstration that the blind spot was
  // hiding real inputs rather than being theoretical.
  ['0.6278', '2.2797/3.63093, the example nDCG@8, §9.2, asserted in tests/metrics.test.js']
]);

// FABRICATED figures inside format illustrations. Not claims: they demonstrate
// the SHAPE of a TREC run line or a trace, and no artifact should contain them.
// Listed individually rather than by skipping fenced code blocks, because real
// result tables live in fenced blocks too (§18.3's comparison output, §18.6's
// sweep curve) and skipping those would blind the tool to most of its domain.
const ILLUSTRATIVE = new Map([
  ['0.8123', 'PRIMER §4.2 — invented score in the TREC run-file format example'],
  ['12.4471', 'END-STATE §2.4 — invented score in the run-file format example'],
  ['11.8903', 'END-STATE §2.4 — the second line of the same example'],
  ['0.00041', 'PRIMER §8.2 — invented cost in the hypothetical trace waterfall'],
  ['0.00042', 'END-STATE §2.10 — invented cost in the hypothetical trace'],
  ['0.150001', 'ROADMAP — a hypothetical strength showing that toFixed(4) rounds it to 0.15']
]);

// CORRECT, MEASURED, AND WRITTEN BY NOTHING. The tool found these on its first
// run and they are the honest output of it: each recomputes, and each is quoted
// from a read-only script's stdout that persists no file. They are reported on
// every run rather than silently suppressed, and they are not failures, because
// the fix is to give two analysis scripts a writer — which is its own task and
// not the one 3.6 is doing.
const GAPS = new Map([
  // 1.9145 (dev mean judgments/query) WAS here on the tool's first run and is
  // no longer: analyse-ladder.js needed the same figure for §3 of its report,
  // so writing that report closed the gap as a side effect. Recorded because it
  // is the mechanism working — the fix for a gap is an artifact, and the tool
  // stops naming it the moment one exists.
  //
  // 3.73e7 AND 8.12e8 WERE HERE AND ARE NO LONGER, closed at 3.7 by giving
  // analyse:vocab a writer — results/vocabulary.dev.txt. Closing it exposed a
  // real inconsistency in this tool rather than merely satisfying it, and that
  // is recorded at the exponent branch in main() rather than here.
  ['1.8093', 'corpus mean judgments/query, §3.3 — lives in data/qrels/cooking.manifest.json, which is gitignored'],
  // FOUND AT 3.7 BY THE EXPONENT BRANCH GETTING STRICTER, and they were never
  // justified — the OLD branch passed them by matching 1.12e-4 against any
  // artifact value that rounds to 0.0001 at four places, which on 15,000
  // indexed decimals is a near-certainty. Six figures that looked checked and
  // were not. They are §11.3's five-seed bootstrap stability table: measured
  // at 2.5, correct, and produced by an experiment that wrote no file. Same
  // class as 1.8093 and NOT a licence to keep them — the fix is the one that
  // closed 3.73e7, a writer on the script that computes them, and that is
  // 6.5's, which owns controlled measurement.
  ['1.12e-4', '§11.3 CI-spread at B=1,000, five-seed stability table — measured at 2.5, no artifact'],
  ['1.25e-4', '§11.3, same table, upper bound at B=1,000'],
  ['5.50e-5', '§11.3, same table, B=10,000'],
  ['5.77e-5', '§11.3, same table, upper bound at B=10,000'],
  ['1.20e-5', '§11.3, same table, B=100,000'],
  ['5.85e-6', '§11.3, same table, upper bound at B=100,000']
]);

function parseArgs(argv) {
  const args = { verbose: false };
  for (const flag of argv) {
    if (flag === '--verbose') args.verbose = true;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** Tracked files under a root, from git — not from the filesystem. */
function trackedUnder(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', root], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\0')
    .filter((rel) => rel !== '' && ARTIFACT_EXT.has(path.extname(rel)))
    .map((rel) => path.join(REPO_ROOT, rel));
}

/**
 * Every decimal in a blob, as a string, with its place count.
 *
 * The regex takes an optional exponent so 1.11e-16 is one token rather than
 * "1.11" followed by noise, and a negative lookbehind on a digit-or-dot so that
 * "25.8.1" does not yield a spurious tail.
 *
 * THE TRAILING LOOKAHEAD IS TWO CONDITIONS, NOT ONE, and the first draft
 * collapsed them into `(?![\d.])`. That rejects a following period
 * unconditionally — so `0.310689.` at the END OF A SENTENCE did not match at
 * all, and every figure that ends a sentence was invisible to the check. In a
 * prose document that is most of them. Caught by probing the tool rather than
 * by reading it.
 *
 * What the two conditions actually have to say is: not followed by another
 * DIGIT (so `0.31` inside `0.3105` is not a match on its own), and not followed
 * by a dot THAT STARTS ANOTHER NUMBER (so `25.8` inside `v25.8.1` is rejected
 * while `0.310689.` is accepted).
 */
const DECIMAL_RE = /(?<![\d.])(\d+)\.(\d+)(?:[eE]([+-]?\d+))?(?!\d)(?!\.\d)/g;

function decimalsIn(text) {
  const found = [];
  let m;
  DECIMAL_RE.lastIndex = 0;
  while ((m = DECIMAL_RE.exec(text)) !== null) {
    found.push({ token: m[0], intPart: m[1], frac: m[2], exp: m[3] ? Number(m[3]) : null, index: m.index });
  }
  return found;
}

/**
 * WRITEUPS holds strings and, for a scoped document, objects. One shape from
 * here down.
 *
 * `artifacts` is a list of repo-relative PREFIXES. A writeup carrying one is
 * checked against ONLY the artifacts under those prefixes; a writeup without
 * one is checked against every artifact, which is the behaviour every entry had
 * before scoping existed and still has.
 */
/**
 * Is this repo-relative artifact path inside a writeup's scope?
 *
 * EXPORTED SO THE TEST USES THIS AND NOT A COPY. The first version of the
 * scoping test reimplemented the prefix match to compute the 37.8%-to-9.0%
 * narrowing, and a mutation making this predicate return `true` for everything
 * therefore SURVIVED — the test measured its own logic and agreed with itself.
 * That is §32.7's fixture problem in a new place: a check written beside an
 * implementation inherits the implementation's assumptions unless it shares the
 * implementation.
 *
 * A prefix ending in `/` is a directory; anything else must match exactly, so
 * `results/test-ladder.txt` cannot accidentally scope in
 * `results/test-ladder.txt.bak`.
 */
function matchesScope(rel, artifacts) {
  return artifacts.some((prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix));
}

/**
 * WHICH INDEX A WRITEUP IS CHECKED AGAINST — extracted because a mutation
 * survived without it.
 *
 * Replacing the binding with "always global" left every scoping test GREEN and
 * the checker green too: the tests asserted the CONFIGURATION — the scope's
 * paths, the shape, the measured narrowing — and none of them proved a scoped
 * writeup actually USES the narrow index. Configuration and wiring are two
 * things, and this is the one that was broken.
 *
 * Third instance of the shape in this sweep, after check-blocks' rule 4 and
 * measure-gen-baseline's plan branch. The lesson is consistent enough to state
 * plainly: WHEN A FEATURE'S CORRECT OUTPUT IS "NOTHING CHANGED", THE JOIN
 * BETWEEN ITS PARTS NEEDS ITS OWN TEST.
 */
function indexForWriteup(scope, scopedIndexes, globalIndex) {
  if (!scope) return globalIndex;
  const sc = scopedIndexes.get(scope.join('|'));
  // A scope naming nothing is a configuration error, not a licence to fall back
  // to the global index — falling back would silently restore the permissiveness
  // the scope was added to remove.
  if (!sc) throw new Error(`check-claims: no index built for scope ${scope.join('|')}`);
  return { rounded: sc.rounded, exp: sc.exp };
}

function normaliseWriteups(list) {
  return list.map((entry) => (typeof entry === 'string'
    ? { file: entry, artifacts: null }
    : { file: entry.file, artifacts: entry.artifacts }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- build the index of what artifacts contain ---------------------------
  const writeups = normaliseWriteups(WRITEUPS);
  const writeupSet = new Set(writeups.map((w) => path.join(REPO_ROOT, w.file)));
  const artifactFiles = [
    ...ARTIFACT_ROOTS.flatMap((r) => trackedUnder(r)),
    ...EXTRA_ARTIFACTS.map((r) => path.join(REPO_ROOT, r)).filter((f) => fs.existsSync(f))
  ].filter((f) => !writeupSet.has(f));
  // roundedIndex[d] = Set of every artifact value rounded to d places.
  // expIndex[p]     = the same values in exponential form with p mantissa
  //                   places, which is what the exponent branch below needs.
  const roundedIndex = new Map();
  const expIndex = new Map();
  for (let d = MIN_PLACES; d <= MAX_PLACES; d += 1) roundedIndex.set(d, new Set());
  for (let p = 0; p <= MAX_PLACES; p += 1) expIndex.set(p, new Set());
  let artifactValues = 0;

  // SCOPED INDEXES. One per distinct `artifacts` list, built from the same files
  // and the same parser as the global index — so a scoped check is strictly a
  // SUBSET of the global one and can never accept something the global index
  // would reject. That containment is the property that makes scoping safe to
  // add to an existing checker: it can only tighten.
  const scopedIndexes = new Map();
  const scopeKey = (scope) => scope.join('|');
  for (const w of writeups) {
    if (!w.artifacts || scopedIndexes.has(scopeKey(w.artifacts))) continue;
    const rounded = new Map();
    const exp = new Map();
    for (let d = MIN_PLACES; d <= MAX_PLACES; d += 1) rounded.set(d, new Set());
    for (let p = 0; p <= MAX_PLACES; p += 1) exp.set(p, new Set());
    scopedIndexes.set(scopeKey(w.artifacts), {
      rounded,
      exp,
      files: artifactFiles.filter((f) => matchesScope(path.relative(REPO_ROOT, f), w.artifacts)),
      values: 0
    });
  }

  for (const file of artifactFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const inScopes = [...scopedIndexes.values()].filter((sc) => sc.files.includes(file));
    for (const dec of decimalsIn(text)) {
      const value = Number(dec.token);
      if (!Number.isFinite(value)) continue;
      artifactValues += 1;
      for (let d = MIN_PLACES; d <= MAX_PLACES; d += 1) roundedIndex.get(d).add(value.toFixed(d));
      for (let p = 0; p <= MAX_PLACES; p += 1) expIndex.get(p).add(value.toExponential(p));
      for (const sc of inScopes) {
        sc.values += 1;
        for (let d = MIN_PLACES; d <= MAX_PLACES; d += 1) sc.rounded.get(d).add(value.toFixed(d));
        for (let p = 0; p <= MAX_PLACES; p += 1) sc.exp.get(p).add(value.toExponential(p));
      }
    }
  }

  // --- check every writeup --------------------------------------------------
  const failures = [];
  const gapsHit = new Map();
  let checked = 0;
  let allowed = 0;
  let illustrative = 0;

  // ABSENT WRITEUPS ARE COLLECTED, NOT SILENTLY SKIPPED. Four of this list are
  // gitignored, so a fresh clone — which is what CI checks out — has only the
  // published ones and this check runs at a fraction of its local coverage. It
  // used to `continue` here and still print "PASS", with the drop visible only
  // to a reader who knew the local writeup count by heart. check:blocks hits
  // the identical condition and DECLARES it ("RULE 3 DID NOT RUN, AND THAT IS
  // DECLARED RATHER THAN SILENT"); this now does the same. It is deliberately
  // NOT a failure: the documents cannot be in CI and are not meant to be.
  const absentWriteups = [];

  for (const { file: rel, artifacts: scope } of writeups) {
    // A scoped writeup checks against ONLY its own artifacts. Unscoped ones use
    // the global index, exactly as every writeup did before scoping existed.
    const { rounded: idxRounded, exp: idxExp } =
      indexForWriteup(scope, scopedIndexes, { rounded: roundedIndex, exp: expIndex });
    const file = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(file)) {
      absentWriteups.push(rel);
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const lineStarts = [];
    for (let i = 0; i < text.length; i += 1) if (i === 0 || text[i - 1] === '\n') lineStarts.push(i);
    const lineOf = (index) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    };

    for (const dec of decimalsIn(text)) {
      // Scientific notation is normalised through Number(), so its place count
      // is not the literal's — skip the place filter and check the value.
      const places = dec.exp === null ? dec.frac.length : null;
      if (places !== null && places < MIN_PLACES) continue;
      if (places !== null && places > MAX_PLACES) continue;
      checked += 1;

      const normalised = places === null ? dec.token : `${dec.intPart}.${dec.frac}`;
      if (ALLOWED.has(normalised) || ALLOWED.has(dec.token)) { allowed += 1; continue; }
      if (ILLUSTRATIVE.has(normalised) || ILLUSTRATIVE.has(dec.token)) { illustrative += 1; continue; }
      if (GAPS.has(normalised) || GAPS.has(dec.token)) {
        const key = GAPS.has(normalised) ? normalised : dec.token;
        gapsHit.set(key, (gapsHit.get(key) || 0) + 1);
        continue;
      }

      let ok = false;
      if (places === null) {
        // EXPONENT FORM. This branch used to accept only if the value appeared
        // in an artifact at some precision — an EXACT-VALUE test — while this
        // file's whole stated rule is that a d-place claim must be the correct
        // ROUNDING to d places of an artifact value. The two disagree, and the
        // disagreement was invisible because the only exponent claims in the
        // writeups were on the GAPS list and never reached here.
        //
        // Found at 3.7 while closing 3.73e7: the artifact analyse:vocab now
        // writes says 3.7279e+7, of which 3.73e7 is the correct rounding to two
        // mantissa places — and the old branch rejected it, so the gap would
        // have survived the very artifact written to close it. A tool stricter
        // than its own documented rule fails claims that obey the rule, which
        // is the failure mode that gets a check switched off.
        //
        // The mantissa's place count is the claim's precision, so the test is
        // the same test the decimal branch runs, in exponential space.
        const p = dec.frac.length;
        if (p <= MAX_PLACES) ok = idxExp.get(p).has(Number(dec.token).toExponential(p));
      } else {
        ok = idxRounded.get(places).has(Number(dec.token).toFixed(places));
      }
      if (!ok) {
        const line = lineOf(dec.index);
        failures.push({ file: rel, line, token: dec.token, places });
      }
    }
  }

  // --- report ---------------------------------------------------------------
  console.log('check:claims — every decimal of 4+ places in the writeups must be the');
  console.log('correct rounding of a decimal in a committed artifact.\n');
  console.log(`  writeups        ${writeups.length - absentWriteups.length} of ${writeups.length}`);
  console.log(`  artifacts       ${artifactFiles.length} files, ${artifactValues} decimals indexed`);
  // SCOPED WRITEUPS ARE REPORTED, because a narrower index is a narrower claim
  // and a reader should be able to see which documents got one. Silence here
  // would be the same defect the PARTIAL RUN block was added to fix.
  for (const w of writeups) {
    if (!w.artifacts) continue;
    const sc = scopedIndexes.get(w.artifacts.join('|'));
    console.log(`  scoped          ${w.file} -> ${w.artifacts.join(', ')}  (${sc.files.length} files, ${sc.values} decimals)`);
  }
  console.log(`  decimals checked ${checked}`);
  console.log(`    structural      ${allowed}   arithmetic on a protocol constant`);
  console.log(`    illustrative    ${illustrative}   invented figures in format examples`);
  console.log('');
  if (absentWriteups.length > 0) {
    console.log('  PARTIAL RUN — DECLARED RATHER THAN SILENT.');
    console.log('  These writeups are gitignored by design and are absent here, so not one');
    console.log('  of their decimals was checked:\n');
    for (const rel of absentWriteups) console.log(`    ${rel}`);
    console.log('');
    console.log(`  So "${checked} decimals checked" is the coverage of this run, not of the`);
    console.log('  document set. A fresh clone and CI both land here. That is expected —');
    console.log('  the absent files hold personal career material and are never published —');
    console.log('  but it means a green step in CI is a much weaker claim than the same');
    console.log('  step locally, and the count above is the only place that shows it.');
    console.log('  Run with docs/ present for full coverage.');
    console.log('');
  }
  if (gapsHit.size > 0) {
    console.log('  KNOWN GAPS — correct, measured, and written by no script. Reported every');
    console.log('  run rather than suppressed. Not failures: the fix is a writer on a');
    console.log('  read-only analysis script, which is its own task.');
    for (const [value, count] of gapsHit) {
      console.log(`    ${value.padEnd(9)} x${count}  ${GAPS.get(value)}`);
    }
    console.log('');
  }

  if (failures.length === 0) {
    console.log(
      absentWriteups.length > 0
        ? `  PASS (PARTIAL) — every checked decimal traces to an artifact, over ${writeups.length - absentWriteups.length} of ${writeups.length} writeups.`
        : '  PASS — every checked decimal traces to an artifact.'
    );
    return;
  }

  const byFile = new Map();
  for (const f of failures) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  console.log(`  FAIL — ${failures.length} decimal(s) appear in no artifact:\n`);
  for (const [file, rows] of byFile) {
    console.log(`  ${file}`);
    const shown = args.verbose ? rows : rows.slice(0, 25);
    for (const r of shown) console.log(`    :${String(r.line).padStart(6)}  ${r.token}`);
    if (rows.length > shown.length) console.log(`    ... and ${rows.length - shown.length} more (--verbose)`);
    console.log('');
  }
  console.log('  Either the figure is wrong, or the artifact that would justify it was');
  console.log('  never written. Both are worth stopping for. If the number is genuinely');
  console.log('  structural — arithmetic on alpha, say — add it to ALLOWED with a reason.');
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\ncheck:claims failed: ${err.message}`);
    if (!err.assertion) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { decimalsIn, WRITEUPS, normaliseWriteups, indexForWriteup, matchesScope };
