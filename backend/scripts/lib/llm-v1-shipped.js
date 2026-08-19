'use strict';

/**
 * llm-v1-shipped.js — Phase 5.3. FROZEN. NEVER EDIT.
 *
 * The generation call exactly as `backend/services/llm.service.js` ships it,
 * preserved so the Phase 5 baseline survives 5.5 changing that file.
 *
 * THE FOURTH FROZEN COPY IN THIS REPOSITORY, and it exists for the identical
 * reason as the other three — `linker-v1-shipped.js` (2.1),
 * `graph-builder-v1-shipped.js` (4.4), `corpus-v1-shipped.js` (4.6) — one phase
 * EARLIER in its own lifecycle. Those three were cut at the moment a change
 * landed. This one is cut BEFORE the change, because CLAUDE.md's fourth
 * evaluation trap says the "before" number is destroyed by the change itself
 * and must be captured as a separate, earlier step, and Phase 5's header says
 * in terms that 5.3 "has to run first".
 *
 * ---------------------------------------------------------------------------
 * WHY A COPY AND NOT A CALL — THE SHIPPED FUNCTION DISCARDS HALF THE BASELINE
 * ---------------------------------------------------------------------------
 *
 * `processNote()` returns `completion.choices[0].message.content` and nothing
 * else (llm.service.js:56, :60, :63). `usage` and `finish_reason` never leave
 * the function. So through the shipped surface:
 *
 *   schema conformance   OBSERVABLE  — it is the returned text
 *   latency              OBSERVABLE  — wall clock around the call
 *   empty rate           OBSERVABLE
 *   tokens in / out      NOT OBSERVABLE — `usage` is dropped
 *   truncation           NOT OBSERVABLE — `finish_reason` is dropped
 *   whether the fence-
 *     strip fired        NOT OBSERVABLE — the pre-strip text is overwritten
 *
 * Four of roadmap 5.3's stated deliverables — "mean tokens in/out, cost per
 * call" — and the single most diagnostic figure in the phase (how often
 * `max_tokens: 1024` truncates) are in the bottom half. Adding a return field
 * to llm.service.js would fix that and is FORBIDDEN here: the five single-note
 * features are 5.1's A/B control, and editing the control to measure it is the
 * mistake this file exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COPY GUARANTEES, AND IT IS WEAKER THAN `parity:v1`'s — SAY SO
 * ---------------------------------------------------------------------------
 *
 * `parity-v1.js` proves byte-identity of OUTPUT between two implementations.
 * Nothing like that is available here: two calls to a hosted model on identical
 * input do not agree byte for byte, so there is no output to hash.
 *
 * What is proved instead is EQUALITY OF EVERY INPUT THE API SEES, checked
 * mechanically rather than by eye. `tests/gen-shipped-parity.test.js` reads
 * `services/llm.service.js` AS SOURCE TEXT and asserts that all five prompts,
 * the system message, the model id, `temperature`, `max_tokens`, the feature
 * list and both strip regexes below appear in it verbatim.
 *
 * THAT TEST IS DESIGNED TO GO RED AT 5.5. When 5.5 raises max_tokens, the
 * assertion fails and the failure means "the baseline's copy no longer
 * describes the shipped code" — which is exactly what should happen, and is the
 * same device as `tests/edges.canonical.test.js` asserting that the PRE-4.1
 * linker fails the save-order check.
 *
 * Every number this baseline produces is therefore a number ABOUT THIS COPY,
 * standing in for the shipped function under a source-text equality it does not
 * share a runtime with. That is a real gap and it is not dressed up.
 *
 * PROMPTS and MODEL are module-local in llm.service.js and exported by nothing,
 * which is why they are duplicated rather than imported. That is a property of
 * the file being copied, not a choice made here.
 */

/** VERBATIM from llm.service.js:3-14. */
const PROMPTS = {
  summarize:
    'Summarize the following notes in 4-5 clear sentences highlighting the main ideas. Write in plain prose, no bullet points.',
  flashcards:
    'Generate 6 flashcard Q&A pairs from these notes. Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else. Format exactly: [{"q":"question","a":"answer"}]',
  concepts:
    'Extract 8 key concepts from these notes. Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else. Format exactly: [{"term":"term","definition":"one sentence definition"}]',
  examQs:
    'Generate 5 exam-style questions with detailed answers from these notes. Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else. Format exactly: [{"question":"q","answer":"a"}]',
  eli5:
    'Explain the following notes as if explaining to a 12-year-old. Use simple words, short sentences, and fun analogies. No jargon.'
};

