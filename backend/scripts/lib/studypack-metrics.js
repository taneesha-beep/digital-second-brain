'use strict';

/**
 * studypack-metrics.js — Phase 5.4. The predicate and the scorer for a Study
 * Pack response, decided before the first gen-v5 API call rather than after
 * seeing a number.
 *
 * PURE. No network, no key, no database, nothing under data/. Everything here
 * runs in `npm test`, which is the reason the verdicts live in this file rather
 * than inline in the reporting script: a rate computed by an unrunnable
 * predicate is unauditable. Same argument as gen-schema.js's, and this file is
 * its sibling rather than its replacement.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND gen-schema.js IS NOT EDITED
 * ---------------------------------------------------------------------------
 *
 * TWO INDEPENDENT REASONS, and the second is the load-bearing one.
 *
 * 1. tests/gen-shipped-parity.test.js asserts `Object.keys(SCHEMAS)` equals
 *    `STRIPPED_FEATURES` exactly, so a `studyPack` entry there turns that suite
 *    RED ON THE SHAPE. §30.9 already recorded this as correct behaviour: that
 *    file is the transcription of the five CONTROL prompts, and a sixth entry
 *    would make it a transcription of something else.
 *
 * 2. §29.4 lists "same grader: gen-schema.js NOT EDITED, pinned by its 58
 *    existing tests" as one of the four things holding the gen-v1 vs gen-v2
 *    comparison together. Editing it — even additively — would put §29's
 *    published figures in the position of needing re-verification. They are
 *    left byte-identical instead.
 *
 * SO THIS FILE IMPORTS FROM IT READ-ONLY. `hasUnterminatedArray` is imported
 * rather than reimplemented, so there is still exactly ONE string-aware bracket
 * scanner in this repository — §28.11 records that a naive bracket counter with
 * no string-awareness was the single most dangerous mutation of the whole
 * phase, because it reports well-formed JSON as truncated and would inflate the
 * headline defect. One implementation, 58 tests already on it.
 *
 * WHAT IS NOT IMPORTED, AND WHY. `elementMatches` requires every expected key
 * to be a NON-EMPTY STRING. A study-pack element carries `source`, which is an
 * INTEGER. So the check here is genuinely a different predicate rather than a
 * missed reuse, and `sliceBrackets` slices `[`..`]` where an envelope needs
 * `{`..`}`. Both differences are named at their site below.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, TRANSCRIBED FROM services/studyPack.service.js's buildPrompt()
 * ---------------------------------------------------------------------------
 *
 *   {"flashcards":[{"q":"..","a":"..","source":1}],
 *    "concepts":[{"term":"..","definition":"..","source":1}]}
 *
 * AN OBJECT ENVELOPE, NOT AN ARRAY, which is the one structural difference from
 * all five control features and is exactly why they cannot share a grader.
 * tests/studypack-metrics.test.js checks this transcription against the live
 * prompt rather than trusting it, the same way tests/gen-schema.test.js does.
 *
 * ---------------------------------------------------------------------------
 * FAILURE PRECEDENCE — COMMITTED HERE, BEFORE ANY FAILURE WAS VISIBLE
 * ---------------------------------------------------------------------------
 *
 * "Which defect caused this?" is not answerable by matching strings, because
 * the causes overlap: a response can be both wrapped in prose AND truncated,
 * and JSON.parse fails at position 0 either way. So each cause is defined by
 * the repair that would fix it, in a fixed order:
 *
 *   1. empty         nothing came back at all
 *   2. truncated     a string-aware scan finds an unclosed span. OUTRANKS the
 *                    wrapper causes deliberately: no wrapper repair recovers a
 *                    payload the model never finished. gen-schema.js's rule,
 *                    and the reason is identical.
 *   3. wrapper       slicing the outermost `{`..`}` yields something that
 *                    parses. The payload was fine; prose or fence residue was
 *                    added around it.
 *   4. not-an-object parses, but to an array or a scalar.
 *   5. missing-slot  parses to an object, but `flashcards` or `concepts` is
 *                    absent or is not an array. THIS LEVEL DOES NOT EXIST IN
 *                    gen-schema.js and is not a gratuitous addition: a control
 *                    feature returns ONE array, so "the envelope is right and a
 *                    slot is missing" is a defect that cannot occur there.
 *   6. element-shape both slots are arrays, but an element carries the wrong
 *                    keys or a non-integer `source`.
 *   7. malformed     the residue. Deliberately last and deliberately vague: a
 *                    bucket that explains everything explains nothing.
 *
 * CARDINALITY IS NOT A SCHEMA FAILURE, and that rule is inherited verbatim.
 * A pack with 5 flashcards where 6 were asked is conforming-but-short.
 * Folding it in would overstate the defect, and overstating a first measurement
 * is how a later fix gets credit it did not earn.
 *
 * ---------------------------------------------------------------------------
 * CITATION SUPPORT IS A PROXY. IT IS LABELLED ONE EVERYWHERE IT APPEARS.
 * ---------------------------------------------------------------------------
 *
 * `support` is LEXICAL CONTAINMENT of the claim's terms in the cited note's
 * terms: |claim ∩ note| / |claim|. Two failure modes, both real, and the second
 * is the one nobody mentions:
 *
 *   FALSE NEGATIVE — a correct paraphrase sharing no vocabulary scores zero.
 *   That is NOT a hallucination and must never be reported as one.
 *
 *   FALSE POSITIVE — a claim built from generic cooking vocabulary scores high
 *   against ANY cooking note. So a high score is not evidence of support
 *   either.
 *
 * 5.6's judge is what actually answers the question. This is the cheap
 * programmatic proxy that needs no judge, which is the whole point of 5.4.
 *
 * CONTAINMENT RATHER THAN JACCARD, because a note is 100-500 words and a claim
 * is ~20. Jaccard would be crushed by the length asymmetry and would measure
 * note length rather than support — the same reason `linker.service.js` used an
 * overlap coefficient and v2-jaccard is a separate rung on the ladder (§14).
 *
 * THE WHOLE ITEM IS THE CLAIM, not just the answer half. A citation attributes
 * the item, not half of it. The alternative — scoring `a` alone and treating
 * `q` as a prompt — is defensible and is NOT taken, because it would drop the
 * vocabulary most likely to have come from the note and would flatter nothing
 * in particular. Recorded so it is a choice rather than an oversight.
 *
 * ---------------------------------------------------------------------------
 * AND A SUPPORT NUMBER SHIPS WITH A NULL, WHICH IS §5.3a's RULE IN A NEW PLACE
 * ---------------------------------------------------------------------------
 *
 * PRIMER §5.3a: two denominators, never one. The generalisation here is that a
 * support RATE has no scale on its own. If a claim scores 0.60 against the note
 * it cites and 0.55 against every other note in the same prompt, the citation
 * carries almost no information — and a headline of "0.60 support" would hide
 * that completely.
 *
 * So every item with a valid citation is also scored against the notes in the
 * same context it did NOT cite, and three numbers are reported together:
 *
 *   support        containment against the cited note
 *   supportOther   MEAN containment against the other notes in that prompt
 *   bestMatch      whether the cited note is the ARGMAX over the whole context
 *
 * `bestMatch` IS NOT A CORRECTNESS RATE. A model may legitimately cite a note
 * that is not the best lexical match — that is the false-negative mode above,
 * seen from the other side. It is a countable event, not a verdict.
 */

