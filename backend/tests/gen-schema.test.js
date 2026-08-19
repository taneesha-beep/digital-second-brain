'use strict';

/**
 * gen-schema.test.js — Phase 5.3.
 *
 * The conformance predicate every figure in `results/gen-baseline.txt` is
 * computed by. PURE — no network, no key, no Groq — which is the reason the
 * verdicts live in scripts/lib/gen-schema.js and not inline in the measurement
 * script: a rate produced by a predicate nothing can run is unauditable.
 *
 * Nothing here needs a precondition, so `tests/helpers/preconditions.js` and
 * `tests/ci-scope.test.js` are untouched by Phase 5.3 and CI's promised-skip
 * ledger does not move.
 *
 * ---------------------------------------------------------------------------
 * MUTATION-CHECKED, BECAUSE §26.7 FOUND A CHECK THAT COULD NOT FAIL IN THE FILE
 * WRITTEN TO PREVENT THAT
 * ---------------------------------------------------------------------------
 *
 * Each block below carries at least one case that FAILS under the obvious wrong
 * implementation, and the comment says which wrong implementation. A test whose
 * fixtures all conform proves the predicate returns true, never that it can
 * return false — and this predicate's whole job in Phase 5 is to return false
 * at the right times.
 */

const {
  classify, hasUnterminatedArray, sliceBrackets, elementMatches, SCHEMAS, ALL_FEATURES
} = require('../scripts/lib/gen-schema');

const SIX = JSON.stringify(
  Array.from({ length: 6 }, (_, i) => ({ q: `q${i}`, a: `a${i}` }))
);

describe('the bracket scan is string-aware', () => {
  // A NAIVE COUNTER — one that counts [ and ] without tracking strings —
  // passes the first two and FAILS every case below them. That is the whole
  // reason this block exists: getting it wrong makes `truncated` fire on
  // well-formed JSON and inflates the headline defect of Phase 5.
  test('an unclosed array is unterminated', () => {
    expect(hasUnterminatedArray('[{"q":"a","a":"b"},{"q":"c"')).toBe(true);
  });

  test('a closed array is not', () => {
    expect(hasUnterminatedArray(SIX)).toBe(false);
  });

  test('a bracket inside a string value does not close anything', () => {
    expect(hasUnterminatedArray('[{"q":"serve in a dish[1]","a":"yes"}]')).toBe(false);
  });

  test('an unbalanced bracket inside a string does not open anything', () => {
    expect(hasUnterminatedArray('[{"q":"use a [ here","a":"ok"}]')).toBe(false);
  });

  test('an escaped quote does not end the string', () => {
    expect(hasUnterminatedArray('[{"q":"say \\"hi\\"","a":"ok"}]')).toBe(false);
  });

  test('a response cut off mid-string is unterminated', () => {
    expect(hasUnterminatedArray('[{"q":"how do I braise a')).toBe(true);
  });

  test('prose with no brackets at all is not an unterminated array', () => {
    expect(hasUnterminatedArray('I cannot help with that request.')).toBe(false);
  });
});

describe('element shape is EXACT, not at-least', () => {
  const keys = SCHEMAS.flashcards.keys;

  test('the specified keys pass', () => {
    expect(elementMatches({ q: 'x', a: 'y' }, keys)).toBe(true);
  });

  // A `keys.every(k => k in el)` implementation passes this one, which is the
  // point: a bonus key is a model ignoring "Format exactly".
  test('a bonus key fails', () => {
    expect(elementMatches({ q: 'x', a: 'y', difficulty: 'hard' }, keys)).toBe(false);
  });

  test('a missing key fails', () => {
    expect(elementMatches({ q: 'x' }, keys)).toBe(false);
  });

  test('an empty string value fails', () => {
    expect(elementMatches({ q: 'x', a: '   ' }, keys)).toBe(false);
  });

  test('a non-string value fails', () => {
    expect(elementMatches({ q: 'x', a: 3 }, keys)).toBe(false);
  });

  test('an array is not an element object', () => {
    expect(elementMatches(['x', 'y'], keys)).toBe(false);
  });

  test('null is not an element object', () => {
    expect(elementMatches(null, keys)).toBe(false);
  });
});

describe('sliceBrackets recovers the payload a wrapper repair would', () => {
  test('a prose preamble is sliced away', () => {
    expect(sliceBrackets(`Here is the JSON array:\n${SIX}`)).toBe(SIX);
  });

  test('no brackets yields null rather than an empty string', () => {
    expect(sliceBrackets('sorry, I cannot')).toBeNull();
  });

  test('a closing bracket before an opening one yields null', () => {
    expect(sliceBrackets('] then [')).toBeNull();
  });
});

