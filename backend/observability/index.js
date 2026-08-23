'use strict';

/**
 * observability/index.js — Phase 6.1. THE APP-SIDE INTERFACE.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IMPORTS, AND WHY IT IS THE ONLY OTel IMPORT IN app CODE.
 *
 * `@opentelemetry/api` and nothing else — plus `./cost`, a local pure module
 * with no dependencies of its own. It is the interface package: when no
 * SDK has been registered, `trace.getTracer()` returns a NoopTracer whose
 * `startActiveSpan` still invokes the callback with a NonRecordingSpan. So the
 * instrumented call sites in routes/ and services/ have NO branch in them —
 * they call withSpan() unconditionally and it costs a function call when
 * tracing is off. That is why this is the one OTel package in `dependencies`;
 * the SDK, the exporter and the two instrumentations are devDependencies and
 * are loaded only by observability/sdk.js, only when DSB_TRACING=1.
 *
 * The Dockerfile's api stage runs `npm --prefix backend ci --omit=dev`, so the
 * container image gains this file's one dependency and none of the other four.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE SIX NAMES ARE ROADMAP 6.1's AND ARE NOT RENAMEABLE HERE.
 *
 * `normalize → extract → retrieve → build-context → llm-call → parse`.
 * tests/observability.spans.test.js pins the exported list against exactly
 * those six strings, so renaming one turns the suite red rather than silently
 * producing a trace whose stage names no longer match the roadmap that ordered
 * them.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ TWO OF THE SIX ARE NOT ON THE STUDY-PACK PATH, AND PRIMER §8.2 DRAWS THEM
 * AS IF THEY WERE.
 *
 * §8.2's waterfall puts all six under `POST /api/studypack`. That picture was
 * drawn before the code was read, and it is wrong on two rows. Measured by
 * grep, not assumed:
 *
 *   normalizeContent()   routes/notes.js:112                  note SAVE only
 *   extractKeywords()    routes/notes.js:125, upload.js:57,
 *                        search.js:80                         never study pack
 *
 * A study pack reads `contentText`, which was normalized at WRITE time, and
 * `v4-bm25` ignores stored `note.keywords` entirely (CLAUDE.md's "two halves"
 * paragraph). So the six stages span TWO request paths:
 *
 *   note save            normalize · extract
 *   study pack           retrieve · build-context · llm-call · parse
 *
 * The names are kept and placed where the operations actually happen. A Study
 * Pack trace therefore carries FOUR of the six, which is the honest shape
 * rather than a diagram satisfied by moving a span somewhere it does not
 * belong. EVALUATION §37.2.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY `retrieve` HAS NO `index-lookup` CHILD, WHICH §8.2 ALSO DRAWS.
 *
 * The child would have to be created inside `backend/retrieval/`, and
 * tests/retrieval.interface.test.js walks that directory's require graph and
 * fails on any specifier resolving outside it, `crypto` excepted.
 * `@opentelemetry/api` resolves outside it. So retrieval stays pure and
 * `retrieve` is timed from the caller as one span covering index+search —
 * a real limit of the §7.1 boundary, not an omission.
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const { computeCostUsd } = require('./cost');

/**
 * The six stages ROADMAP 6.1 names, in pipeline order.
 *
 * Referenced by constant at every call site rather than by string literal, so
 * tests/observability.spans.test.js can assert BOTH that this object holds
 * exactly the roadmap's six names AND that no withSpan() call in routes/ or
 * services/ passes a bare string. A typo'd literal would otherwise produce a
 * span that exports happily under a name nothing is looking for.
 */
const SPANS = Object.freeze({
  NORMALIZE: 'normalize',
  EXTRACT: 'extract',
  RETRIEVE: 'retrieve',
  BUILD_CONTEXT: 'build-context',
  LLM_CALL: 'llm-call',
  PARSE: 'parse'
});

/** The same six, in pipeline order, as an array. */
const SPAN_NAMES = Object.freeze(Object.values(SPANS));

