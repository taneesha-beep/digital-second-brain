'use strict';

/**
 * The decimal scanner behind `npm run check:claims` (3.6).
 *
 * The check is only as good as what it SEES, and the first draft of this regex
 * had a silent blind spot that a reading of the code would not have found: the
 * trailing lookahead was `(?![\d.])`, which rejects a following period
 * unconditionally, so a figure at the END OF A SENTENCE never matched. In a
 * prose document that is most figures. It was caught by probing the tool with a
 * value it should have rejected and watching it pass.
 *
 * So the sentence-final case is the first test here, not an afterthought — a
 * checker that silently skips its inputs is worse than no checker, because it
 * reports PASS.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  decimalsIn, WRITEUPS, normaliseWriteups, indexForWriteup, matchesScope
} = require('../scripts/check-claims');

const REPO = path.resolve(__dirname, '..', '..');

const tokens = (s) => decimalsIn(s).map((d) => d.token);

describe('decimalsIn — what the checker can see', () => {
  test('THE BLIND SPOT: a decimal ending a sentence is found', () => {
    expect(tokens('The file says 0.310689.')).toEqual(['0.310689']);
    expect(tokens('nDCG@8 0.3269, and P@8 0.0854.')).toEqual(['0.3269', '0.0854']);
  });

  test('a decimal in the middle of a sentence is found', () => {
    expect(tokens('by 0.0351 nDCG@8 over v3')).toEqual(['0.0351']);
  });

  test('bracketed and parenthesised forms are found', () => {
    expect(tokens('CI [-0.025316, -0.005800].')).toEqual(['0.025316', '0.005800']);
    expect(tokens('(0.311965).')).toEqual(['0.311965']);
  });

  test('a version number yields NO decimal, at either end', () => {
    // The reason the lookbehind and lookahead exist at all. `25.8` inside
    // v25.8.1 is not a measurement and must not be checked as one.
    expect(tokens('Node v25.8.1 on darwin')).toEqual([]);
    expect(tokens('transformers.js 4.2.0, onnxruntime-node 1.24.3.')).toEqual([]);
  });

  test('scientific notation is one token, not two', () => {
    expect(tokens('max |delta| 1.11e-16 over the run.')).toEqual(['1.11e-16']);
    expect(tokens('the bound rises to 8.12e8.')).toEqual(['8.12e8']);
  });

  test('a section reference is found but is under the place threshold', () => {
    // Deliberately still matched rather than special-cased: it is the MIN_PLACES
    // filter downstream that excludes it, which is the mechanism the docstring
    // claims. If this regex started skipping "17.8" the exclusion would be
    // happening in two places and only one would be documented.
    const found = decimalsIn('See §17.8 and §5.1.');
    expect(found.map((d) => d.token)).toEqual(['17.8', '5.1']);
    expect(found.every((d) => d.frac.length < 4)).toBe(true);
  });

  test('a date is not a decimal', () => {
    expect(tokens('Resolved 9 Aug 2026 at 3.6, see 2026-08-09.')).toEqual(['3.6']);
  });

  test('adjacent decimals separated by a dash are both found', () => {
    expect(tokens('the 0.1-0.4 plausibility band.')).toEqual(['0.1', '0.4']);
  });

  test('place counts are reported from the literal, not from the parsed value', () => {
    // 0.3100 and 0.31 are the same number and NOT the same claim: the first
    // asserts four places of precision. The checker tests the literal at its
    // own stated precision, so the place count has to come from the text.
    const [a] = decimalsIn('0.3100');
    const [b] = decimalsIn('0.31');
    expect(a.frac.length).toBe(4);
    expect(b.frac.length).toBe(2);
  });

  test('an integer alone is not a decimal', () => {
    expect(tokens('27,325 documents and 2,304 queries.')).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PER-WRITEUP ARTIFACT SCOPING — the pre-Phase-8 sweep, 27 Aug 2026.
// ───────────────────────────────────────────────────────────────────────────

describe('artifact scoping — what a PUBLISHED table is allowed to trace to', () => {
  /**
   * THE PROBLEM, MEASURED AT 8.1 AND RE-MEASURED HERE. The global artifact
   * index is every tracked file under results/, and results/sweeps/*.csv holds
   * thousands of BM25 grid points clustering exactly where real nDCG figures
   * live. So across the plausibility band [0.0500, 0.4500], 1513 of 4001
   * four-place slots were already justified by SOMETHING — 37.8% — and
   * `0.3197 -> 0.3198` passed on an unrelated sweep row.
   *
   * Scoping README to the sidecars and the ladder writeup takes that to 9.0%.
   * It does NOT take it to zero, and tests/readme-results-table.test.js remains
   * the guard that catches a MISPLACED figure. These are complements.
   */
  const normalised = normaliseWriteups(WRITEUPS);
  const readme = normalised.find((w) => w.file === 'README.md');

  test('README is the ONLY scoped writeup, and it is scoped to the right two paths', () => {
    // Scoping the gitignored planning documents would be answering the wrong
    // question — they are read by one person with the whole tree on disk.
    const scoped = normalised.filter((w) => w.artifacts);
    expect(scoped.map((w) => w.file)).toEqual(['README.md']);
    expect(readme.artifacts).toEqual(['results/runs/', 'results/test-ladder.txt']);
  });

  test('normaliseWriteups gives one shape, and leaves plain entries unscoped', () => {
    // The compatibility property: every entry that was a string still checks
    // against the global index, exactly as before scoping existed.
    for (const w of normalised) {
      expect(typeof w.file).toBe('string');
      if (w.file !== 'README.md') expect(w.artifacts).toBeNull();
    }
    expect(normaliseWriteups(['a.md'])).toEqual([{ file: 'a.md', artifacts: null }]);
    expect(normaliseWriteups([{ file: 'b.md', artifacts: ['x/'] }]))
      .toEqual([{ file: 'b.md', artifacts: ['x/'] }]);
  });

  test('the scope resolves to real, TRACKED artifacts — not an empty set', () => {
    // A scope naming nothing would make README's every decimal fail, or — if
    // the lookup were lenient — check nothing at all. Either way the count is
    // the thing that says so.
    const tracked = execFileSync('git', ['ls-files', 'results'], { cwd: REPO, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    const inScope = tracked.filter((f) => matchesScope(f, readme.artifacts));
    expect(inScope.length).toBeGreaterThan(10);
    expect(inScope.some((f) => f.startsWith('results/runs/'))).toBe(true);
    expect(inScope).toContain('results/test-ladder.txt');
  });

  test('THE CONTAINMENT PROPERTY: the scope is a strict SUBSET of the global index', () => {
    // What makes scoping safe to bolt onto an existing checker — it can only
    // ever TIGHTEN. If a scope could name a file outside the artifact roots, a
    // scoped writeup could pass something the global check would refuse, and
    // the tool would be weaker in one place while looking stricter everywhere.
    const tracked = execFileSync('git', ['ls-files', 'results'], { cwd: REPO, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    const inScope = tracked.filter((f) => matchesScope(f, readme.artifacts));
    for (const f of inScope) expect(tracked).toContain(f);
    expect(inScope.length).toBeLessThan(tracked.length);
  });

  test('and it MEASURABLY narrows the band — 37.8% global against 9.0% scoped', () => {
    // The number that justified building this, recomputed rather than quoted.
    // If it ever stops holding, the scope has drifted and the entry's comment
    // is describing a reduction that no longer happens.
    const EXT = new Set(['.txt', '.json', '.csv', '.md']);
    const build = (files) => {
      const idx = new Set();
      for (const rel of files) {
        const f = path.join(REPO, rel);
        if (!EXT.has(path.extname(rel)) || !fs.existsSync(f)) continue;
        for (const d of decimalsIn(fs.readFileSync(f, 'utf8'))) {
          const v = Number(d.token);
          if (Number.isFinite(v)) idx.add(v.toFixed(4));
        }
      }
      return idx;
    };
    const tracked = execFileSync('git', ['ls-files', 'results'], { cwd: REPO, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    const inScope = tracked.filter((f) => matchesScope(f, readme.artifacts));

    const band = [];
    for (let v = 500; v <= 4500; v += 1) band.push((v / 10000).toFixed(4));
    const globalIdx = build(tracked);
    const scopedIdx = build(inScope);
    const globalHit = band.filter((x) => globalIdx.has(x)).length / band.length;
    const scopedHit = band.filter((x) => scopedIdx.has(x)).length / band.length;

    expect(globalHit).toBeGreaterThan(0.30);          // it really is that permissive
    expect(scopedHit).toBeLessThan(0.15);             // and scoping really does narrow it
    expect(scopedHit).toBeLessThan(globalHit / 2);    // by more than a factor of two
  });

  // ── THE WIRING, WHICH THE TESTS ABOVE DO NOT REACH ──────────────────────
  //
  // A mutation replacing the binding with "always use the global index" left
  // every assertion above GREEN and the checker green: they assert the scope's
  // PATHS and the measured narrowing, and none of them proves a scoped writeup
  // USES the narrow index. Third time in this sweep that a join needed its own
  // test after its parts each had one.

  const GLOBAL = { rounded: new Map([[4, new Set(['0.9999'])]]), exp: new Map() };
  const SCOPED = { rounded: new Map([[4, new Set(['0.1111'])]]), exp: new Map() };
  const registry = new Map([['results/runs/', { rounded: SCOPED.rounded, exp: SCOPED.exp }]]);

  test('matchesScope: a trailing slash is a directory, anything else is exact', () => {
    // Shares the predicate with the checker rather than reimplementing it —
    // a mutation making it match everything survived while the test had its own
    // copy, because the copy agreed with the test's own expectations.
    expect(matchesScope('results/runs/x.run.json', ['results/runs/'])).toBe(true);
    expect(matchesScope('results/test-ladder.txt', ['results/test-ladder.txt'])).toBe(true);
    expect(matchesScope('results/sweeps/v4-bm25-params.csv', ['results/runs/'])).toBe(false);
    // The near-miss an exact match must refuse: a prefix without a trailing
    // slash must not scope in a longer filename that merely starts with it.
    expect(matchesScope('results/test-ladder.txt.bak', ['results/test-ladder.txt'])).toBe(false);
    expect(matchesScope('results/runsaway.txt', ['results/runs/'])).toBe(false);
  });

  test('WIRING: an unscoped writeup gets the GLOBAL index', () => {
    expect(indexForWriteup(null, registry, GLOBAL)).toBe(GLOBAL);
  });

  test('WIRING: a scoped writeup gets its OWN index, not the global one', () => {
    const got = indexForWriteup(['results/runs/'], registry, GLOBAL);
    expect(got.rounded.get(4).has('0.1111')).toBe(true);
    // The mutation this exists for: if it returned the global index, this would
    // be true and a sweep-CSV value would justify a README figure again.
    expect(got.rounded.get(4).has('0.9999')).toBe(false);
  });

  test('WIRING: a scope with no index THROWS rather than falling back', () => {
    // Falling back to the global index would silently restore exactly the
    // permissiveness the scope was added to remove — a configuration error
    // presenting as a quieter check rather than as an error.
    expect(() => indexForWriteup(['results/never/'], registry, GLOBAL))
      .toThrow(/no index built for scope/);
  });

  test('9.0% IS NOT 0% — the scope is a narrowing, not a guarantee', () => {
    // Stated as an assertion so nobody reads the entry's comment as claiming
    // more than it does. readme-results-table.test.js is what catches a figure
    // in the WRONG CELL, which no index over values can do.
    expect(fs.existsSync(path.join(__dirname, 'readme-results-table.test.js'))).toBe(true);
  });
});
