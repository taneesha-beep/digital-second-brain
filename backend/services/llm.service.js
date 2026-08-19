const Groq = require('groq-sdk');

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

/**
 * PHASE 5.0 — 19 Aug 2026. This was `llama-3.3-70b-versatile` and that string
 * is RETIRED: it returns HTTP 404 `model_not_found` and is absent from the 13
 * models the key can reach, so all five AI features returned a 500 to every
 * user for an unknown number of days. `results/gen-model-retired.txt` is the
 * probe that found it; nothing in this repository could have — no test, no
 * checker and no CI step read this line.
 *
 * `openai/gpt-oss-120b` is chosen because 5.3's baseline already ran on it
 * (`results/gen-baseline.txt`). Shipping any other reachable model would make
 * 5.5's before/after a two-variable change and discard the only generation
 * baseline this project has — and the true `gen-v1` is permanently
 * unmeasurable, so there is no second chance to re-baseline. It also leaves
 * `qwen/qwen3.6-27b` free as 5.6's judge, which has to differ from the model
 * being judged.
 *
 * `npm run gen:probe` is the check that this string still resolves. It needs a
 * network and a key, so it cannot run in CI — see docs/EVALUATION.md §29.3.
 */
const MODEL = 'openai/gpt-oss-120b';

const SYSTEM_MESSAGE =
  'You are a helpful study assistant. Follow the user instructions exactly. ' +
  'When asked for JSON, return ONLY the JSON array — no extra text, no markdown fences.';

const TEMPERATURE = 0.4;

/**
 * PHASE 5.5 — was 1024, which truncated 46.7% of `examQs` calls and 6.7% of
 * `eli5` calls, and accounted for 93.3% of all schema failures (§28.4).
 *
 * 2048 is the SMALLEST value clearing the measured demand rather than a round
 * doubling. The truncated calls in 5.3's ledger are censored — their true
 * demand is not observable — so it was extrapolated two ways from how many
 * answers each call had begun: 1638 tokens counting the last begun item as
 * complete, 1944 counting it half-written. 2048 clears both.
 *
 * It does NOT cover the worst-case pairing of 2577 (max content 1840 + max
 * reasoning 737), because those maxima occurred on different seeds and pairing
 * them is a bound nothing observed. Smallest-sufficient is the right criterion
 * for a cap: latency is linear in output tokens at a measured 2.15 ms each, so
 * every token of headroom above the clearing point is latency paid on exactly
 * the calls being repaired. §29.2.
 */
const MAX_TOKENS = 2048;

/** Which features get their markdown fences stripped on the way out. */
const STRIPPED_FEATURES = ['flashcards', 'concepts', 'examQs'];

/**
 * Run one feature over one note's text.
 *
 * RETURNS AN OBSERVATION, NOT A STRING (Phase 5.5). This used to return
 * `completion.choices[0].message.content` and discard everything else, which
 * made tokens in/out and truncation unobservable through the only surface the
 * app has — so 5.3 had to measure a frozen COPY of this function instead
 * (`scripts/lib/llm-v1-shipped.js`, §28.3) and every future generation
 * measurement would have needed the same workaround.
 *
 * The route keeps serving `{ result }` unchanged, so no client sees this.
 *
 * @returns {Promise<{text: string, rawText: string, model: string,
 *                    finishReason: string|null, latencyMs: number,
 *                    promptTokens: number|null, completionTokens: number|null,
 *                    reasoningTokens: number|null, totalTokens: number|null}>}
 *          `text` is what the caller renders — post-strip for JSON features.
 *          `rawText` is pre-strip, which is the only way to observe whether
 *          the strip fired at all.
 */
exports.processNote = async (contentText, feature) => {
  const API_KEY = process.env.GROQ_API_KEY;
  if (!API_KEY) {
    throw new Error(
      'Missing GROQ_API_KEY — add it to backend/.env and restart the server. ' +
      'Get a free key at console.groq.com'
    );
  }

  const prompt = PROMPTS[feature];
  if (!prompt) {
    throw new Error(
      `Unknown feature: "${feature}". Valid: summarize, flashcards, concepts, examQs, eli5`
    );
  }

  const groq = new Groq({ apiKey: API_KEY });
  const startedAt = Date.now();

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: SYSTEM_MESSAGE
        },
        {
          role: 'user',
          content: `${prompt}\n\nNotes:\n${contentText}`
        }
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS
    });

    const latencyMs = Date.now() - startedAt;
    const rawText = completion.choices?.[0]?.message?.content || '';

    // Strip markdown fences if the model wrapped JSON output anyway
    const text = STRIPPED_FEATURES.includes(feature)
      ? rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim()
      : rawText;

    const choice = completion.choices?.[0] || {};
    const usage = completion.usage || {};

    return {
      text,
      rawText,
      latencyMs,
      model: completion.model || MODEL,
      finishReason: choice.finish_reason ?? null,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      // Reasoning tokens count against max_tokens and are NOT in `content`, so
      // they consume the ceiling without producing output. On gpt-oss-120b they
      // averaged 16.6% of the old 1024 (§28.7), which is why they are surfaced
      // rather than left inside `usage`.
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      totalTokens: usage.total_tokens ?? null
    };
  } catch (err) {
    const msg = String(err.message || '');

    if (msg.includes('401') || msg.includes('invalid_api_key')) {
      throw new Error('Invalid Groq API key — check GROQ_API_KEY in your .env file');
    }
    if (msg.includes('429') || msg.includes('rate_limit')) {
      throw new Error('Groq rate limit hit — wait a few seconds and try again');
    }
    if (msg.includes('503') || msg.includes('unavailable')) {
      throw new Error('Groq service temporarily unavailable — try again in a moment');
    }
    // The branch this mapping did not have, and the one a user actually hit.
    // A retired model fell through to the generic "AI processing failed: 404",
    // which explains nothing to anyone. Phase 5.0.
    if (msg.includes('404') || msg.includes('model_not_found')) {
      throw new Error(
        `Groq model "${MODEL}" is not available to this key — it may have been ` +
        'retired. Run `npm run gen:probe` to see which models the key can reach.'
      );
    }

    throw new Error(`AI processing failed: ${msg}`);
  }
};

// Exported so a check can read what the app actually asks for rather than a
// transcription of it. Nothing in this repository read the model string before
// 5.0, which is why its retirement went unnoticed. ROADMAP's 5.2/5.3 noticed
// list asked for this.
exports.PROMPTS = PROMPTS;
exports.MODEL = MODEL;
exports.SYSTEM_MESSAGE = SYSTEM_MESSAGE;
exports.TEMPERATURE = TEMPERATURE;
exports.MAX_TOKENS = MAX_TOKENS;
exports.STRIPPED_FEATURES = STRIPPED_FEATURES;
