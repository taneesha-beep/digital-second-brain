'use strict';

/**
 * readme-results-table.test.js — Phase 8.1
 *
 * README.md IS THE ONLY PUBLISHED DOCUMENT, AND 8.1 PUT A RESULTS TABLE IN IT.
 * This pins that table to the committed run sidecars.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST AND NOT JUST check:claims
 * ---------------------------------------------------------------------------
 *
 * 8.1 added README.md to check:claims' writeup list, which was the right move
 * and buys much less than it sounds like. That checker asks one question: does
 * this decimal round-match SOME decimal in SOME committed artifact. Its own
 * header says it cannot tell whether the artifact is the RELEVANT one.
 *
 * THAT WEAKNESS WAS MEASURED AT 8.1 RATHER THAN ASSUMED, because two mutations
 * of the new table BOTH SURVIVED the checker on the first try:
 *
 *   0.3197 -> 0.3198   PASSED — 0.319774 sits in results/sweeps/v4-bm25-params.csv
 *   0.2391 -> 0.2394   PASSED — same class of coincidence
 *
 * Sweeping every 4-place slot in the plausibility band [0.0500, 0.4500] against
 * the tracked artifact index: 1510 of 4001 are already justified by something,
 * i.e. 37.7% of wrong values pass, and the two sweep CSVs that dominate that
 * index cluster in exactly the region the real nDCG figures live. So near a
 * true value the real hit rate is worse than 37.7%, not better.
 *
 * So check:claims catches INVENTED DIGITS in the published table and does not
 * catch a MISPLACED or DRIFTED one. This file catches both, by comparing each
 * cell against the specific sidecar it claims to come from.
 *
 * PURE. Reads README.md and results/runs/*.run.json out of the working tree.
 * No database, no network, no key, no precondition — it runs in every
 * environment, including CI.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The six rungs, in the order the README table lists them. The ORDER is part of
// the assertion: the table tells a story that climbs, and a reordering that
// still held correct values would be a different claim.
const RUNGS = [
  'v1-overlap',
  'v2-jaccard',
  'v3-tfidf',
  'v4-bm25',
  'v5-embeddings',
  'v6-hybrid'
];

// The HELD-OUT split. README says "held-out" above the table; quoting dev
// figures under that sentence is the exact defect this file exists to make
// impossible, so the split is named here rather than inferred.
const SPLIT = 'test';

function readme() {
  return fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
}

function sidecar(rung, split) {
  const p = path.join(REPO_ROOT, 'results', 'runs', `${rung}.${split}.run.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Pull the results table out of README as { rung: {ndcg, p} } of STRINGS.
 *
 * Strings rather than numbers on purpose: "0.3100" and "0.31" are the same
 * number and not the same claim, and the table asserts four places. Comparing
 * parsed floats would silently accept a row that dropped a digit.
 */
function tableRows(md) {
  const rows = {};
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | <retriever> | <how it scores> | <nDCG@8> | <P@8> |
    if (cells.length !== 6) continue;
    const m = cells[1].match(/^`(v\d-[a-z0-9]+)`$/);
    if (!m) continue;
    const strip = (c) => c.replace(/\*/g, '').trim();
    rows[m[1]] = { ndcg: strip(cells[3]), p: strip(cells[4]), order: Object.keys(rows).length };
  }
  return rows;
}

describe('README results table — every cell traces to its own run sidecar', () => {
  const rows = tableRows(readme());

  test('the table lists exactly the six rungs, in ladder order', () => {
    expect(Object.keys(rows)).toEqual(RUNGS);
  });

  describe.each(RUNGS)('%s', (rung) => {
    test('nDCG@8 is the 4-place rounding of this rung\'s held-out sidecar', () => {
      const truth = sidecar(rung, SPLIT).metrics.ndcg['8'];
      expect(rows[rung].ndcg).toBe(truth.toFixed(4));
    });

    test('P@8 is the 4-place rounding of this rung\'s held-out sidecar', () => {
      const truth = sidecar(rung, SPLIT).metrics.p['8'];
      expect(rows[rung].p).toBe(truth.toFixed(4));
    });
  });

  // POSITIVE CONTROL. The two tests above would also pass if dev and test
  // happened to agree, which would make them assert nothing about the SPLIT.
  // results/test-ladder.txt records that every rung scores lower on test, so
  // the two splits are distinguishable at four places for all six — assert
  // that, so "held-out" in the README sentence is load-bearing rather than
  // decorative.
  test('dev and test differ at four places for every rung, so the split is a real claim', () => {
    for (const rung of RUNGS) {
      const dev = sidecar(rung, 'dev').metrics.ndcg['8'].toFixed(4);
      const test_ = sidecar(rung, SPLIT).metrics.ndcg['8'].toFixed(4);
      expect(dev).not.toBe(test_);
    }
  });

  // The README sentence above the table says these are the held-out figures.
  // A checker cannot read that sentence; this asserts the word is still there,
  // so removing it turns something red rather than quietly changing the claim.
  test('README still describes the table as the held-out split', () => {
    expect(readme()).toMatch(/\*\*held-out\*\* split/);
  });
});