describe('classify — the three levels are three different verdicts', () => {
  test('a perfect flashcards response passes all three', () => {
    const r = classify(SIX, 'flashcards').schema;
    expect(r.parses).toBe(true);
    expect(r.shape).toBe(true);
    expect(r.cardinality).toBe(true);
    expect(r.items).toBe(6);
    expect(r.cause).toBeNull();
  });

  // CARDINALITY IS NOT A SCHEMA FAILURE. A single boolean would collapse this
  // into "not conforming" and overstate the defect 5.5 is about to fix.
  test('a short array parses and matches shape but fails cardinality', () => {
    const five = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ q: `q${i}`, a: `a${i}` })));
    const r = classify(five, 'flashcards').schema;
    expect(r.parses).toBe(true);
    expect(r.shape).toBe(true);
    expect(r.cardinality).toBe(false);
    expect(r.items).toBe(5);
  });

  test('right JSON, wrong field names — parses, fails shape, cause is element-shape', () => {
    const r = classify('[{"question":"x","answer":"y"}]', 'flashcards').schema;
    expect(r.parses).toBe(true);
    expect(r.shape).toBe(false);
    expect(r.cause).toBe('element-shape');
  });

  test('the same object IS conforming under examQs, so the schemas are not interchangeable', () => {
    const r = classify('[{"question":"x","answer":"y"}]', 'examQs').schema;
    expect(r.shape).toBe(true);
  });

  test('an empty array fails shape rather than passing vacuously', () => {
    const r = classify('[]', 'concepts').schema;
    expect(r.parses).toBe(true);
    expect(r.shape).toBe(false);
  });
});

describe('classify — the failure precedence is the one committed in the header', () => {
  test('truncation', () => {
    expect(classify('[{"q":"a","a":"b"},{"q":"c"', 'flashcards').schema.cause).toBe('truncated');
  });

  test('a prose preamble around a good payload is a wrapper, not a truncation', () => {
    expect(classify(`Here is the JSON array:\n${SIX}`, 'flashcards').schema.cause).toBe('wrapper');
  });

  test('trailing prose after a good payload is a wrapper too', () => {
    expect(classify(`${SIX}\n\nLet me know if you want more!`, 'flashcards').schema.cause).toBe('wrapper');
  });

  // THE PRECEDENCE IS LOAD-BEARING AND THIS IS THE CASE THAT PROVES IT. Both
  // defects are present. Truncation must win, because no wrapper repair
  // recovers a payload the model never finished.
  test('preamble AND truncation together classify as truncated', () => {
    const r = classify('Here is the JSON array:\n[{"q":"a","a":"b"},{"q":"c"', 'flashcards').schema;
    expect(r.cause).toBe('truncated');
  });

  test('an object rather than an array', () => {
    expect(classify('{"q":"a","a":"b"}', 'flashcards').schema.cause).toBe('not-an-array');
  });

  test('a refusal in prose is malformed, not truncated', () => {
    expect(classify('I am not able to generate that.', 'flashcards').schema.cause).toBe('malformed');
  });

  test('empty', () => {
    const r = classify('   ', 'flashcards');
    expect(r.empty).toBe(true);
    expect(r.schema.cause).toBe('empty');
  });
});

describe('fence residue is what the strip LEFT, not what it removed', () => {
  // The strip runs inside llm.service.js and overwrites the pre-strip text, so
  // how often it FIRED is not visible from a post-strip string. This flag is a
  // different and rarer event and the names must not be confused.
  test('a residual fence is flagged', () => {
    expect(classify('```\n[{"q":"a","a":"b"}]', 'flashcards').schema.fenceResidue).toBe(true);
  });

  test('a clean response is not', () => {
    expect(classify(SIX, 'flashcards').schema.fenceResidue).toBe(false);
  });
});

describe('the two prose features have NO schema, and that is null rather than true', () => {
  // Scoring them 100% would invent a ceiling nobody defined and drag every
  // cross-feature mean upward for free.
  test.each(['summarize', 'eli5'])('%s', (feature) => {
    expect(classify('Some perfectly ordinary prose about braising.', feature).schema).toBeNull();
  });

  test('but empty and veryShort are still defined for them', () => {
    expect(classify('', 'eli5').empty).toBe(true);
    expect(classify('Sure!', 'eli5').veryShort).toBe(true);
    expect(classify('x'.repeat(200), 'eli5').veryShort).toBe(false);
  });
});

describe('the feature list matches the shipped one', () => {
  test('five features, three with schemas', () => {
    expect(ALL_FEATURES).toHaveLength(5);
    expect(Object.keys(SCHEMAS).sort()).toEqual(['concepts', 'examQs', 'flashcards']);
  });

  test('an unknown feature throws rather than returning a silent null schema', () => {
    expect(() => classify('x', 'studypack')).toThrow(/unknown feature/);
  });
});