/** VERBATIM from llm.service.js:17. */
const MODEL = 'llama-3.3-70b-versatile';

/** VERBATIM from llm.service.js:43-45. */
const SYSTEM_MESSAGE =
  'You are a helpful study assistant. Follow the user instructions exactly. ' +
  'When asked for JSON, return ONLY the JSON array — no extra text, no markdown fences.';

/** VERBATIM from llm.service.js:52-53. THE DEFECT 5.5 FIXES IS THE SECOND ONE. */
const TEMPERATURE = 0.4;
const MAX_TOKENS = 1024;

/** VERBATIM from llm.service.js:59 — which features get their fences stripped. */
const STRIPPED_FEATURES = ['flashcards', 'concepts', 'examQs'];

/**
 * VERBATIM from llm.service.js:60.
 *
 * Both regexes are GLOBAL AND UNANCHORED, so a fence appearing inside a string
 * VALUE is deleted from content rather than from the wrapper. Reproduced
 * exactly rather than corrected — a copy that fixes a defect measures a system
 * nobody runs.
 */
function applyShippedStrip(text, feature) {
  if (!STRIPPED_FEATURES.includes(feature)) return text;
  return text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
}

/**
 * The call, with everything the shipped function throws away kept.
 *
 * @param {Object} groq            an instantiated groq-sdk client
 * @param {string} contentText
 * @param {string} feature
 * @returns {Promise<Object>} the observation, including `rawText` (pre-strip)
 *          and `text` (post-strip, === what processNote would have returned).
 */
async function callShipped(groq, contentText, feature) {
  const prompt = PROMPTS[feature];
  if (!prompt) {
    throw new Error(
      `Unknown feature: "${feature}". Valid: summarize, flashcards, concepts, examQs, eli5`
    );
  }

  const params = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_MESSAGE },
      { role: 'user', content: `${prompt}\n\nNotes:\n${contentText}` }
    ],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS
  };

  const startedAt = Date.now();

  // withResponse() is how the SDK surfaces headers, and the rate-limit headers
  // are what pace the run (§28.6) — measured pacing rather than a documented
  // limit quoted from a webpage. Degrades to a plain call if the SDK in use
  // does not offer it, because a missing header is a reason to pace
  // conservatively, not a reason to fail the run.
  let completion;
  let headers = null;
  const pending = groq.chat.completions.create(params);
  if (pending && typeof pending.withResponse === 'function') {
    const wrapped = await pending.withResponse();
    completion = wrapped.data;
    headers = wrapped.response && wrapped.response.headers ? wrapped.response.headers : null;
  } else {
    completion = await pending;
  }

  const latencyMs = Date.now() - startedAt;

  // llm.service.js:56 — the `|| ''` is load-bearing and is copied with it.
  const rawText = completion.choices?.[0]?.message?.content || '';
  const text = applyShippedStrip(rawText, feature);

  const choice = (completion.choices && completion.choices[0]) || {};
  const usage = completion.usage || {};

  return {
    text,
    rawText,
    latencyMs,
    finishReason: choice.finish_reason ?? null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    model: completion.model || MODEL,
    id: completion.id || null,
    rateLimit: readRateLimit(headers)
  };
}

/** The `x-ratelimit-*` headers, as strings, or null. Not interpreted here. */
function readRateLimit(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const keys = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-reset-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-tokens',
    'retry-after'
  ];
  const out = {};
  let any = false;
  for (const key of keys) {
    const value = headers.get(key);
    if (value != null) {
      out[key] = String(value);
      any = true;
    }
  }
  return any ? out : null;
}

module.exports = {
  PROMPTS,
  MODEL,
  SYSTEM_MESSAGE,
  TEMPERATURE,
  MAX_TOKENS,
  STRIPPED_FEATURES,
  applyShippedStrip,
  callShipped
};