/**
 * GenAI attribute keys — AND NOT ONE OF THEM IS STABLE.
 *
 * ROADMAP 6.1 says to follow OTel's GenAI semantic conventions "where they are
 * stable rather than inventing attribute names". MEASURED against
 * @opentelemetry/semantic-conventions@1.43.0 rather than assumed:
 *
 *   gen_ai.* exported from the STABLE root entrypoint        0 attributes
 *   gen_ai.* exported from experimental_attributes.js       40+ attributes
 *
 * So the honest answer to "which did you judge stable" is NONE, and the whole
 * group is reachable only through the package's `/incubating` entrypoint.
 *
 * These are therefore the spec's names written as literals rather than
 * imported. Importing them would mean adding
 * @opentelemetry/semantic-conventions to `dependencies` — it is only a
 * TRANSITIVE dep of sdk-node, which is dev-only and absent from the api image
 * built with --omit=dev — i.e. a twelfth runtime dependency bought for string
 * constants. Written here in one place, pinned by a test, and labelled
 * experimental at the site so nobody mistakes them for a stable contract.
 *
 * `gen_ai.system` is deliberately absent: it is superseded by
 * `gen_ai.provider.name` in this same version.
 *
 * 6.1 SET THE THREE THAT IDENTIFY THE CALL. 6.2 ADDS THE FOUR THAT PRICE IT,
 * and the split is still visible below because it is the reason a test could
 * assert 6.1 had not quietly become 6.2.
 *
 * Three of 6.2's four have spec names and are spelled the spec's way:
 *
 *   gen_ai.usage.input_tokens        prompt tokens the API reported
 *   gen_ai.usage.output_tokens       completion tokens, reasoning INCLUDED
 *   gen_ai.response.finish_reasons   PLURAL, and an ARRAY — one choice still
 *                                    gets a one-element array, because the
 *                                    convention's shape is not ours to flatten
 *
 * RESPONSE_MODEL is 6.1's `gen_ai.request.model` seen from the other side, and
 * it is here for a documented reason rather than for symmetry: CLAUDE.md §28.9
 * names a silently swapped model as "the one failure mode `gen:probe` cannot
 * see" — a retired id is loud, a substituted one is not. The ledger already
 * records `model` beside `modelRequested`; a trace that shows only what was
 * ASKED FOR cannot show that something else answered.
 */
const GEN_AI = Object.freeze({
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons'
});

/**
 * COST HAS NO CONVENTION AT ALL, SO THESE TWO ARE THIS PROJECT'S OWN.
 *
 * §37.5 measured that the whole `gen_ai.*` group is experimental — 0 stable,
 * 40+ experimental in semantic-conventions@1.43.0. Cost is not even in the
 * experimental set: there is no standard attribute for it. So rather than
 * squatting on a `gen_ai.` name that a future spec might define differently,
 * these carry a `dsb.` prefix, which says "this project invented this" at a
 * glance in a trace UI beside seven attributes that did not have to be.
 *
 * TWO ATTRIBUTES, NOT ONE, AND THE SECOND IS THE POINT. A bare `0.0013` in a
 * span is a measured-looking number with nothing behind it. RATE_SOURCE names
 * the rate table and the date it was read, so a reader can follow the string to
 * observability/cost.js and find the published price, its URL, and the standing
 * warning that this project is on a free tier and the real invoice is $0.00.
 */
const DSB_COST = Object.freeze({
  USD: 'dsb.gen_ai.cost.usd',
  RATE_SOURCE: 'dsb.gen_ai.cost.rate_source'
});

/**
 * One tracer for the whole app. The name is the instrumentation scope and shows
 * in Jaeger beside every span this file creates, which is how a manual span is
 * told apart from one the Express auto-instrumentation produced.
 */
const TRACER_NAME = 'digital-second-brain';

function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Run `fn` inside a span named `name`, and return whatever `fn` returns.
 *
 * Handles sync and async uniformly: if `fn` returns a thenable the span ends on
 * settle, otherwise it ends on return. An exception is recorded and the span is
 * marked ERROR before it is RETHROWN — instrumentation that swallows an error
 * is a worse defect than no instrumentation, and 6.3's whole subject is a
 * failure that already reaches nothing but console.error.
 *
 * `attributes` is applied at start rather than at end so that a span which
 * throws still carries what it was asked to do.
 */
