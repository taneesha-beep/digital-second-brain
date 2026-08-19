'use strict';

/**
 * gen-shipped-parity.test.js — Phase 5.3, REVISED AT 5.5.
 *
 * `scripts/lib/llm-v1-shipped.js` is a FROZEN COPY of the generation call as it
 * shipped before Phase 5.5. This is the check on what it is a copy OF.
 *
 * ---------------------------------------------------------------------------
 * IT WENT RED AT 5.5 EXACTLY AS DESIGNED, AND THE FIX IS NOT "LOOSEN IT"
 * ---------------------------------------------------------------------------
 *
 * 5.3 wrote: "THIS TEST IS DESIGNED TO GO RED AT 5.5 ... When it goes red, DO
 * NOT EDIT llm-v1-shipped.js. It is frozen — it is the 'before'. Update the
 * expectations here to describe the NEW shipped file."
 *
 * It did, on two assertions: the model id (5.0) and `max_tokens` (5.5). The
 * frozen copy is untouched.
 *
 * WHAT THIS FILE NOW ASSERTS IS STRONGER THAN WHAT IT ASSERTED BEFORE, and the
 * difference is the point. Before, it said "the copy matches the shipped file".
 * A file that merely recorded "they now differ" would be weaker than useless —
 * it would pass while the two drifted arbitrarily. So it asserts the SHAPE of
 * the difference:
 *
 *   v1 DIFFERS from the shipped file at EXACTLY TWO constants, named below
 *   with both their old and new values, and
 *   v1 STILL MATCHES it verbatim on everything else — all five prompts, the
 *   system message, the user message template, temperature, the
 *   stripped-feature list and both strip regexes.
 *
 * That is what makes the before/after comparison in §29 a ONE-VARIABLE change
 * rather than a claim about one. A third edit to llm.service.js — a reworded
 * prompt, a moved temperature — turns this file red again, which is correct:
 * it would invalidate the comparison.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STILL SOURCE-TEXT MATCHING FOR THE PROMPTS AND NOT FOR THE REST
 * ---------------------------------------------------------------------------
 *
 * 5.5 exported the constants from llm.service.js, which ROADMAP's 5.2/5.3
 * noticed list asked for ("Exporting them would let the copy import and make
 * the parity test exact rather than source-text"). So the constant assertions
 * below now compare VALUES, which is exact.
 *
 * The source-text assertions are kept anyway, for the prompts and the two strip
 * regexes, because an exported value proves what the module evaluates to and
 * not where it is used. `max_tokens: MAX_TOKENS` appearing in the actual call
 * object is a separate fact from `MAX_TOKENS === 2048`, and only the second is
 * an import. Both are checked.
 */

const fs = require('fs');
const path = require('path');

const shippedV1 = require('../scripts/lib/llm-v1-shipped');
const live = require('../services/llm.service');
const { SCHEMAS } = require('../scripts/lib/gen-schema');

const SERVICE = path.join(__dirname, '..', 'services', 'llm.service.js');
const source = fs.readFileSync(SERVICE, 'utf8');

describe('the shipped file is where this test thinks it is', () => {
  test('it is readable and is the module it claims to be', () => {
    // A missing file read as '' would make every `toContain` below vacuous —
    // the check would pass having asserted nothing, which is §26.7's defect.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('exports.processNote');
  });

  test('it exports the constants a check needs to read', () => {
    // NOTHING IN THIS REPOSITORY READ THE MODEL STRING BEFORE 5.0, which is
    // why its retirement went unnoticed for an unknown number of days. These
    // exports are what `npm run gen:probe` and gen-model-resolves.test.js read.
    expect(typeof live.MODEL).toBe('string');
    expect(typeof live.MAX_TOKENS).toBe('number');
    expect(typeof live.TEMPERATURE).toBe('number');
    expect(Object.keys(live.PROMPTS).sort())
      .toEqual(['concepts', 'eli5', 'examQs', 'flashcards', 'summarize']);
  });
});

// ---------------------------------------------------------------------------
// THE TWO CONSTANTS THAT MOVED — named with both values, so neither side can
// drift without this going red.
// ---------------------------------------------------------------------------

describe('v1 differs from the shipped file at exactly two constants', () => {
  test('PHASE 5.0 — the model, because the old one stopped existing', () => {
    expect(shippedV1.MODEL).toBe('llama-3.3-70b-versatile');
    expect(live.MODEL).toBe('openai/gpt-oss-120b');
    expect(live.MODEL).not.toBe(shippedV1.MODEL);
    expect(source).toContain(`const MODEL = '${live.MODEL}';`);

    // The retired string must NOT survive anywhere in the shipped file. Leaving
    // it in a comment would be harmless; leaving it in a code path would mean
    // the app still asks for a 404.
    expect(source).not.toContain(`const MODEL = '${shippedV1.MODEL}'`);
  });

  test('PHASE 5.5 — max_tokens, which is the one experimental variable', () => {
    expect(shippedV1.MAX_TOKENS).toBe(1024);
    expect(live.MAX_TOKENS).toBe(2048);
    expect(source).toContain(`const MAX_TOKENS = ${live.MAX_TOKENS};`);
    // ...and that it is the value actually handed to the API, which an export
    // alone does not establish.
    expect(source).toContain('max_tokens: MAX_TOKENS');
  });
});

