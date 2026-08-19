'use strict';

/**
 * gen-schema.js — Phase 5.3. What "schema conformance" means, decided before
 * the first API call rather than after seeing a number.
 *
 * PURE. No network, no key, no Groq. Everything here runs in `npm test`, which
 * is the reason the verdicts are in this file and not inline in the measurement
 * script: a rate computed by an unrunnable predicate is unauditable.
 *
 * ---------------------------------------------------------------------------
 * THE DENOMINATOR IS DECIDED HERE, AND §5.3a IS WHY
 * ---------------------------------------------------------------------------
 *
 * §5.3a records that `trec_eval` OMITS queries a retriever returned nothing
 * for — not scores them 0 — and that aggregating that directly divides by the
 * wrong number of queries. The same trap arrives here wearing generation
 * clothes, and it has two sides:
 *
 *   A MODEL THAT RETURNED GARBAGE IS A ZERO, NOT AN EXCLUSION. Dropping it
 *   makes conformance improve exactly when the system gets worse. That is
 *   trec_eval's omission, reproduced by hand.
 *
 *   AN API FAILURE (429, 5xx, socket) IS AN EXCLUSION, NOT A ZERO. No
 *   completion exists, so nothing was generated to conform. Folding it in
 *   makes conformance a function of the harness's PACING — a property of the
 *   operator, not of the system under measurement.
 *
 * So there are two rates and they are always printed together:
 *
 *   conformance = conforming / completed        (this file's job)
 *   delivery    = completed  / attempted        (measure-gen-baseline.js's)
 *
 * Neither is reported alone. Silently dropping either is the defect.
 *
 * ---------------------------------------------------------------------------
 * THREE LEVELS, BECAUSE ONE NUMBER WOULD CONFLATE THREE DIFFERENT DEFECTS
 * ---------------------------------------------------------------------------
 *
 *   parses       JSON.parse succeeds and yields an Array. This is the bar the
 *                SHIPPED CONSUMER actually needs — AIPanel.jsx's
 *                parseResultArray() does exactly this and renders whatever it
 *                gets.
 *   shape        every element is an object carrying exactly the keys the
 *                prompt named, each a non-empty string. This is roadmap 5.4's
 *                wording ("parses as JSON and matches the expected shape") and
 *                it is the headline.
 *   cardinality  the array holds as many elements as the prompt asked for.
 *
 * CARDINALITY IS REPORTED SEPARATELY AND IS NOT A SCHEMA FAILURE. A 5-element
 * flashcard array where 6 were requested is conforming-but-short; counting it
 * as a schema failure would overstate the defect 5.5 is about to fix, and
 * overstating a baseline is how a fix gets credit it did not earn.
 *
 * ---------------------------------------------------------------------------
 * `summarize` AND `eli5` HAVE NO SCHEMA, AND THAT IS `n/a` RATHER THAN 100%
 * ---------------------------------------------------------------------------
 *
 * Their prompts ask for prose. Scoring them 100% conforming would invent a
 * ceiling nobody defined and would drag every "mean across features" upward
 * for free. classify() returns schema: null for them, and the report prints
 * `n/a`. What IS defined for them — empty rate and truncation — is measured.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FAILURE CLASSIFIER TRIES REPAIRS RATHER THAN MATCHING PATTERNS
 * ---------------------------------------------------------------------------
 *
 * "Which defect caused this parse failure" is not answerable by looking for
 * strings, because the causes overlap: a response can be BOTH wrapped in prose
 * AND truncated, and JSON.parse fails at position 0 either way, telling you
 * about the wrapper and nothing about the truncation.
 *
 * So each cause is defined by the repair that would fix it, applied in a fixed
 * precedence, and the precedence is committed here rather than chosen once the
 * failures are visible:
 *
 *   1. empty          nothing came back
 *   2. truncated      a string-aware bracket scan finds an UNCLOSED array. This
 *                     outranks the wrapper causes deliberately: no wrapper
 *                     repair can recover a payload the model never finished,
 *                     so truncation is the binding defect whenever it is
 *                     present. It is `max_tokens: 1024` (llm.service.js:53).
 *   3. wrapper        slicing from the first `[` to the last `]` yields
 *                     something that parses. The payload was fine; the model
 *                     added prose or fence residue around it. This is the gap
 *                     the strip at llm.service.js:59-60 does NOT close —
 *                     it removes fences, never a prose preamble.
 *   4. not-an-array   parses, but to an object or a scalar.
 *   5. malformed      everything else. Deliberately last and deliberately
 *                     vague: a bucket that explains everything explains
 *                     nothing, so it is the residue rather than a diagnosis.
 *
 * THE SCAN IS STRING-AWARE. A `]` inside a string value — "serve in a dish[1]"
 * — must not close a bracket, and an escaped quote must not end a string.
 * Getting that wrong makes `truncated` fire on well-formed JSON, which would
 * inflate the headline defect of this entire phase.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CANNOT SEE
 * ---------------------------------------------------------------------------
 *
 * Whether the fence-strip FIRED. It runs inside the shipped function and
 * rewrites the text before any caller observes it, so its own rate is not
 * measurable without editing llm.service.js — which is 5.5's. `fenceResidue`
 * below detects a fence the strip LEFT BEHIND, which is a different and much
 * rarer event. EVALUATION.md §28.4.
 */

