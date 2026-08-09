#!/usr/bin/env node
'use strict';

/**
 * holm.js — Phase 3.6
 *
 *   cd backend && npm run holm
 *
 * Closes the pre-registered family and applies Holm-Bonferroni to it.
 *
 * WHY THIS IS A SCRIPT AND NOT SEVEN NUMBERS TYPED INTO A DOCUMENT. §11.5 puts
 * ONE pre-registered metric on each comparison, and compare-runs.js prints that
 * comparison's RAW p because Holm needs every p in the family at once and the
 * family filled up one rung per session across Phase 3. The consequence, on
 * roadmap 3.3's noticed-list, is that the family's p-values are produced one
 * per session and never collected: nothing recomputes them, and a comparison
 * whose run files were regenerated reproduces its p only because the seed is
 * pinned. Roadmap 3.3 asked 3.6 to confirm the family is assembled FROM THE
 * COMMITTED REPORTS rather than re-run, and that the reassembly is itself a
 * script rather than a manual transcription. This is that script.
 *
 * IT READS, IT DOES NOT RUN. Every p here is parsed out of a committed
 * results/comparisons/*.txt. Re-running the bootstraps would be a second source
 * for the same number — §11.1 rejected exactly that, and for the same reason:
 * when the recomputed value and the committed artifact disagree there is no
 * principled way to say which is right. The committed report is the artifact a
 * claim traces to, so the committed report is what gets corrected.
 *
 * THE FAMILY MIXES SPLITS, AND THAT WAS DECIDED RATHER THAN INHERITED. Six of
 * the seven entries are registered on dev; sweep-tuned-vs-shipped is registered
 * on test, deliberately, since 2.7 selected its configuration ON dev. Holm is
 * applied to the family AS REGISTERED. Two reasons, and they are different
 * kinds of reason:
 *
 *   - VALIDITY is not in question. Holm's step-down controls the family-wise
 *     error rate under ARBITRARY dependence among the p-values — unlike
 *     Hochberg or Hommel, it assumes nothing. Members computed on DISJOINT data
 *     are the most benign dependence structure available, not the least.
 *   - SCOPE is the real issue, and it is handled by labelling rather than by
 *     re-registering. "Survives Holm" is a statement about the split each
 *     member was registered on. The five ladder steps were also run on test at
 *     3.6 and report difference + interval with NO p-value, because
 *     compare-runs.js keys the registry on (a, b, split) and correctly refuses
 *     them. Those intervals are real statements about test; they are not
 *     pre-registered tests and they do not enter this family.
 *
 * REJECTED: re-registering the family on test. It requires editing six `split`
 * fields AFTER every dev result is visible. registry.json's own _why says an
 * edit "timestamps the decision"; an edit made with the answers in hand
 * timestamps nothing worth having, and it would retroactively demote five
 * published confirmatory results to descriptive.
 *
 * ALSO REJECTED: two families, dev's six at alpha/6 and test's one at alpha/1.
 * That LOOSENS the bound on the six dev entries from 0.00714 to 0.00833 after
 * the results are in, in the favourable direction, and hands the seventh member
 * an uncorrected alpha = 0.05.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_FILE = path.join(REPO_ROOT, 'results', 'comparisons', 'registry.json');
const OUT_FILE = path.join(REPO_ROOT, 'results', 'holm-family.txt');

function fail(message) {
  const err = new Error(message);
  err.assertion = true;
  throw err;
}

function parseArgs(argv) {
  const args = { write: true };
  for (const flag of argv) {
    if (flag === '--no-write') args.write = false;
    else if (flag.startsWith('--')) throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Reading a p out of a committed report
// ---------------------------------------------------------------------------

/**
 * compare-runs.js prints the primary p in one of three shapes, and all three
 * are load-bearing rather than incidental:
 *
 *   p (two-sided ASL)    0.0482  +/- 0.0021 Monte Carlo      an ordinary value
 *   p (two-sided ASL)    <0.0001  +/- 0.0001 Monte Carlo     AT THE FLOOR
 *   p                    1.0000      every centred resample  the IDENTICAL case
 *
 * The floor is why this cannot be a single regex for a decimal. §11.2 refuses
 * to print p = 0: the ASL uses the (1+r)/(B+1) convention, so the smallest
 * value the statistic can take is 1/(B+1), and the report prints "<0.0001"
 * rather than a resolution B does not have. Holm needs a NUMBER, so the floor
 * is read from the same report — the line that says "floor 0.00010 at B =
 * 10000" — rather than assumed to be 1e-4. Using the floor is conservative in
 * the only direction that matters: the true p is at most the floor, so
 * substituting it can only make a rejection harder to obtain.
 *
 * The third shape is the degenerate case §11.4 describes and §11.2 designed
 * for. When every per-query difference is exactly 0 the centred resample means
 * are all exactly 0, so |mean*| >= |observed| holds for every resample and the
 * ASL is exactly 1. That is not a missing p-value being filled in with a
 * convenient one; it is the ASL definition evaluated on an all-zero vector,
 * which is why §11.2 made the comparison `>=` rather than `>`.
 */
