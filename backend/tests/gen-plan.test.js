'use strict';

/**
 * gen-plan.test.js — the pre-Phase-8 sweep, 27 Aug 2026.
 *
 * PURE. No key, no network, no database, no `data/`. It drives one exported
 * function and never loads a ledger, so it runs in every environment and does
 * not move the promised-skip ledger.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A SUITE FOR ONE FLAG.
 *
 * `npm run gen:v2 -- --take 72` priced the FULL 179-call run, not the 72 asked
 * for. The plan branch returns before run(), and --take was parsed inside
 * run(); one quantity, two readers, and only one of them knew the flag existed.
 *
 * COSMETIC IS THE WRONG WORD FOR IT and the 5.1 noticed list said so at the
 * time: the run itself always honoured --take, so nothing was ever
 * miscounted — but this is the ONE OUTPUT BUILT TO PRICE A PURCHASE, and
 * §29.6's whole argument for gen:quota is that the figure you read immediately
 * before typing --run has to be about the run you are about to make. It priced
 * the wrong thing at exactly the moment it mattered, which is worse than being
 * wrong somewhere nobody looks.
 *
 * The fix is takeLimit() plus plannedCalls(), shared by both readers. This pins
 * both, because a shared helper that one caller stops calling is the same
 * defect wearing a different shape.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ ONE MUTATION SURVIVES THIS SUITE AND IT IS RECORDED RATHER THAN HIDDEN.
 *
 * Deleting the `plannedCalls(remaining, take)` CALL from the plan branch — so
 * it prints `remaining` again — leaves all of these green. Both functions are
 * still correct; main() just stops using one. A unit test cannot reach main().
 *
 * THE OBVIOUS FIX IS THE WRONG ONE. Driving the CLI as a subprocess and reading
 * the printed number would catch it, and it would need `data/gen-eval/
 * clusters.jsonl` — which is TRACKED, so the test would PASS IN CI and FAIL IN
 * THE LOCAL REPRODUCTION OF CI, where §29.11 moves `data/` aside entirely.
 * studypack.context.test.js's header rejects exactly this trade for exactly
 * this reason: "the worst of both". A test that is green on the machine that
 * runs it and red on the machine that reproduces it is not coverage.
 *
 * So the gap is real, bounded and stated: the ARITHMETIC is pinned here, the
 * WIRING is verified by running `npm run gen:v2 -- --take 72` and reading the
 * `would call` line. That was done when this landed — 72 with the call, 179
 * without it.
 */

const { takeLimit, plannedCalls } = require('../scripts/measure-gen-baseline');

/** Run `fn` with process.argv set to `argv`, restoring it afterwards. */
const withArgv = (argv, fn) => {
  const before = process.argv;
  process.argv = ['node', 'measure-gen-baseline.js', ...argv];
  try { return fn(); } finally { process.argv = before; }
};

describe('takeLimit — the flag the plan branch could not see', () => {
  test('absent means null, which the callers read as "no limit"', () => {
    expect(withArgv(['--variant', 'v2'], takeLimit)).toBeNull();
  });

  test('a positive integer comes back as a number, not a string', () => {
    // The plan branch does Math.min(take, remaining) with it. A string "72"
    // would compare by coercion here and concatenate somewhere else, which is
    // the class of defect that only shows up on the day it matters.
    const got = withArgv(['--variant', 'v2', '--take', '72'], takeLimit);
    expect(got).toBe(72);
    expect(typeof got).toBe('number');
  });

  test('it is read the same way whichever side of the other flags it sits', () => {
    expect(withArgv(['--take', '5', '--variant', 'v2'], takeLimit)).toBe(5);
    expect(withArgv(['--variant', 'v2', '--run', '--take', '5'], takeLimit)).toBe(5);
  });

  test('a trailing --take with no value is absent rather than NaN', () => {
    // arg() returns the fallback when the flag is last. Worth pinning: NaN
    // would sail through a `!== null` check and poison Math.min silently.
    expect(withArgv(['--variant', 'v2', '--take'], takeLimit)).toBeNull();
  });

  describe('bad values EXIT rather than coerce', () => {
    // `--take two` silently becoming "the whole run" is §22.6's shape in the
    // one output built to price a purchase: the check runs and cannot fail.
    let exit;
    let err;
    beforeEach(() => {
      exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
      err = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { exit.mockRestore(); err.mockRestore(); });

    test.each([['two'], ['0'], ['-3'], ['1.5'], ['NaN'], ['']])('--take %s is refused', (bad) => {
      expect(() => withArgv(['--take', bad], takeLimit)).toThrow('EXIT');
      expect(exit).toHaveBeenCalledWith(1);
      expect(err.mock.calls[0][0]).toContain('--take must be a positive integer');
    });

    test('the refusal names the value it was given, so the fix is obvious', () => {
      expect(() => withArgv(['--take', 'two'], takeLimit)).toThrow('EXIT');
      expect(err.mock.calls[0][0]).toContain('two');
    });
  });

  test('the exit spy really is what stops it — otherwise the cases above are vacuous', () => {
    // POSITIVE CONTROL. Without process.exit throwing, takeLimit would return
    // and every expect(...).toThrow above would fail for the right reason by
    // accident. This asserts the mechanism rather than the outcome.
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const got = withArgv(['--take', 'two'], takeLimit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(Number.isNaN(got)).toBe(true);   // what it returns when exit does NOT stop it
    exit.mockRestore(); err.mockRestore();
  });
});

describe('plannedCalls — the arithmetic the plan branch prints', () => {
  /**
   * SEPARATE FROM takeLimit FOR A REASON THE MUTATION PASS FOUND. Replacing the
   * plan branch's `Math.min(take, remaining)` with a bare `remaining` left every
   * takeLimit test green — the flag was parsed correctly and simply not USED —
   * and the defect was visible only by running the CLI and reading a number off
   * the screen. Parsing a flag and honouring it are two things, and this is the
   * one that was actually broken.
   */
  test('a --take smaller than what is left buys a prefix', () => {
    expect(plannedCalls(179, 72)).toBe(72);
  });

  test('no --take means the whole remainder — the behaviour before the flag', () => {
    expect(plannedCalls(179, null)).toBe(179);
  });

  test('a --take LARGER than the remainder is not an error, it is the whole run', () => {
    // The runner slices, so asking for more than exists is harmless and should
    // not be dressed up as a mistake. Pinned so a later "validation" does not
    // turn a reasonable invocation into an exit.
    expect(plannedCalls(179, 9999)).toBe(179);
    expect(plannedCalls(179, 179)).toBe(179);
  });

  test('nothing left is zero whatever is asked for', () => {
    expect(plannedCalls(0, null)).toBe(0);
    expect(plannedCalls(0, 50)).toBe(0);
  });

  test('it never returns more than remaining — the property that was violated', () => {
    for (const remaining of [0, 1, 7, 179, 330]) {
      for (const take of [null, 1, 5, 72, 1000]) {
        expect(plannedCalls(remaining, take)).toBeLessThanOrEqual(remaining);
      }
    }
  });
});