// ---------------------------------------------------------------------------
// EVERYTHING ELSE, WHICH DID NOT MOVE. This is the half that makes §29's
// before/after a one-variable comparison.
// ---------------------------------------------------------------------------

describe('v1 still matches the shipped file everywhere else', () => {
  test.each(Object.keys(shippedV1.PROMPTS))('prompt %s is unchanged', (feature) => {
    expect(live.PROMPTS[feature]).toBe(shippedV1.PROMPTS[feature]);
    expect(source).toContain(shippedV1.PROMPTS[feature]);
  });

  test('the copy holds all five features and no more', () => {
    expect(Object.keys(shippedV1.PROMPTS).sort())
      .toEqual(['concepts', 'eli5', 'examQs', 'flashcards', 'summarize']);
  });

  test('the system message is unchanged', () => {
    expect(live.SYSTEM_MESSAGE).toBe(shippedV1.SYSTEM_MESSAGE);
    // Split across two string literals in the source, so the concatenated form
    // is not in it. Both halves are.
    expect(source).toContain('You are a helpful study assistant. Follow the user instructions exactly. ');
    expect(source).toContain('When asked for JSON, return ONLY the JSON array — no extra text, no markdown fences.');
  });

  test('temperature is unchanged', () => {
    expect(live.TEMPERATURE).toBe(shippedV1.TEMPERATURE);
    expect(live.TEMPERATURE).toBe(0.4);
    expect(source).toContain('temperature: TEMPERATURE,');
  });

  test('the user message template is unchanged', () => {
    expect(source).toContain('content: `${prompt}\\n\\nNotes:\\n${contentText}`');
  });

  test('the stripped feature list is unchanged', () => {
    expect(live.STRIPPED_FEATURES).toEqual(shippedV1.STRIPPED_FEATURES);
    expect(live.STRIPPED_FEATURES).toEqual(['flashcards', 'concepts', 'examQs']);
  });

  test('both strip regexes are unchanged — §28.4 measured this defect firing ZERO times', () => {
    // Kept rather than removed. 5.5 was shaped around "the strip is a repair,
    // not a contract", and §28.4 measured it firing 0 times in 90 JSON calls —
    // so there was nothing to repair and removing it would have been a change
    // no number asked for. It stays, unmeasured-but-inert, until something
    // counts it above zero.
    expect(source).toContain(
      "rawText.replace(/```json\\s*/gi, '').replace(/```\\s*/gi, '').trim()"
    );
  });
});

// ---------------------------------------------------------------------------
// The frozen copy's own behaviour. UNCHANGED FROM 5.3 — it is the "before" and
// nothing here may move.
// ---------------------------------------------------------------------------

describe('applyShippedStrip reproduces the defect rather than correcting it', () => {
  test('a fenced JSON array is unwrapped', () => {
    const out = shippedV1.applyShippedStrip('```json\n[{"q":"a","a":"b"}]\n```', 'flashcards');
    expect(out).toBe('[{"q":"a","a":"b"}]');
  });

  test('prose features are not stripped at all', () => {
    const text = '```not touched```';
    expect(shippedV1.applyShippedStrip(text, 'summarize')).toBe(text);
    expect(shippedV1.applyShippedStrip(text, 'eli5')).toBe(text);
  });

  // THE UNANCHORED-GLOBAL DEFECT, PINNED RATHER THAN FIXED, IN BOTH COPIES.
  // The regexes have no anchor, so a fence inside a string VALUE is deleted
  // from content. 5.5 did not fix it because §28.4 measured the strip firing
  // zero times — fixing an unmeasured defect is the change nothing asked for.
  test('a fence inside a string value is deleted from CONTENT', () => {
    const raw = '[{"q":"what does ``` mean","a":"a code fence"}]';
    const out = shippedV1.applyShippedStrip(raw, 'flashcards');
    expect(out).toBe('[{"q":"what does mean","a":"a code fence"}]');
    expect(out).not.toBe(raw);
  });

  test('the strip cannot remove a prose preamble', () => {
    const raw = 'Here is the JSON array:\n[{"q":"a","a":"b"}]';
    expect(shippedV1.applyShippedStrip(raw, 'flashcards')).toBe(raw.trim());
  });
});

describe("gen-schema's transcription matches what the prompts actually ask for", () => {
  // gen-schema.js SCHEMAS is transcribed from the prompts by hand. This is what
  // makes it a transcription that was checked rather than trusted — and it now
  // checks against the LIVE prompts, so a reworded prompt breaks it here too.
  test.each(Object.keys(SCHEMAS))('%s — count and keys appear in its own prompt', (feature) => {
    const prompt = live.PROMPTS[feature];
    expect(prompt).toContain(String(SCHEMAS[feature].count));
    for (const key of SCHEMAS[feature].keys) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test('the schema-bearing features are exactly the stripped ones', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([...live.STRIPPED_FEATURES].sort());
  });
});
