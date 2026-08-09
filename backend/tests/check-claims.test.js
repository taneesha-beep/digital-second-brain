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

const { decimalsIn } = require('../scripts/check-claims');

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