/**
 * The three JSON features and what their prompts actually ask for.
 *
 * TRANSCRIBED FROM llm.service.js:6-11, and checked against it by
 * tests/gen-schema.test.js rather than trusted. `count` is the integer in the
 * prompt text; `keys` is the exact object in its "Format exactly:" clause.
 */
const SCHEMAS = {
  flashcards: { count: 6, keys: ['q', 'a'] },
  concepts: { count: 8, keys: ['term', 'definition'] },
  examQs: { count: 5, keys: ['question', 'answer'] }
};

/** llm.service.js:3-14. The two with no schema are prose by design. */
const PROSE_FEATURES = ['summarize', 'eli5'];
const ALL_FEATURES = ['summarize', 'flashcards', 'concepts', 'examQs', 'eli5'];

/**
 * A completion is `veryShort` under this many characters.
 *
 * NOT CALLED A REFUSAL. Detecting "the model declined" is a semantic judgment
 * and belongs to 5.6's judge; a length threshold cannot tell a refusal from a
 * terse answer. This is a flag for a human to look at, not a rate to quote,
 * and the report labels it that way.
 */
const VERY_SHORT_CHARS = 40;

/**
 * Is there an unterminated array in `text`?
 *
 * Scans once, tracking string state, so brackets inside string values and
 * escaped quotes are both inert. Returns true when depth never returns to 0
 * after the first `[`, or when the scan ends inside a string literal.
 */
function hasUnterminatedArray(text) {
  let depth = 0;
  let opened = false;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') {
      depth += 1;
      opened = true;
    } else if (ch === ']' || ch === '}') depth -= 1;
  }

  return inString || (opened && depth > 0);
}

/** The payload a wrapper repair would recover: first `[` to last `]`. */
function sliceBrackets(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function parseArray(text) {
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/**
 * Does one element carry EXACTLY the expected keys, each a non-empty string?
 *
 * Exactly, not at-least: an element with a bonus key is a model that did not
 * follow "Format exactly", and letting it pass would make the shape check
 * unable to fail in the direction it exists to check.
 */
function elementMatches(element, keys) {
  if (element === null || typeof element !== 'object' || Array.isArray(element)) return false;
  const own = Object.keys(element);
  if (own.length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(element, key)) return false;
    const value = element[key];
    if (typeof value !== 'string' || value.trim() === '') return false;
  }
  return true;
}

/**
 * Classify one completion's text for one feature.
 *
 * @param  {string} text     the text as the SHIPPED FUNCTION returns it — i.e.
 *                           already through the fence-strip for JSON features.
 * @param  {string} feature
 * @returns {{
 *   feature: string, empty: boolean, veryShort: boolean, chars: number,
 *   schema: null|{parses: boolean, shape: boolean, cardinality: boolean,
 *                 items: number|null, expected: number,
 *                 cause: string|null, fenceResidue: boolean}
 * }}
 */
function classify(text, feature) {
  if (!ALL_FEATURES.includes(feature)) {
    throw new Error(`classify: unknown feature "${feature}". Valid: ${ALL_FEATURES.join(', ')}`);
  }

  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.trim();
  const base = {
    feature,
    empty: trimmed === '',
    veryShort: trimmed.length > 0 && trimmed.length < VERY_SHORT_CHARS,
    chars: trimmed.length
  };

  const spec = SCHEMAS[feature];
  if (!spec) return { ...base, schema: null };

  const fenceResidue = trimmed.includes('```');

  if (trimmed === '') {
    return {
      ...base,
      schema: {
        parses: false, shape: false, cardinality: false,
        items: null, expected: spec.count, cause: 'empty', fenceResidue
      }
    };
  }

  const direct = parseArray(trimmed);

  if (direct.ok && Array.isArray(direct.value)) {
    const items = direct.value;
    const shape = items.length > 0 && items.every((el) => elementMatches(el, spec.keys));
    return {
      ...base,
      schema: {
        parses: true,
        shape,
        cardinality: items.length === spec.count,
        items: items.length,
        expected: spec.count,
        // A parsing array whose ELEMENTS are wrong is not a wrapper problem and
        // not a truncation; it is the model inventing its own field names.
        cause: shape ? null : 'element-shape',
        fenceResidue
      }
    };
  }

  // Precedence is committed in this file's header. Truncation first, because
  // no wrapper repair recovers a payload the model never finished.
  let cause;
  if (hasUnterminatedArray(trimmed)) {
    cause = 'truncated';
  } else {
    const inner = sliceBrackets(trimmed);
    const repaired = inner === null ? { ok: false } : parseArray(inner);
    if (repaired.ok && Array.isArray(repaired.value)) cause = 'wrapper';
    else if (direct.ok) cause = 'not-an-array';
    else cause = 'malformed';
  }

  return {
    ...base,
    schema: {
      parses: false, shape: false, cardinality: false,
      items: null, expected: spec.count, cause, fenceResidue
    }
  };
}

module.exports = {
  SCHEMAS,
  PROSE_FEATURES,
  ALL_FEATURES,
  VERY_SHORT_CHARS,
  classify,
  hasUnterminatedArray,
  sliceBrackets,
  elementMatches
};
