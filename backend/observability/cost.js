'use strict';

/**
 * observability/cost.js — Phase 6.2. THE RATE TABLE, AND THE ONE COPY OF IT.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR, AND THE THING IT MUST NOT BECOME.
 *
 * ROADMAP 6.2's Done criterion is "a trace shows COST attributed to a single
 * request". A token count alone does not meet it, so a dollar figure is
 * computed — and a dollar figure computed from a rate with no source is exactly
 * the "measured-looking number with no artifact behind it" that CLAIM
 * DISCIPLINE in CLAUDE.md forbids. Everything below exists to stop that.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ THIS IS A PUBLISHED LIST PRICE. IT IS NOT MONEY ANYBODY WAS CHARGED.
 *
 * This project runs on Groq's FREE TIER. The actual invoice is, as far as this
 * repository can tell, $0.00 — PRIMER §8.3 said so before any of this was
 * built, and it is still true. What is real is the TOKEN COUNT; price is a
 * multiplier applied afterwards, and the transferable claim is "per-request
 * token cost was attributed through the pipeline", never the size of a bill.
 *
 * Two further reasons the figure is an upper-ish estimate rather than a charge:
 *
 *   - Groq applies AUTOMATIC PROMPT CACHING to this model, billing a cached
 *     input prefix at half rate. Nothing in this repository observes whether a
 *     given call hit that cache, so every input token here is priced at the
 *     full rate. A real bill would be the same or lower.
 *   - The free tier's quota is enforced on ACTUAL tokens (EVALUATION §30.1),
 *     which is what this prices — but quota is not money.
 *
 * So: a span carrying `dsb.gen_ai.cost.usd` also carries
 * `dsb.gen_ai.cost.rate_source`, and a reader who wants to know what the number
 * means can follow that string to this file.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHERE THE RATES CAME FROM, AND WHEN.
 *
 * Read 23 Aug 2026 from Groq's own model documentation — first-party, not a
 * third-party aggregator:
 *
 *   https://console.groq.com/docs/model/openai/gpt-oss-120b
 *     input          $0.15  per 1M tokens
 *     cached input   $0.075 per 1M tokens
 *     output         $0.60  per 1M tokens
 *
 * Corroborated by Groq's own announcement of the reduction:
 *   https://groq.com/blog/gpt-oss-improvements-prompt-caching-and-lower-pricing
 *
 * RATE_SOURCE below is stamped onto every span and into every artifact this
 * table prices, so a figure quoted anywhere can be traced to a rate and a date.
 * CHANGE THE DATE IF YOU CHANGE A RATE — a stale rate under a current date is
 * worse than no rate at all, and tests/observability.cost.test.js pins the
 * stamp so an edited number with an unedited date turns the suite red.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY AN UNKNOWN MODEL IS LABELLED RATHER THAN LEFT BLANK.
 *
 * `MODEL` is imported by studyPack.service.js from llm.service.js and has
 * already changed once under this project's feet — §28 records five features
 * returning 500 to every user because a model id was retired. If the id moves
 * again to something this table does not price, a silently ABSENT cost
 * attribute is indistinguishable from broken instrumentation.
 *
 * So an unpriced model yields `{ usd: null, rateSource: 'unpriced:<model>' }`:
 * the span still says something, and what it says is true. This is §23.3's rule
 * — "rows nothing can identify are labelled `unknown`, and that is a value, not
 * a blank" — applied to a span instead of a database row. Note the parallel is
 * exact in one more way: `usd: 0` is NOT used, because zero is a real price.
 */

/**
 * Stamped onto every priced span and artifact. Bump the date with the rates.
 */
const RATE_SOURCE = 'groq-list-price-2026-08-23';

/**
 * Published list prices in USD per 1,000,000 tokens.
 *
 * `cachedInput` is recorded for completeness and is NOT used by
 * computeCostUsd(): nothing in this repository can observe whether a call hit
 * Groq's automatic prompt cache, so pricing every input token at the full rate
 * is the honest direction to be wrong in.
 */
const RATES_PER_MILLION = Object.freeze({
  'openai/gpt-oss-120b': Object.freeze({ input: 0.15, cachedInput: 0.075, output: 0.60 })
});

/** What a model with no published rate in this table reports instead. */
function unpricedSource(model) {
  return `unpriced:${model}`;
}

/**
 * Price one call. PURE — no clock, no network, no environment.
 *
 * Returns `{ usd, rateSource, priced }`. `usd` is null exactly when `priced` is
 * false, which happens when the model is absent from the table or either token
 * count is not a non-negative finite number. A missing `usage` block from the
 * API is therefore unpriced rather than priced at zero.
 *
 * NO ROUNDING. A study pack costs on the order of $0.0013, so rounding to cents
 * — or to any fixed number of places chosen without looking at the magnitude —
 * would report every call as free. Presentation formats; this returns the
 * quantity.
 */
function computeCostUsd(model, inputTokens, outputTokens) {
  const rate = RATES_PER_MILLION[model];
  if (!rate) return { usd: null, rateSource: unpricedSource(model), priced: false };

  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    return { usd: null, rateSource: RATE_SOURCE, priced: false };
  }

  const usd = (inputTokens * rate.input + outputTokens * rate.output) / 1e6;
  return { usd, rateSource: RATE_SOURCE, priced: true };
}

function isTokenCount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

module.exports = { RATE_SOURCE, RATES_PER_MILLION, computeCostUsd, unpricedSource };