function readPrimaryP(reportFile) {
  if (!fs.existsSync(reportFile)) {
    fail(
      `${path.relative(REPO_ROOT, reportFile)} does not exist.\n` +
      '  The family cannot be closed until every registered comparison has been run\n' +
      '  and its report committed. This script reads reports; it does not run them.'
    );
  }
  const text = fs.readFileSync(reportFile, 'utf8');

  const floorMatch = text.match(/floor\s+([0-9.]+)\s+at B = (\d+)/);
  const atFloor = /^\s+p \(two-sided ASL\)\s+<[0-9.]+/m.test(text);
  const valueMatch = text.match(/^\s+p \(two-sided ASL\)\s+([0-9.]+)/m);
  const identicalMatch = text.match(/^\s+p\s+(1\.0000)\s/m);

  if (atFloor) {
    if (!floorMatch) fail(`${path.relative(REPO_ROOT, reportFile)}: p is at the floor but the floor line is missing.`);
    return {
      p: Number(floorMatch[1]),
      display: `<${floorMatch[1].replace(/0+$/, '')}`,
      shape: 'at the bootstrap floor',
      resamples: Number(floorMatch[2])
    };
  }
  if (valueMatch) {
    return {
      p: Number(valueMatch[1]),
      display: valueMatch[1],
      shape: 'ordinary',
      resamples: floorMatch ? Number(floorMatch[2]) : null
    };
  }
  if (identicalMatch) {
    // Guard the reading rather than trust one regex: the IDENTICAL branch also
    // prints the zero-differing count, and if that line is absent this is some
    // other report shape and the parse is wrong.
    if (!/IDENTICAL — 0 of \d+ queries differ/.test(text)) {
      fail(`${path.relative(REPO_ROOT, reportFile)}: p reads 1.0000 but the IDENTICAL heading is absent.`);
    }
    return { p: 1, display: '1.0000', shape: 'identical runs — ASL is exactly 1 by construction', resamples: null };
  }
  fail(
    `${path.relative(REPO_ROOT, reportFile)}: no primary p-value found.\n` +
    '  A registered comparison must print one. If this report says EXPLORATORY or\n' +
    '  OFF-SPLIT, it was generated for a pair or a split the registry does not\n' +
    '  register, and it is not a member of this family.'
  );
  return null;
}

// ---------------------------------------------------------------------------
// Holm-Bonferroni
// ---------------------------------------------------------------------------

/**
 * Step-down. Sort ascending; the i-th smallest (1-based) is tested against
 * alpha / (m - i + 1); STOP at the first failure and reject nothing after it.
 *
 * The stop is the whole difference from Bonferroni and it is easy to implement
 * wrong by testing each p against its own threshold independently — which would
 * reject a later, larger p after an earlier one failed, and is no longer a
 * valid FWER procedure. Recorded here because the failure is silent: on this
 * family the two give the same answer, so a bug would not show.
 */
