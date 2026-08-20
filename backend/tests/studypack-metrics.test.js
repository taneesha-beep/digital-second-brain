'use strict';

/**
 * studypack-metrics.test.js — Phase 5.4.
 *
 * PURE: no network, no key, no database, nothing under data/. So it needs no
 * precondition, runs everywhere including CI, and CI's promised-skip ledger
 * does not move. Same position as tests/gen-schema.test.js and
 * tests/studypack.context.test.js.
 *
 * WHAT THIS SUITE IS FOR. §28.4's rates are trusted because the predicate under
 * them runs in `npm test`. 5.4's citation rates need the same footing, and they
 * need it more: schema conformance has `finish_reason` as an independent check
 * (§28.4 records the two agreeing on 90 of 90), and citation support has no
 * second signal at all until 5.6's judge exists.
 */

const metrics = require('../scripts/lib/studypack-metrics');
const studyPack = require('../services/studyPack.service');
const genSchema = require('../scripts/lib/gen-schema');

const {
  SLOTS, SLOT_NAMES, EXPECTED_ITEMS, SUPPORT_THRESHOLD, SUPPORT_CUTS,
  classifyStudyPack, elementMatches, sliceBraces, itemsOf, claimText,
  resolveLabel, containment, scoreCall
} = metrics;

// A conforming pack, built from the spec rather than typed out, so the fixture
// cannot drift from the thing it is a fixture for.
function pack(overrides = {}) {
  const flashcards = Array.from({ length: SLOTS.flashcards.count }, (_, i) => ({
    q: `question ${i}`, a: `answer ${i}`, source: 1
  }));
  const concepts = Array.from({ length: SLOTS.concepts.count }, (_, i) => ({
    term: `term ${i}`, definition: `definition ${i}`, source: 1
  }));
  return JSON.stringify({ flashcards, concepts, ...overrides });
}

const NOTES = [
  { label: 1, noteId: 'n1', title: 'Sourdough hydration', text: 'Higher hydration doughs produce open crumb structure and blistered crust.' },
  { label: 2, noteId: 'n2', title: 'Commercial yeast', text: 'Commercial yeast ferments quickly and yields a milder flavour profile.' },
  { label: 3, noteId: 'n3', title: 'Knife sharpening', text: 'Whetstone grit progression determines the final edge geometry of a blade.' }
];