function withSpan(name, fn, attributes = {}) {
  return tracer().startActiveSpan(name, { attributes }, (span) => {
    let result;
    try {
      result = fn(span);
    } catch (err) {
      failSpan(span, err);
      span.end();
      throw err;
    }

    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          span.end();
          return value;
        },
        (err) => {
          failSpan(span, err);
          span.end();
          throw err;
        }
      );
    }

    span.end();
    return result;
  });
}

/**
 * `recordException` captures type, message and stack; the status is what turns
 * the bar red in the UI. Both, because either alone is half a report.
 */
function failSpan(span, err) {
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err && err.message || err) });
}

/**
 * Build 6.2's attributes from a Groq chat completion. PURE — takes the response
 * object, returns a plain object, touches no span and no clock.
 *
 * PURE ON PURPOSE, BECAUSE THE ALTERNATIVE IS UNTESTABLE WITHOUT QUOTA. If this
 * logic lived inline at the call site, the only way to check that
 * `finish_reasons` is an array or that a missing `usage` block does not price
 * at zero would be to spend a real completion on every assertion. It is called
 * from exactly one place and covered by tests/observability.cost.test.js
 * without a key, a network or a database.
 *
 * WHAT IT DOES WITH MISSING FIELDS, AND WHY NOT ZERO. An attribute is OMITTED
 * when the API did not report the thing — never defaulted to 0 or ''. A span
 * saying `output_tokens=0` is a claim that the model emitted nothing, which is
 * a different and much more interesting event than "the usage block was absent".
 * §23.3's both-null-or-both-real discipline, one layer out.
 *
 * COST IS THE ONE EXCEPTION, AND IT IS DELIBERATE: when the figure cannot be
 * computed, `usd` is omitted but RATE_SOURCE is still set — to `unpriced:<model>`
 * for a model the table does not know. An unexplained absence and broken
 * instrumentation look identical in a UI; a labelled one does not.
 */
function llmResponseAttributes(completion, requestedModel) {
  const attrs = {};
  const choices = Array.isArray(completion && completion.choices) ? completion.choices : [];
  const usage = (completion && completion.usage) || {};

  const model = (completion && completion.model) || requestedModel;
  if (model) attrs[GEN_AI.RESPONSE_MODEL] = model;

  // PLURAL and an ARRAY — the convention's shape, not flattened to the one
  // choice this app requests. A future n>1 would populate it without a change
  // here, and a reader comparing against the spec finds what the spec says.
  const finishReasons = choices
    .map((c) => c && c.finish_reason)
    .filter((r) => typeof r === 'string' && r.length > 0);
  if (finishReasons.length > 0) attrs[GEN_AI.RESPONSE_FINISH_REASONS] = finishReasons;

  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  if (Number.isFinite(inputTokens)) attrs[GEN_AI.USAGE_INPUT_TOKENS] = inputTokens;
  if (Number.isFinite(outputTokens)) attrs[GEN_AI.USAGE_OUTPUT_TOKENS] = outputTokens;

  // Reasoning tokens are INSIDE completion_tokens and are billed at the output
  // rate, so nothing is added or subtracted here. They are 61% of this model's
  // output on the 30-call gen-v5 ledger, which is a finding rather than a
  // correction — EVALUATION §38.4 — and they get no attribute of their own,
  // because 6.2 is four named items and there is no convention for a fifth.
  const { usd, rateSource } = computeCostUsd(model, inputTokens, outputTokens);
  if (rateSource) attrs[DSB_COST.RATE_SOURCE] = rateSource;
  if (usd !== null) attrs[DSB_COST.USD] = usd;

  return attrs;
}

module.exports = {
  SPANS, SPAN_NAMES, GEN_AI, DSB_COST, TRACER_NAME, withSpan, tracer, llmResponseAttributes
};
