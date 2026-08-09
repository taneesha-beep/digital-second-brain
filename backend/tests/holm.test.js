'use strict';

/**
 * Holm-Bonferroni step-down, and the p-parsing that feeds it (3.6).
 *
 * Two things are worth testing here and they fail differently.
 *
 * THE STEP-DOWN HALTS, and that halt is the whole difference from Bonferroni.
 * The natural wrong implementation tests every p against its own threshold
 * independently, which rejects a later, larger p after an earlier one has
 * already failed — no longer a valid FWER procedure. On this project's actual
 * family the two implementations agree, so the bug would be invisible in
 * results/holm-family.txt. That is exactly why it is tested on a synthetic
 * family where they disagree.
 *
 * THE PARSER HAS THREE SHAPES TO READ, not one. An ordinary decimal, the
 * "<0.0001" the report prints at the bootstrap floor (§11.2 refuses to print
 * p = 0), and the "1.0000" of the IDENTICAL degenerate case. A regex for a
 * decimal reads the first and silently mis-reads the other two, and four of
 * this family's seven members sit at the floor.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { holm, readPrimaryP } = require('../scripts/holm');

const ALPHA = 0.05;

describe('holm — the step-down', () => {
  test('the real family: 5 of 7 survive, and v1-v2 is where it halts', () => {
    const family = [
      { id: 'cap-ablation', p: 0.0001 },
      { id: 'ladder-v1-v2', p: 0.0482 },
      { id: 'ladder-v2-v3', p: 0.0001 },
      { id: 'ladder-v3-v4', p: 0.0001 },
      { id: 'ladder-v4-v5', p: 0.0001 },
      { id: 'ladder-v5-v6', p: 0.0015 },
      { id: 'sweep-tuned-vs-shipped', p: 1 }
    ];
    const out = holm(family, ALPHA);
    expect(out.filter((m) => m.survives).map((m) => m.id).sort()).toEqual(
      ['cap-ablation', 'ladder-v2-v3', 'ladder-v3-v4', 'ladder-v4-v5', 'ladder-v5-v6']
    );
    expect(out.find((m) => m.haltedHere).id).toBe('ladder-v1-v2');
    // The smallest threshold is alpha/m, and 0.0015 is tested at step 5 against
    // alpha/3 rather than against alpha/7 — the power Holm buys over Bonferroni.
    expect(out.find((m) => m.id === 'ladder-v5-v6').threshold).toBeCloseTo(0.05 / 3, 12);
    expect(out[0].threshold).toBeCloseTo(0.05 / 7, 12);
  });

  test('THE HALT: a p after a failure is retained even though it clears its own threshold', () => {
    // m = 3, thresholds 0.01667 / 0.025 / 0.05.
    //   step 1  0.02 > 0.01667  -> HALTS
    //   step 3  0.04 <= 0.05    -> would be REJECTED by independent testing
    // So Holm retains all three and Bonferroni-style per-member testing would
    // not. This is the discriminating family; the first draft of this test used
    // one where the two agree, which proved nothing and said so out loud.
    const out = holm([{ id: 'a', p: 0.02 }, { id: 'b', p: 0.03 }, { id: 'c', p: 0.04 }], ALPHA);
    expect(out.map((m) => m.survives)).toEqual([false, false, false]);
    expect(out[0].haltedHere).toBe(true);
    expect(out[2].haltedHere).toBe(false);
    // ...and the last one really does clear its own threshold, so this is a
    // test of the halt and not of an arithmetic accident.
    expect(out[2].p).toBeLessThanOrEqual(out[2].threshold);
  });

  test('input order does not matter — it sorts', () => {
    const shuffled = holm([{ id: 'c', p: 0.9 }, { id: 'a', p: 0.001 }, { id: 'b', p: 0.02 }], ALPHA);
    expect(shuffled.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  test('all significant: every member survives and nothing halts', () => {
    const out = holm([{ id: 'a', p: 0.0001 }, { id: 'b', p: 0.0002 }, { id: 'c', p: 0.0003 }], ALPHA);
    expect(out.every((m) => m.survives)).toBe(true);
    expect(out.some((m) => m.haltedHere)).toBe(false);
  });

  test('none significant: it halts at the first step and rejects nothing', () => {
    const out = holm([{ id: 'a', p: 0.4 }, { id: 'b', p: 0.6 }], ALPHA);
    expect(out.every((m) => !m.survives)).toBe(true);
    expect(out[0].haltedHere).toBe(true);
  });

  test('a family of one is an uncorrected test against alpha', () => {
    expect(holm([{ id: 'a', p: 0.049 }], ALPHA)[0].survives).toBe(true);
    expect(holm([{ id: 'a', p: 0.051 }], ALPHA)[0].survives).toBe(false);
  });

  test('it is never more permissive than Bonferroni, and sometimes less strict', () => {
    const family = [{ id: 'a', p: 0.001 }, { id: 'b', p: 0.006 }, { id: 'c', p: 0.02 }];
    const out = holm(family, ALPHA);
    const bonferroni = family.filter((m) => m.p <= ALPHA / family.length).map((m) => m.id);
    const survivors = out.filter((m) => m.survives).map((m) => m.id);
    for (const id of bonferroni) expect(survivors).toContain(id);
    // Strictly more powerful here. Bonferroni tests every member at alpha/3 =
    // 0.01667, which 0.02 fails. Holm reaches it at step 3, where the threshold
    // is alpha/1 = 0.05, and rejects it.
    expect(survivors).toEqual(['a', 'b', 'c']);
    expect(bonferroni).toEqual(['a', 'b']);
  });
});

describe('readPrimaryP — three shapes, and the floor is not 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holm-parse-'));
  const write = (name, body) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, body);
    return file;
  };

  test('an ordinary decimal', () => {
    const f = write('a.txt', '  p (two-sided ASL)    0.0482  +/- 0.0021 Monte Carlo\n' +
      '                       floor 0.00010 at B = 10000; the bootstrap has no\n');
    expect(readPrimaryP(f).p).toBeCloseTo(0.0482, 12);
    expect(readPrimaryP(f).shape).toBe('ordinary');
  });

  test('AT THE FLOOR: "<0.0001" reads as 1/(B+1), not as 0', () => {
    // §11.2: the ASL uses (1+r)/(B+1), so it cannot be 0 and the report refuses
    // to print a resolution B does not have. Holm needs a number; substituting
    // the floor is conservative, because the true p is at most the floor.
    const f = write('b.txt', '  p (two-sided ASL)    <0.0001  +/- 0.0001 Monte Carlo\n' +
      '                       floor 0.00010 at B = 10000; the bootstrap has no\n');
    const read = readPrimaryP(f);
    expect(read.p).toBeCloseTo(0.0001, 12);
    expect(read.p).toBeGreaterThan(0);
    expect(read.display).toBe('<0.0001');
    expect(read.resamples).toBe(10000);
  });

  test('IDENTICAL runs read as exactly 1', () => {
    const f = write('c.txt', '  IDENTICAL — 0 of 2305 queries differ at nDCG@8.\n\n' +
      '  p                    1.0000      every centred resample mean is exactly\n');
    expect(readPrimaryP(f).p).toBe(1);
  });

  test('a 1.0000 without the IDENTICAL heading is refused, not guessed at', () => {
    const f = write('d.txt', '  p                    1.0000      something else entirely\n');
    expect(() => readPrimaryP(f)).toThrow(/IDENTICAL heading is absent/);
  });

  test('a report with no primary p is refused', () => {
    const f = write('e.txt', '  status               EXPLORATORY — this pair is not in the registry.\n');
    expect(() => readPrimaryP(f)).toThrow(/no primary p-value found/);
  });

  test('a missing report names itself rather than returning nothing', () => {
    expect(() => readPrimaryP(path.join(tmp, 'nope.txt'))).toThrow(/does not exist/);
  });
});