describe('the transcription is checked against the live prompt, not trusted', () => {
  // tests/gen-schema.test.js established this discipline: SCHEMAS is a hand
  // transcription of llm.service.js's prompts, so it is verified against them.
  // The same hazard exists here — SLOTS is a transcription of buildPrompt() —
  // and it is the hazard that bites silently, because a wrong transcription
  // produces a plausible rate rather than an error.
  const prompt = studyPack.buildPrompt(3);

  test.each(SLOT_NAMES)('%s — its count appears in the prompt', (slot) => {
    expect(prompt).toContain(String(SLOTS[slot].count));
  });

  test.each(SLOT_NAMES)('%s — every key appears in the prompt', (slot) => {
    for (const key of [...SLOTS[slot].stringKeys, ...SLOTS[slot].intKeys]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test('the counts match what the service asks for', () => {
    expect(SLOTS.flashcards.count).toBe(studyPack.FLASHCARD_COUNT);
    expect(SLOTS.concepts.count).toBe(studyPack.CONCEPT_COUNT);
    expect(EXPECTED_ITEMS).toBe(studyPack.FLASHCARD_COUNT + studyPack.CONCEPT_COUNT);
  });

  test('the prompt asks for an OBJECT, which is why gen-schema.js cannot grade it', () => {
    expect(prompt).toContain('JSON object');
    // The five control features all say "JSON array". That single word is the
    // structural difference this file exists for.
    expect(genSchema.SCHEMAS.studyPack).toBeUndefined();
  });
});

describe('gen-schema.js is imported read-only and stays the five control features', () => {
  // §29.4 lists "same grader, gen-schema.js NOT EDITED" as one of four things
  // holding the gen-v1 vs gen-v2 comparison together. This asserts it from the
  // 5.4 side too, so a later session adding a sixth entry breaks TWO suites.
  test('SCHEMAS still holds exactly the three stripped features', () => {
    expect(Object.keys(genSchema.SCHEMAS).sort()).toEqual(['concepts', 'examQs', 'flashcards']);
  });

  test('the string-aware bracket scanner is shared, not reimplemented', () => {
    // One implementation, already carrying gen-schema's tests. §28.11 records a
    // naive counter as the most dangerous mutation of the phase.
    expect(genSchema.hasUnterminatedArray('{"flashcards":[{"q":"a[1]"}]}')).toBe(false);
    expect(genSchema.hasUnterminatedArray('{"flashcards":[{"q":"a"')).toBe(true);
  });
});

describe('classifyStudyPack — the levels', () => {
  test('a conforming pack parses, has shape, and has cardinality', () => {
    const v = classifyStudyPack(pack());
    expect(v).toMatchObject({ parses: true, shape: true, cardinality: true, cause: null });
    expect(v.items).toBe(EXPECTED_ITEMS);
    expect(v.counts).toEqual({ flashcards: 6, concepts: 8 });
  });

  test('CARDINALITY IS NOT A SCHEMA FAILURE — short but well-formed still has shape', () => {
    const short = JSON.stringify({
      flashcards: [{ q: 'q', a: 'a', source: 1 }],
      concepts: [{ term: 't', definition: 'd', source: 1 }]
    });
    const v = classifyStudyPack(short);
    expect(v.shape).toBe(true);
    expect(v.cardinality).toBe(false);
    expect(v.cause).toBeNull();
  });

  test('empty', () => {
    expect(classifyStudyPack('')).toMatchObject({ empty: true, cause: 'empty', parses: false });
    expect(classifyStudyPack('   ')).toMatchObject({ empty: true, cause: 'empty' });
  });

  test('truncated — cut mid-element', () => {
    const cut = pack().slice(0, 120);
    expect(classifyStudyPack(cut).cause).toBe('truncated');
  });

  test('TRUNCATION OUTRANKS THE WRAPPER, which is the committed precedence', () => {
    // Both defects present: a prose preamble AND an unfinished payload. No
    // wrapper repair recovers a payload the model never finished, so the
    // binding defect is truncation.
    const both = `Here is your study pack:\n${pack().slice(0, 120)}`;
    expect(classifyStudyPack(both).cause).toBe('truncated');
  });

  test('THE PRECEDENCE IS OBSERVABLE ONLY HERE, and this pins which way it goes', () => {
    // A COMPLETE payload with an unclosed brace trailing it. This is the only
    // shape where the two orderings disagree: a wrapper repair SUCCEEDS (the
    // outermost span parses) and the string-aware scan ALSO reports something
    // unterminated. Every ordinary truncation — a completion cut mid-string —
    // fails both, so both orderings agree and neither is tested by it.
    //
    // Truncation wins, which is gen-schema.js's committed rule and is the
    // conservative direction: the classifier never calls a payload intact while
    // the scan says a span is open.
    //
    // THE COST, STATED: a complete pack followed by stray text that happens to
    // open a brace is reported as `truncated` when the payload was in fact
    // fine. That is a deliberate consequence, not an accident, and it is the
    // same consequence the three control features already carry.
    const trailing = `${pack()}\n\nLet me know if you want more! {`;
    expect(genSchema.hasUnterminatedArray(trailing)).toBe(true);
    expect(sliceBraces(trailing)).not.toBeNull();
    expect(classifyStudyPack(trailing).cause).toBe('truncated');
  });

  test('wrapper — a prose preamble around an intact payload', () => {
    const v = classifyStudyPack(`Sure! Here you go:\n${pack()}`);
    expect(v.cause).toBeNull();
    expect(v.shape).toBe(true);
    expect(v.usedFallbackParse).toBe(true);
  });

  test('a code fence is recovered and RECORDED rather than absorbed', () => {
    const v = classifyStudyPack('```json\n' + pack() + '\n```');
    expect(v.shape).toBe(true);
    expect(v.fenceResidue).toBe(true);
    expect(v.usedFallbackParse).toBe(true);
  });

  test('not-an-object — an array where an envelope was asked for', () => {
    expect(classifyStudyPack('[{"q":"a","a":"b","source":1}]').cause).toBe('not-an-object');
  });

  test('missing-slot — the envelope is right and a slot is absent', () => {
    const v = classifyStudyPack(JSON.stringify({ flashcards: [{ q: 'q', a: 'a', source: 1 }] }));
    expect(v.cause).toBe('missing-slot');
    expect(v.parses).toBe(true);
    expect(v.counts).toEqual({ flashcards: 1, concepts: null });
  });

  test('missing-slot fires when a slot is present but not an array', () => {
    const v = classifyStudyPack(JSON.stringify({ flashcards: [], concepts: 'none' }));
    expect(v.cause).toBe('missing-slot');
  });

  test('element-shape — the model invented its own field names', () => {
    const v = classifyStudyPack(JSON.stringify({
      flashcards: [{ front: 'q', back: 'a', source: 1 }],
      concepts: [{ term: 't', definition: 'd', source: 1 }]
    }));
    expect(v.cause).toBe('element-shape');
    expect(v.parses).toBe(true);
    expect(v.shape).toBe(false);
  });

  test('malformed is the residue and is reached only when nothing else fits', () => {
    expect(classifyStudyPack('I cannot help with that request.').cause).toBe('malformed');
  });

  test('an empty slot array is NOT shape-conforming', () => {
    // A pack with an empty array is not a short pack, it is a pack with a slot
    // the model declined to fill. Letting it pass would report an empty
    // deliverable as conforming.
    const v = classifyStudyPack(JSON.stringify({ flashcards: [], concepts: [] }));
    expect(v.shape).toBe(false);
    expect(v.cause).toBe('element-shape');
  });
});

describe('elementMatches — exactly the keys, and `source` is an INTEGER', () => {
  const spec = SLOTS.flashcards;

  test('accepts the exact shape', () => {
    expect(elementMatches({ q: 'q', a: 'a', source: 1 }, spec)).toBe(true);
  });

  test('rejects a bonus key — exactly, not at-least', () => {
    expect(elementMatches({ q: 'q', a: 'a', source: 1, note: 'x' }, spec)).toBe(false);
  });

  test('rejects a missing key', () => {
    expect(elementMatches({ q: 'q', source: 1 }, spec)).toBe(false);
  });

  test('rejects an empty string', () => {
    expect(elementMatches({ q: '', a: 'a', source: 1 }, spec)).toBe(false);
    expect(elementMatches({ q: '   ', a: 'a', source: 1 }, spec)).toBe(false);
  });

  test('A STRING `source` FAILS THE SHAPE even though the citation resolves', () => {
    // This is the whole reason gen-schema's elementMatches could not be reused.
    // The service coerces "1" so the citation is valid; the shape is not, and
    // the two facts belong in two columns.
    expect(elementMatches({ q: 'q', a: 'a', source: '1' }, spec)).toBe(false);
    expect(resolveLabel({ source: '1' }, new Map([[1, {}]])).citation).toBe('valid');
  });

  test('a non-integer number fails', () => {
    expect(elementMatches({ q: 'q', a: 'a', source: 1.5 }, spec)).toBe(false);
  });

  test('rejects a non-object', () => {
    expect(elementMatches(null, spec)).toBe(false);
    expect(elementMatches(['q', 'a'], spec)).toBe(false);
    expect(elementMatches('q', spec)).toBe(false);
  });
});

describe('sliceBraces', () => {
  test('takes the outermost span', () => {
    expect(sliceBraces('junk {"a":{"b":1}} junk')).toBe('{"a":{"b":1}}');
  });
  test('returns null when there is no span', () => {
    expect(sliceBraces('no braces here')).toBeNull();
    expect(sliceBraces('} backwards {')).toBeNull();
  });
});

describe('itemsOf and claimText', () => {
  test('flattens both slots, tagged with the slot they came from', () => {
    const items = itemsOf(pack());
    expect(items).toHaveLength(EXPECTED_ITEMS);
    expect(items.filter((i) => i.slot === 'flashcards')).toHaveLength(6);
    expect(items.filter((i) => i.slot === 'concepts')).toHaveLength(8);
  });

  test('returns nothing for unparseable text rather than throwing', () => {
    expect(itemsOf('nonsense')).toEqual([]);
    expect(itemsOf('')).toEqual([]);
  });

  test('skips non-object elements without losing the rest', () => {
    const items = itemsOf(JSON.stringify({ flashcards: ['bad', { q: 'q', a: 'a', source: 1 }], concepts: [] }));
    expect(items).toHaveLength(1);
  });

  test('THE WHOLE ITEM IS THE CLAIM, both fields joined', () => {
    expect(claimText('flashcards', { q: 'why hydration', a: 'open crumb' })).toBe('why hydration open crumb');
    expect(claimText('concepts', { term: 'autolyse', definition: 'a rest period' })).toBe('autolyse a rest period');
  });
});

describe('resolveLabel — three values, never two', () => {
  const labels = new Map([[1, {}], [2, {}]]);
  test('valid', () => expect(resolveLabel({ source: 2 }, labels).citation).toBe('valid'));
  test('out-of-range', () => expect(resolveLabel({ source: 9 }, labels).citation).toBe('out-of-range'));
  test('missing when absent', () => expect(resolveLabel({}, labels).citation).toBe('missing'));
  test('missing when unusable', () => {
    expect(resolveLabel({ source: 'note two' }, labels).citation).toBe('missing');
    expect(resolveLabel({ source: null }, labels).citation).toBe('missing');
  });
});

describe('containment — the proxy, and its arithmetic', () => {
  test('full containment is 1', () => {
    expect(containment(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(1);
  });
  test('half is 0.5', () => {
    expect(containment(new Set(['a', 'b']), new Set(['a', 'z']))).toBe(0.5);
  });
  test('no overlap is 0, NOT null — a paraphrase scores zero and is measurable', () => {
    expect(containment(new Set(['a']), new Set(['z']))).toBe(0);
  });
  test('an empty claim is null, not zero — nothing to measure is not a failure', () => {
    expect(containment(new Set(), new Set(['a']))).toBeNull();
  });
  test('IT IS NOT SYMMETRIC — that is the point, a note is longer than a claim', () => {
    const claim = new Set(['a']);
    const note = new Set(['a', 'b', 'c', 'd']);
    expect(containment(claim, note)).toBe(1);
    expect(containment(note, claim)).toBe(0.25);
  });
});

describe('scoreCall — citations and the null', () => {
  const raw = JSON.stringify({
    flashcards: [
      { q: 'What does higher hydration do?', a: 'It produces open crumb structure', source: 1 },
      { q: 'What is whetstone grit for?', a: 'Edge geometry of a blade', source: 3 },
      { q: 'Out of range', a: 'nowhere', source: 9 },
      { q: 'No source', a: 'at all' }
    ],
    concepts: [
      { term: 'commercial yeast', definition: 'ferments quickly with milder flavour', source: 2 }
    ]
  });
  const scored = scoreCall(raw, NOTES);

  test('counts the three citation values separately', () => {
    expect(scored.citations).toMatchObject({
      items: 5, valid: 3, outOfRange: 1, missing: 1, notesInContext: 3
    });
  });

  test('notesCited counts DISTINCT notes — a pack citing only the seed is visible', () => {
    expect(scored.citations.notesCited).toBe(3);

    // AND THE FIXTURE ABOVE CANNOT SHOW IT ON ITS OWN: its three valid items
    // cite three different notes, so "distinct notes" and "valid items" are the
    // same integer and a counter that returned either would pass. The case that
    // separates them is the one the metric exists for — several items pointing
    // at the SAME note, which is what a pack that ignored the cluster looks
    // like. §30.8 reports `notesCited` precisely because no conformance metric
    // would otherwise say a pack cited only the seed.
    const lopsided = scoreCall(JSON.stringify({
      flashcards: [
        { q: 'hydration crumb', a: 'open structure', source: 1 },
        { q: 'hydration crust', a: 'blistered surface', source: 1 },
        { q: 'hydration dough', a: 'higher water', source: 1 }
      ],
      concepts: [{ term: 'crumb', definition: 'open structure', source: 1 }]
    }), NOTES);
    expect(lopsided.citations.valid).toBe(4);
    expect(lopsided.citations.notesCited).toBe(1);
    expect(lopsided.citations.notesInContext).toBe(3);
  });

  test('an out-of-range or missing citation is not scored for support', () => {
    const bad = scored.items.filter((i) => i.citation !== 'valid');
    expect(bad).toHaveLength(2);
    for (const i of bad) expect(i.support).toBeNull();
  });

  test('support is measured against the CITED note', () => {
    const hydration = scored.items[0];
    expect(hydration.citation).toBe('valid');
    expect(hydration.support).toBeGreaterThan(0.5);
  });

  test('THE NULL IS OVER THE OTHER NOTES IN THE SAME PROMPT', () => {
    const hydration = scored.items[0];
    expect(hydration.supportOther).not.toBeNull();
    // Cooking prose against knife-sharpening prose: the gap should be wide on
    // this fixture. The point of the assertion is that the null EXISTS and is
    // computed over the same context, not that it takes any given value.
    expect(hydration.support).toBeGreaterThan(hydration.supportOther);
  });

  test('bestMatch is true when the cited note is the argmax over the context', () => {
    expect(scored.items[0].bestMatch).toBe(true);
    expect(scored.items[1].bestMatch).toBe(true);
  });

  test('bestMatch is FALSE when a better-matching note sits in the same prompt', () => {
    const misattributed = JSON.stringify({
      flashcards: [{ q: 'What does higher hydration do?', a: 'open crumb structure blistered crust', source: 3 }],
      concepts: [{ term: 't', definition: 'd', source: 1 }]
    });
    const v = scoreCall(misattributed, NOTES);
    expect(v.items[0].citation).toBe('valid');
    expect(v.items[0].bestMatch).toBe(false);
    // AND IT IS NOT CALLED WRONG. A model may legitimately cite a note that is
    // not the best lexical match; this is a countable event, not a verdict.
    expect(v.items[0].support).not.toBeNull();
  });

  test('a claim with no scorable terms is UNSCORABLE, not zero', () => {
    // "is it" is entirely stopwords under utils/keywords.js's tokenizer.
    const v = scoreCall(JSON.stringify({
      flashcards: [{ q: 'is it', a: 'it is', source: 1 }],
      concepts: [{ term: 'a', definition: 'the', source: 1 }]
    }), NOTES);
    expect(v.support.unscorable).toBe(2);
    expect(v.support.scored).toBe(0);
    // Silently dropping it would move the mean for a reason that has nothing to
    // do with the system. §5.3a's omission, one metric over.
    expect(v.citations.valid).toBe(2);
  });

  test('the support arrays line up with what was scored', () => {
    expect(scored.support.values).toHaveLength(scored.support.scored);
    expect(scored.support.otherValues).toHaveLength(scored.support.scored);
    for (const s of scored.support.values) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test('a call whose output does not parse scores nothing and does not throw', () => {
    const v = scoreCall('the model refused', NOTES);
    expect(v.items).toEqual([]);
    expect(v.citations.items).toBe(0);
    expect(v.support.scored).toBe(0);
  });

  test('an empty context is survivable — supportOther is null, not NaN', () => {
    const v = scoreCall(JSON.stringify({
      flashcards: [{ q: 'hydration crumb', a: 'structure', source: 1 }],
      concepts: []
    }), [NOTES[0]]);
    expect(v.items[0].support).not.toBeNull();
    expect(v.items[0].supportOther).toBeNull();
  });
});

describe('the threshold is pre-committed and the cuts bracket it', () => {
  test('SUPPORT_THRESHOLD is one of the reported cuts', () => {
    expect(SUPPORT_CUTS).toContain(SUPPORT_THRESHOLD);
  });
  test('the cuts are ordered and inside [0,1]', () => {
    expect(SUPPORT_CUTS).toEqual([...SUPPORT_CUTS].sort((a, b) => a - b));
    for (const c of SUPPORT_CUTS) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(1);
    }
  });
});