function holm(members, alpha) {
  const ordered = [...members].sort((x, y) => x.p - y.p);
  let stopped = false;
  return ordered.map((m, i) => {
    const threshold = alpha / (ordered.length - i);
    if (stopped) return { ...m, step: i + 1, threshold, survives: false, haltedHere: false };
    if (m.p <= threshold) return { ...m, step: i + 1, threshold, survives: true, haltedHere: false };
    stopped = true;
    return { ...m, step: i + 1, threshold, survives: false, haltedHere: true };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(REGISTRY_FILE)) fail(`${path.relative(REPO_ROOT, REGISTRY_FILE)} does not exist.`);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  const alpha = registry.correction.familyWiseAlpha;

  const members = registry.comparisons.map((c) => {
    const reportFile = path.join(REPO_ROOT, 'results', 'comparisons', `${c.a}-vs-${c.b}.${c.split}.txt`);
    const primary = c.primaryMetric || registry.primaryMetric;
    const read = readPrimaryP(reportFile);
    return {
      id: c.id,
      a: c.a,
      b: c.b,
      split: c.split,
      metric: `${primary.metric.toUpperCase()}@${primary.k}`,
      overridden: Boolean(c.primaryMetricOverride),
      report: path.relative(REPO_ROOT, reportFile),
      ...read
    };
  });

  const adjusted = holm(members, alpha);
  const lines = [];
  const w = (s = '') => lines.push(s);
  const thick = '='.repeat(78);
  const thin = '-'.repeat(78);

  w('HOLM-BONFERRONI OVER THE PRE-REGISTERED FAMILY — roadmap 3.6');
  w(thick);
  w();
  w(`  family               ${members.length} comparisons, registered in ${path.relative(REPO_ROOT, REGISTRY_FILE)}`);
  w(`  method               ${registry.correction.method}, family-wise alpha ${alpha}`);
  w(`  smallest threshold   alpha/${members.length} = ${(alpha / members.length).toFixed(5)}`);
  w('  assembled from       the COMMITTED comparison reports, parsed. Nothing re-run.');
  w();
  w('  Six members are registered on dev and one on test. Holm is applied to the');
  w('  family AS REGISTERED. Its step-down controls FWER under ARBITRARY dependence,');
  w('  so members computed on disjoint splits are the most benign case, not a');
  w('  problem — but "survives Holm" is a statement about the split each member was');
  w('  registered on, and the five ladder steps run on test at 3.6 carry intervals');
  w('  and NO p-value, and do not enter this family. See the header of this script');
  w('  for the two rejected alternatives.');
  w();

  w('1. THE FAMILY, AS REGISTERED');
  w(thin);
  w('  id                        A vs B                                split   metric      raw p');
  w('  ' + '-'.repeat(90));
  for (const m of members) {
    w(`  ${m.id.padEnd(24)}  ${`${m.a} vs ${m.b}`.padEnd(36)}  ${m.split.padEnd(6)}  ` +
      `${m.metric.padEnd(9)}  ${m.display.padStart(8)}${m.overridden ? '  (metric overridden, declared in advance)' : ''}`);
  }
  w();
  for (const m of members) {
    if (m.shape !== 'ordinary') w(`  ${m.id}: ${m.shape}`);
  }
  w();

  w('2. THE STEP-DOWN');
  w(thin);
  w('  Sorted ascending. The i-th smallest is tested against alpha/(m-i+1), and the');
  w('  procedure HALTS at the first failure — everything after it is retained');
  w('  regardless of its own p. That halt is the whole difference from Bonferroni.');
  w();
  w('  step  id                        raw p     threshold   verdict');
  w('  ' + '-'.repeat(72));
  for (const m of adjusted) {
    const verdict = m.survives ? 'REJECT H0 — survives' : (m.haltedHere ? 'RETAIN H0 — HALTS HERE' : 'RETAIN H0 — after the halt');
    w(`  ${String(m.step).padStart(4)}  ${m.id.padEnd(24)}  ${m.display.padStart(8)}  ${m.threshold.toFixed(5).padStart(9)}   ${verdict}`);
  }
  w();

  const survivors = adjusted.filter((m) => m.survives);
  w('3. WHAT SURVIVES');
  w(thin);
  w(`  ${survivors.length} of ${members.length} survive Holm at family-wise alpha ${alpha}.`);
  w();
  for (const m of adjusted) {
    w(`  ${m.survives ? '[survives]' : '[retained]'}  ${m.id.padEnd(24)}  ${m.report}`);
  }
  w();
  w('  A survivor is a DIFFERENCE that is real, in either direction. It is not a');
  w('  claim that the difference is large, and it is not a claim about the absolute');
  w('  levels, which remain lower bounds (§5.1) because the key is positive-only.');
  w();

  w('4. ENVIRONMENT');
  w(thin);
  w('  This script does no arithmetic on run files and no resampling. Every p above');
  w('  was produced by backend/eval/bootstrap.js at seed 20260804, B = 10000, and');
  w('  written into a committed report; the only computation here is the sort and');
  w('  the step-down comparison.');
  w();
  w(thick);

  const text = `${lines.join('\n')}\n`;
  console.log(text);
  if (args.write) {
    fs.writeFileSync(OUT_FILE, text);
    console.log(`  written to ${path.relative(REPO_ROOT, OUT_FILE)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\nholm failed: ${err.message}`);
    if (!err.assertion) console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { holm, readPrimaryP };