const { hasUnterminatedArray } = require('./gen-schema');
const { tokenise } = require('../../utils/keywords');

/**
 * The two slots and the keys each element must carry.
 *
 * `source` is listed with its own type because it is the one key that is not a
 * string. Transcribed from studyPack.service.js's buildPrompt(); checked
 * against the live prompt by tests/studypack-metrics.test.js rather than
 * trusted, which is the discipline tests/gen-schema.test.js established.
 */
const SLOTS = {
  flashcards: { count: 6, stringKeys: ['q', 'a'], intKeys: ['source'] },
  concepts: { count: 8, stringKeys: ['term', 'definition'], intKeys: ['source'] }
};

const SLOT_NAMES = Object.keys(SLOTS);

/** Total items a conforming pack returns. 6 + 8, held identical to gen-v1. */
const EXPECTED_ITEMS = SLOT_NAMES.reduce((n, s) => n + SLOTS[s].count, 0);

/**
 * A completion is `veryShort` under this many characters.
 *
 * NOT CALLED A REFUSAL, and the value is gen-schema.js's for a reason: keeping
 * two different short-thresholds in one report would make the two halves of the
 * empty/refusal column incomparable. Detecting "the model declined" is a
 * semantic judgment and belongs to 5.6's judge; a length threshold cannot tell
 * a refusal from a terse answer. A flag for a human, not a rate to quote.
 */
