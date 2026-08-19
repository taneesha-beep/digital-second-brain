'use strict';

/**
 * gen-shipped-parity.test.js — Phase 5.3.
 *
 * `scripts/lib/llm-v1-shipped.js` is a FROZEN COPY of the generation call in
 * `services/llm.service.js`, cut so the Phase 5 baseline survives 5.5 editing
 * that file. This is the check that the copy is a copy.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PROVED HERE IS WEAKER THAN `parity:v1`, AND THE DIFFERENCE MATTERS
 * ---------------------------------------------------------------------------
 *
 * `parity-v1.js` hashes the OUTPUT of two implementations and requires
 * byte-identity. Nothing like that exists here: two calls to a hosted model on
 * identical input do not agree byte for byte, so there is no output to hash and
 * no equivalent proof to run.
 *
 * What is proved instead is EQUALITY OF EVERY INPUT THE API SEES, by reading
 * `services/llm.service.js` AS SOURCE TEXT and requiring each constant to
 * appear in it verbatim. It covers the five prompts, the system message, the
 * model id, `temperature`, `max_tokens`, which features get stripped, and both
 * strip regexes. It does NOT cover the code around the call — the error
 * mapping at :64-77 is not reproduced and is not measured.
 *
 * WHY SOURCE TEXT RATHER THAN AN IMPORT: `PROMPTS` and `MODEL` are
 * module-local in llm.service.js and exported by nothing. That is a property
 * of the file being copied, not a choice made here, and adding an export to it
 * would be editing the A/B control this whole session exists to leave alone.
 *
 * ---------------------------------------------------------------------------
 * THIS TEST IS DESIGNED TO GO RED AT 5.5, AND THAT IS THE MECHANISM
 * ---------------------------------------------------------------------------
 *
 * 5.5 raises `max_tokens` and adds schema validation. The moment it does, the
 * assertions below fail — and the failure reads "the baseline's frozen copy no
 * longer describes the shipped code", which is exactly what should happen and
 * exactly when. Same device as `tests/edges.canonical.test.js` asserting the
 * PRE-4.1 linker FAILS the save-order check: a test that goes red when the
 * control moves is what stops the control moving silently.
 *
 * WHEN IT GOES RED, DO NOT EDIT llm-v1-shipped.js. It is frozen — it is the
 * "before". Update the expectations here to describe the NEW shipped file and
 * record the pair, the way §7.6 keeps a shipped side and a harness side.
 */

const fs = require('fs');
const path = require('path');

const shipped = require('../scripts/lib/llm-v1-shipped');
const { SCHEMAS } = require('../scripts/lib/gen-schema');

const SERVICE = path.join(__dirname, '..', 'services', 'llm.service.js');
const source = fs.readFileSync(SERVICE, 'utf8');

describe('the frozen copy reproduces every input the API sees', () => {
  test('the source file is where this test thinks it is', () => {
    // A missing file read as '' would make every `toContain` below vacuous —
    // the check would pass having asserted nothing, which is §26.7's defect.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('exports.processNote');
  });

  test.each(Object.keys(shipped.PROMPTS))('prompt %s is verbatim', (feature) => {
    expect(source).toContain(shipped.PROMPTS[feature]);
  });

  test('the copy holds all five features and no more', () => {
    expect(Object.keys(shipped.PROMPTS).sort())
      .toEqual(['concepts', 'eli5', 'examQs', 'flashcards', 'summarize']);
  });

  test('the system message is verbatim', () => {
    // Split across two string literals at llm.service.js:43-45, so the
    // concatenated form is not in the source. Both halves are.
    expect(source).toContain('You are a helpful study assistant. Follow the user instructions exactly. ');
    expect(source).toContain('When asked for JSON, return ONLY the JSON array — no extra text, no markdown fences.');
    expect(shipped.SYSTEM_MESSAGE).toBe(
      'You are a helpful study assistant. Follow the user instructions exactly. ' +
      'When asked for JSON, return ONLY the JSON array — no extra text, no markdown fences.'
    );
  });

  test('the model id is verbatim', () => {
    expect(shipped.MODEL).toBe('llama-3.3-70b-versatile');
    expect(source).toContain(`const MODEL = '${shipped.MODEL}';`);
  });

  test('temperature is verbatim', () => {
    expect(shipped.TEMPERATURE).toBe(0.4);
    expect(source).toContain(`temperature: ${shipped.TEMPERATURE},`);
  });

  // THE DEFECT 5.5 FIXES. When this fails, 5.5 has landed.
  test('max_tokens is 1024, which is llm.service.js:53 and Phase 5 defect 1', () => {
    expect(shipped.MAX_TOKENS).toBe(1024);
    expect(source).toContain(`max_tokens: ${shipped.MAX_TOKENS}`);
  });

  test('the user message template is verbatim', () => {
    expect(source).toContain('content: `${prompt}\\n\\nNotes:\\n${contentText}`');
  });

  test('the stripped feature list is verbatim', () => {
    expect(shipped.STRIPPED_FEATURES).toEqual(['flashcards', 'concepts', 'examQs']);
    expect(source).toContain("['flashcards', 'concepts', 'examQs'].includes(feature)");
  });

  test('both strip regexes are verbatim — llm.service.js:60, Phase 5 defect 2', () => {
    expect(source).toContain(
      "return text.replace(/```json\\s*/gi, '').replace(/```\\s*/gi, '').trim();"
    );
  });
});

describe('applyShippedStrip reproduces the defect rather than correcting it', () => {
  test('a fenced JSON array is unwrapped', () => {
    const out = shipped.applyShippedStrip('```json\n[{"q":"a","a":"b"}]\n```', 'flashcards');
    expect(out).toBe('[{"q":"a","a":"b"}]');
  });

  test('prose features are not stripped at all', () => {
    const text = '```not touched```';
    expect(shipped.applyShippedStrip(text, 'summarize')).toBe(text);
    expect(shipped.applyShippedStrip(text, 'eli5')).toBe(text);
  });

  // THE UNANCHORED-GLOBAL DEFECT, PINNED RATHER THAN FIXED. The regexes have no
  // anchor, so a fence inside a string VALUE is deleted from content. A copy
  // that quietly repaired this would measure a system nobody runs. §25.3's
  // device: pin the behaviour so changing it is deliberate.
  test('a fence inside a string value is deleted from CONTENT', () => {
    const raw = '[{"q":"what does ``` mean","a":"a code fence"}]';
    const out = shipped.applyShippedStrip(raw, 'flashcards');
    expect(out).toBe('[{"q":"what does mean","a":"a code fence"}]');
    expect(out).not.toBe(raw);
  });

  test('the strip cannot remove a prose preamble, which is the gap 5.5 owns', () => {
    const raw = 'Here is the JSON array:\n[{"q":"a","a":"b"}]';
    expect(shipped.applyShippedStrip(raw, 'flashcards')).toBe(raw.trim());
  });
});

describe("gen-schema's transcription matches what the prompts actually ask for", () => {
  // gen-schema.js SCHEMAS is transcribed from llm.service.js:6-11 by hand.
  // This is what makes it a transcription that was checked rather than trusted.
  test.each(Object.keys(SCHEMAS))('%s — count and keys appear in its own prompt', (feature) => {
    const prompt = shipped.PROMPTS[feature];
    expect(prompt).toContain(String(SCHEMAS[feature].count));
    for (const key of SCHEMAS[feature].keys) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test('the schema-bearing features are exactly the stripped ones', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual([...shipped.STRIPPED_FEATURES].sort());
  });
});