const VERY_SHORT_CHARS = 40;

/**
 * THE SUPPORT THRESHOLD, PRE-COMMITTED AND ARBITRARY, AND BOTH WORDS MATTER.
 *
 * It is fixed here before the first gen-v5 call so it cannot be chosen once the
 * distribution is visible — which is the move that turns a measurement into an
 * argument. It is also genuinely arbitrary: nothing establishes that 0.5 is the
 * point where a claim becomes supported.
 *
 * So the report prints the FULL DISTRIBUTION beside the rate — mean, median,
 * p10 and the rate at 0.3, 0.5 and 0.7 — and a reader who prefers a different
 * cut can take it without re-running anything.
 */
const SUPPORT_THRESHOLD = 0.5;
const SUPPORT_CUTS = [0.3, 0.5, 0.7];

/** The payload a wrapper repair would recover: outermost `{` to last `}`. */
function sliceBraces(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/**
 * Does one element carry EXACTLY the expected keys, with the right types?
 *
 * Exactly, not at-least — gen-schema.js's rule and its reason: an element with a
 * bonus key is a model that did not follow "Format exactly", and letting it pass
 * would make the shape check unable to fail in the direction it exists to check.
 *
 * NOT A CALL INTO gen-schema.js's elementMatches, and this is the difference:
 * that one requires every expected key to be a non-empty STRING, and `source`
 * is an INTEGER. A study pack whose `source` arrived as "1" rather than 1 is a
 * real and interesting defect — the server's resolveCitations() coerces it, so
 * the citation still resolves while the shape is wrong — and collapsing the two
 * predicates would make it invisible.
 */
function elementMatches(element, spec) {
  if (element === null || typeof element !== 'object' || Array.isArray(element)) return false;
  const expected = [...spec.stringKeys, ...spec.intKeys];
  const own = Object.keys(element);
  if (own.length !== expected.length) return false;
  for (const key of spec.stringKeys) {
    if (!Object.prototype.hasOwnProperty.call(element, key)) return false;
    const v = element[key];
    if (typeof v !== 'string' || v.trim() === '') return false;
  }
  for (const key of spec.intKeys) {
    if (!Object.prototype.hasOwnProperty.call(element, key)) return false;
    if (!Number.isInteger(element[key])) return false;
  }
  return true;
}

/**
 * Classify one Study Pack completion's raw text.
 *
 * @param {string} rawText the text as the model returned it. NOT stripped:
 *        studyPack.service.js deliberately does not reproduce the shipped fence
 *        strip (§30.6), so this grades what the service's own parser would see.
 * @returns {{
 *   empty: boolean, veryShort: boolean, chars: number,
 *   parses: boolean, shape: boolean, cardinality: boolean,
 *   counts: {flashcards: number|null, concepts: number|null},
 *   items: number|null, expected: number,
 *   cause: string|null, fenceResidue: boolean, usedFallbackParse: boolean
 * }}
 */
function classifyStudyPack(rawText) {
  const raw = typeof rawText === 'string' ? rawText : '';
  const trimmed = raw.trim();
  const fenceResidue = trimmed.includes('```');

  const base = {
    empty: trimmed === '',
    veryShort: trimmed.length > 0 && trimmed.length < VERY_SHORT_CHARS,
    chars: trimmed.length,
    expected: EXPECTED_ITEMS,
    fenceResidue
  };
  const fail = (cause, extra = {}) => ({
    ...base,
    parses: false,
    shape: false,
    cardinality: false,
    counts: { flashcards: null, concepts: null },
    items: null,
    cause,
    usedFallbackParse: false,
    ...extra
  });

  if (trimmed === '') return fail('empty');

  let value = null;
  let usedFallbackParse = false;

  const direct = parseJson(trimmed);
  if (direct.ok) {
    value = direct.value;
  } else {
    // PRECEDENCE, COMMITTED IN THE HEADER. Truncation first, because no wrapper
    // repair recovers a payload the model never finished.
    if (hasUnterminatedArray(trimmed)) return fail('truncated');
    const inner = sliceBraces(trimmed);
    const repaired = inner === null ? { ok: false } : parseJson(inner);
    if (!repaired.ok) return fail('malformed');
    value = repaired.value;
    usedFallbackParse = true;
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('not-an-object', { usedFallbackParse });
  }

  const missingSlot = SLOT_NAMES.some((s) => !Array.isArray(value[s]));
  const counts = {
    flashcards: Array.isArray(value.flashcards) ? value.flashcards.length : null,
    concepts: Array.isArray(value.concepts) ? value.concepts.length : null
  };
  if (missingSlot) {
    return {
      ...fail('missing-slot', { usedFallbackParse }),
      parses: true,
      counts
    };
  }

  const shape = SLOT_NAMES.every((s) => {
    const arr = value[s];
    return arr.length > 0 && arr.every((el) => elementMatches(el, SLOTS[s]));
  });
  const cardinality = SLOT_NAMES.every((s) => value[s].length === SLOTS[s].count);
  const items = SLOT_NAMES.reduce((n, s) => n + value[s].length, 0);

  return {
    ...base,
    parses: true,
    shape,
    cardinality,
    counts,
    items,
    // A parsing envelope whose ELEMENTS are wrong is not a wrapper problem and
    // not a truncation; it is the model inventing its own field names, or
    // emitting `source` as a string.
    cause: shape ? null : 'element-shape',
    usedFallbackParse
  };
}

/** Every item a pack returned, flattened, each tagged with the slot it came from. */
function itemsOf(rawText) {
  const trimmed = String(rawText || '').trim();
  let value = null;
  const direct = parseJson(trimmed);
  if (direct.ok) value = direct.value;
  else {
    const inner = sliceBraces(trimmed);
    const repaired = inner === null ? { ok: false } : parseJson(inner);
    if (!repaired.ok) return [];
    value = repaired.value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];

  const out = [];
  for (const slot of SLOT_NAMES) {
    if (!Array.isArray(value[slot])) continue;
    for (const el of value[slot]) {
      if (el === null || typeof el !== 'object' || Array.isArray(el)) continue;
      out.push({ slot, element: el });
    }
  }
  return out;
}

/**
 * The text of one item, as the thing being attributed to a source.
 *
 * Both fields, joined — see the header on why the whole item is the claim.
 */
function claimText(slot, element) {
  const spec = SLOTS[slot];
  if (!spec) return '';
  return spec.stringKeys.map((k) => (typeof element[k] === 'string' ? element[k] : '')).join(' ').trim();
}

/**
 * Resolve one item's `source` label against the context that was actually sent.
 *
 * Three values, never two, and they are the service's own (§30.5):
 *   valid         an integer label naming a note in the context
 *   out-of-range  a label naming a note that was not there
 *   missing       no usable `source` at all
 *
 * COERCION IS ACCEPTED HERE AND FLAGGED IN THE SHAPE INSTEAD. `source: "1"`
 * resolves, because services/studyPack.service.js resolves it and this metric
 * has to describe what the app does rather than what it wishes the app did.
 * The string-vs-integer defect is not lost — elementMatches() above fails it,
 * so it lands in the shape column where it belongs. One defect, one column.
 */
function resolveLabel(element, labels) {
  const raw = element && element.source;
  let label = null;
  if (Number.isInteger(raw)) label = raw;
  else if (typeof raw === 'string' && raw.trim() !== '' && Number.isInteger(Number(raw))) label = Number(raw);

  if (label === null) return { label: null, citation: 'missing' };
  return { label, citation: labels.has(label) ? 'valid' : 'out-of-range' };
}

/** |claim ∩ note| / |claim|. null when the claim has no scorable terms. */
function containment(claimTerms, noteTerms) {
  if (claimTerms.size === 0) return null;
  let shared = 0;
  for (const t of claimTerms) if (noteTerms.has(t)) shared += 1;
  return shared / claimTerms.size;
}

/**
 * Score every item in one completed gen-v5 call.
 *
 * @param {string} rawText     the model's raw output
 * @param {Array<{label:number, noteId:string, title:string, text:string}>} notes
 *        THE CONTEXT THAT WAS ACTUALLY SENT, carried on the ledger row. Not
 *        rebuilt from data/gen-eval/ — §30.4's argument is that the support
 *        metric must compare a claim against the text the model SAW, and
 *        §30.3's is that a check reading data/ passes in CI and fails in the
 *        local reproduction of CI.
 * @returns {{items: Array, citations: Object, support: Object}}
 */
function scoreCall(rawText, notes) {
  const labels = new Map(notes.map((n) => [n.label, n]));
  const termsByLabel = new Map(notes.map((n) => [n.label, new Set(tokenise(`${n.title} ${n.text}`))]));

  const items = itemsOf(rawText).map(({ slot, element }) => {
    const { label, citation } = resolveLabel(element, labels);
    const claim = claimText(slot, element);
    const claimTerms = new Set(tokenise(claim));

    const row = {
      slot,
      label,
      citation,
      noteId: citation === 'valid' ? labels.get(label).noteId : null,
      claimTerms: claimTerms.size,
      support: null,
      supportOther: null,
      bestMatch: null
    };
    if (citation !== 'valid' || claimTerms.size === 0) return row;

    row.support = containment(claimTerms, termsByLabel.get(label));

    // THE NULL. Every other note in the SAME prompt, so the comparison holds
    // the cluster, the seed and the retriever fixed and varies only which note
    // the model pointed at. Without it the support figure has no scale at all.
    const others = notes.filter((n) => n.label !== label);
    const otherScores = others.map((n) => containment(claimTerms, termsByLabel.get(n.label)));
    row.supportOther = otherScores.length
      ? otherScores.reduce((a, b) => a + b, 0) / otherScores.length
      : null;
    row.bestMatch = otherScores.every((s) => row.support >= s);
    return row;
  });

  const count = (p) => items.filter(p).length;
  const scored = items.filter((i) => i.support !== null);

  return {
    items,
    citations: {
      items: items.length,
      expected: EXPECTED_ITEMS,
      valid: count((i) => i.citation === 'valid'),
      outOfRange: count((i) => i.citation === 'out-of-range'),
      missing: count((i) => i.citation === 'missing'),
      notesCited: new Set(items.filter((i) => i.noteId).map((i) => i.noteId)).size,
      notesInContext: notes.length
    },
    support: {
      scored: scored.length,
      // Unscorable is reported rather than dropped: an item whose claim has no
      // terms after stopword removal cannot be scored, and silently excluding
      // it would move the mean for a reason that has nothing to do with the
      // system. §5.3a's omission, one metric over.
      unscorable: items.filter((i) => i.citation === 'valid' && i.support === null).length,
      values: scored.map((i) => i.support),
      otherValues: scored.filter((i) => i.supportOther !== null).map((i) => i.supportOther),
      bestMatch: scored.filter((i) => i.bestMatch).length
    }
  };
}

module.exports = {
  SLOTS,
  SLOT_NAMES,
  EXPECTED_ITEMS,
  VERY_SHORT_CHARS,
  SUPPORT_THRESHOLD,
  SUPPORT_CUTS,
  classifyStudyPack,
  elementMatches,
  sliceBraces,
  itemsOf,
  claimText,
  resolveLabel,
  containment,
  scoreCall
};
