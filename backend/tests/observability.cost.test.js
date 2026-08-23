'use strict';

/**
 * observability.cost.test.js — Phase 6.2. PURE.
 *
 * No database, no network, no API key, no gitignored corpus, and — the part
 * that matters here — NO OpenTelemetry SDK. It adds no precondition, so the
 * skip ledger does not move and ci.yml is untouched.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY A FAKE TRACER PROVIDER INSTEAD OF THE REAL IN-MEMORY EXPORTER.
 *
 * @opentelemetry/sdk-trace-base ships an InMemorySpanExporter that would make
 * the span assertions below trivial. It is NOT used, because it reaches this
 * repository only as a TRANSITIVE dependency of @opentelemetry/sdk-node, which
 * §37.1 put in devDependencies on purpose and which the api image drops with
 * `--omit=dev`. A test depending on a transitive dep is a test that breaks on
 * somebody else's minor bump, and promoting it to a direct dependency would buy
 * a twelfth runtime package for an assertion.
 *
 * So the fake below is built from @opentelemetry/api alone — already a runtime
 * dependency because observability/index.js imports it unconditionally. It
 * records what withSpan() actually put on a span, which is a real end-to-end
 * assertion in miniature rather than a source-text grep.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS ACTUALLY FOR.
 *
 *   §28.3   a feature can be entirely dead while `npm test` passes green. The
 *           attributes 6.2 adds appear only on a real completion, so without
 *           these tests the only proof they work costs quota every time.
 *   claims  CLAUDE.md forbids a number without the file it came from. The rate
 *           stamp is pinned here so an edited rate under an unedited date fails.
 *   §23.3   an unidentifiable thing gets a LABEL, never a blank and never a
 *           zero. Applied to a span instead of a database row.
 */

const { trace } = require('@opentelemetry/api');

const { RATE_SOURCE, RATES_PER_MILLION, computeCostUsd, unpricedSource } =
  require('../observability/cost');
const { GEN_AI, DSB_COST, SPANS, withSpan } = require('../observability');

const SHIPPED = 'openai/gpt-oss-120b';

describe('the rate table is a published list price, and it says which one', () => {
  test('the stamp names the source and the date it was read', () => {
    // Pinned so that changing a rate without changing the date turns this red.
    // A stale rate under a current date is worse than no rate at all.
    expect(RATE_SOURCE).toBe('groq-list-price-2026-08-23');
  });

  test('the shipped model is priced, at Groq\'s published per-million rates', () => {
    // https://console.groq.com/docs/model/openai/gpt-oss-120b — read 23 Aug 2026.
    expect(RATES_PER_MILLION[SHIPPED]).toEqual({ input: 0.15, cachedInput: 0.075, output: 0.60 });
  });

  test('output is priced above input, which is why output dominates the bill', () => {
    const { input, output } = RATES_PER_MILLION[SHIPPED];
    expect(output).toBeGreaterThan(input);
  });

  test('the table is frozen, so a caller cannot edit the rate it is quoting', () => {
    expect(Object.isFrozen(RATES_PER_MILLION)).toBe(true);
    expect(Object.isFrozen(RATES_PER_MILLION[SHIPPED])).toBe(true);
  });
});

describe('computeCostUsd prices a call, and refuses rather than guessing', () => {
  test('the arithmetic is (in x input + out x output) / 1e6', () => {
    const { usd, priced, rateSource } = computeCostUsd(SHIPPED, 1_000_000, 1_000_000);
    expect(priced).toBe(true);
    expect(rateSource).toBe(RATE_SOURCE);
    expect(usd).toBeCloseTo(0.75, 10);
  });

  test('6.1\'s own call, re-priced from the numbers in tracing-verification.txt', () => {
    // 573 prompt + 1501 completion, the first live call ever made at 4096.
    const { usd } = computeCostUsd(SHIPPED, 573, 1501);
    expect(usd).toBeCloseTo(0.00098655, 12);
  });

  test('zero tokens is a PRICE of zero, which is not the same as unpriced', () => {
    const { usd, priced } = computeCostUsd(SHIPPED, 0, 0);
    expect(priced).toBe(true);
    expect(usd).toBe(0);
  });

  test('NO ROUNDING — a study pack costs ~$0.0013 and rounding reports it free', () => {
    const { usd } = computeCostUsd(SHIPPED, 1403, 1832);
    expect(usd).toBeGreaterThan(0);
    expect(Number(usd.toFixed(2))).toBe(0);   // this is what rounding would say
  });

  test('an UNKNOWN MODEL is labelled, not blanked and not priced at zero', () => {
    // §23.3: "rows nothing can identify are labelled unknown, and that is a
    // value, not a blank." A silently absent cost is indistinguishable from
    // broken instrumentation. usd:0 is refused because zero is a real price.
    const r = computeCostUsd('some/model-that-does-not-exist', 100, 100);
    expect(r.priced).toBe(false);
    expect(r.usd).toBeNull();
    expect(r.usd).not.toBe(0);
    expect(r.rateSource).toBe('unpriced:some/model-that-does-not-exist');
    expect(r.rateSource).toBe(unpricedSource('some/model-that-does-not-exist'));
  });

  test.each([
    ['undefined tokens', undefined, 10],
    ['null tokens', null, 10],
    ['NaN', NaN, 10],
    ['Infinity', Infinity, 10],
    ['negative', -1, 10],
    ['a numeric string', '100', 10],
    ['missing output', 10, undefined]
  ])('%s is unpriced rather than coerced', (_label, input, output) => {
    const r = computeCostUsd(SHIPPED, input, output);
    expect(r.priced).toBe(false);
    expect(r.usd).toBeNull();
    // The MODEL was known, so the stamp still names the live table — this is a
    // missing-usage case, not an unpriced-model case, and they must not blur.
    expect(r.rateSource).toBe(RATE_SOURCE);
  });

  test('it is pure — same inputs, same output, no shared state', () => {
    const a = computeCostUsd(SHIPPED, 1234, 5678);
    const b = computeCostUsd(SHIPPED, 1234, 5678);
    expect(a).toEqual(b);
  });
});

describe('llmResponseAttributes turns a completion into 6.2\'s attributes', () => {
  const { llmResponseAttributes } = require('../observability');

  const completion = (over = {}) => ({
    model: SHIPPED,
    choices: [{ finish_reason: 'stop' }],
    usage: { prompt_tokens: 573, completion_tokens: 1501 },
    ...over
  });

  test('a normal completion yields all six, spelled the convention\'s way', () => {
    const a = llmResponseAttributes(completion(), SHIPPED);
    expect(a).toEqual({
      'gen_ai.response.model': SHIPPED,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 573,
      'gen_ai.usage.output_tokens': 1501,
      'dsb.gen_ai.cost.rate_source': RATE_SOURCE,
      'dsb.gen_ai.cost.usd': 0.00098655
    });
  });

  test('finish_reasons is an ARRAY even for one choice', () => {
    const a = llmResponseAttributes(completion(), SHIPPED);
    expect(Array.isArray(a[GEN_AI.RESPONSE_FINISH_REASONS])).toBe(true);
    expect(a[GEN_AI.RESPONSE_FINISH_REASONS]).toEqual(['stop']);
  });

  test('truncation shows up as finish_reasons=[length], which is 23.3% of the ledger', () => {
    const a = llmResponseAttributes(completion({ choices: [{ finish_reason: 'length' }] }), SHIPPED);
    expect(a[GEN_AI.RESPONSE_FINISH_REASONS]).toEqual(['length']);
  });

  test('a RESPONSE MODEL that differs from the request is reported as it came back', () => {
    // §28.9's failure mode: a retired id is loud, a silently swapped one is not.
    // The span must show what ANSWERED, not only what was asked for.
    const a = llmResponseAttributes(completion({ model: 'openai/gpt-oss-20b' }), SHIPPED);
    expect(a[GEN_AI.RESPONSE_MODEL]).toBe('openai/gpt-oss-20b');
    // And it must be priced — or refused — as the model that actually ran.
    expect(a[DSB_COST.RATE_SOURCE]).toBe('unpriced:openai/gpt-oss-20b');
    expect(a).not.toHaveProperty([DSB_COST.USD]);
  });

  test('a missing usage block OMITS the token attributes rather than reporting 0', () => {
    // output_tokens=0 is a claim that the model emitted nothing, which is a
    // different and far more interesting event than "usage was absent".
    const a = llmResponseAttributes(completion({ usage: undefined }), SHIPPED);
    expect(a).not.toHaveProperty([GEN_AI.USAGE_INPUT_TOKENS]);
    expect(a).not.toHaveProperty([GEN_AI.USAGE_OUTPUT_TOKENS]);
    expect(a).not.toHaveProperty([DSB_COST.USD]);
    // But the rate source still appears, so the absence is EXPLAINED.
    expect(a[DSB_COST.RATE_SOURCE]).toBe(RATE_SOURCE);
  });

  test('an empty choices array omits finish_reasons rather than inventing one', () => {
    const a = llmResponseAttributes(completion({ choices: [] }), SHIPPED);
    expect(a).not.toHaveProperty([GEN_AI.RESPONSE_FINISH_REASONS]);
  });

  test('it does not throw on a malformed response, because instrumentation must not', () => {
    // A tracer that crashes the request it is measuring is worse than no tracer.
    for (const bad of [undefined, null, {}, { choices: null }, { usage: null }]) {
      expect(() => llmResponseAttributes(bad, SHIPPED)).not.toThrow();
    }
  });

  test('falling back to the requested model still prices the call', () => {
    const a = llmResponseAttributes(completion({ model: undefined }), SHIPPED);
    expect(a[GEN_AI.RESPONSE_MODEL]).toBe(SHIPPED);
    expect(a[DSB_COST.USD]).toBeCloseTo(0.00098655, 12);
  });

  test('a cost figure NEVER appears without its rate source', () => {
    for (const c of [completion(), completion({ usage: undefined }),
                     completion({ model: 'x/y' }), completion({ choices: [] })]) {
      const a = llmResponseAttributes(c, SHIPPED);
      if (DSB_COST.USD in a) expect(a).toHaveProperty([DSB_COST.RATE_SOURCE]);
    }
  });
});

describe('the attributes actually land on the span, with no SDK involved', () => {
  // A minimal recording tracer built from @opentelemetry/api alone. See the
  // header for why the real InMemorySpanExporter is refused.
  let recorded;

  const fakeSpan = (name, attributes) => {
    // `createdWith` is frozen at construction and `attributes` accumulates, so
    // "applied at span START" is a property a test can distinguish from
    // "applied first thing inside the callback". They differ for a sampler,
    // which sees only what existed when the span was created.
    const entry = { name, createdWith: { ...attributes }, attributes: { ...attributes } };
    recorded.push(entry);
    return {
      setAttribute(k, v) { entry.attributes[k] = v; return this; },
      setAttributes(obj) { Object.assign(entry.attributes, obj); return this; },
      setStatus() { return this; },
      recordException() { return this; },
      isRecording() { return true; },
      end() { entry.ended = true; }
    };
  };

  const fakeProvider = {
    getTracer: () => ({
      startActiveSpan(name, options, fn) {
        return fn(fakeSpan(name, (options && options.attributes) || {}));
      }
    })
  };

  beforeEach(() => {
    recorded = [];
    trace.setGlobalTracerProvider(fakeProvider);
  });

  afterEach(() => {
    // trace.disable() clears the global provider so the rest of the suite goes
    // back to the API package's no-op. Leaving it registered would leak a
    // recording tracer into every other test file in the same worker.
    trace.disable();
  });

  test('start attributes and response attributes end up on ONE span together', async () => {
    const { llmResponseAttributes } = require('../observability');
    const response = {
      model: SHIPPED,
      choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 573, completion_tokens: 1501 }
    };

    await withSpan(SPANS.LLM_CALL, async (span) => {
      span.setAttributes(llmResponseAttributes(response, SHIPPED));
      return response;
    }, {
      [GEN_AI.OPERATION_NAME]: 'chat',
      [GEN_AI.PROVIDER_NAME]: 'groq',
      [GEN_AI.REQUEST_MODEL]: SHIPPED
    });

    expect(recorded).toHaveLength(1);
    const span = recorded[0];
    expect(span.name).toBe('llm-call');
    expect(span.ended).toBe(true);
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'groq',
      'gen_ai.request.model': SHIPPED,
      'gen_ai.response.model': SHIPPED,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 573,
      'gen_ai.usage.output_tokens': 1501,
      'dsb.gen_ai.cost.rate_source': RATE_SOURCE,
      'dsb.gen_ai.cost.usd': 0.00098655
    });
  });

  test('A FAILED CALL KEEPS ITS IDENTITY AND SIMPLY HAS NO USAGE', async () => {
    // This is why the identifying three are applied at span START. A 429 or a
    // timeout must still produce a span you can find by model and provider;
    // moving them into the callback would make every failed call anonymous.
    await expect(withSpan(SPANS.LLM_CALL, async () => {
      throw new Error('Groq rate limit hit');
    }, {
      [GEN_AI.OPERATION_NAME]: 'chat',
      [GEN_AI.PROVIDER_NAME]: 'groq',
      [GEN_AI.REQUEST_MODEL]: SHIPPED
    })).rejects.toThrow('Groq rate limit hit');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].attributes[GEN_AI.REQUEST_MODEL]).toBe(SHIPPED);
    expect(recorded[0].attributes).not.toHaveProperty([GEN_AI.USAGE_INPUT_TOKENS]);
    expect(recorded[0].attributes).not.toHaveProperty([DSB_COST.USD]);
    expect(recorded[0].ended).toBe(true);
  });

  test('THE IDENTIFYING THREE ARE PASSED AT SPAN CREATION, NOT SET AFTERWARDS', () => {
    // Nearly behaviour-preserving to get wrong, which is why it is asserted
    // rather than trusted: a mutation moving these into the callback survived
    // every other test in this file. Attributes present at creation are what a
    // sampler can act on; attributes set a line later are not.
    withSpan(SPANS.LLM_CALL, () => 'ok', {
      [GEN_AI.OPERATION_NAME]: 'chat',
      [GEN_AI.PROVIDER_NAME]: 'groq',
      [GEN_AI.REQUEST_MODEL]: SHIPPED
    });
    expect(recorded[0].createdWith).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'groq',
      'gen_ai.request.model': SHIPPED
    });
  });

  test('the fake is not vacuous — it records nothing when nothing is traced', () => {
    expect(recorded).toEqual([]);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REAL CALL SITE, WITH THE NETWORK REMOVED — STILL PURE.
 *
 * Everything above tests llmResponseAttributes() and a hand-built span. This
 * block drives the ACTUAL generate() in services/studyPack.service.js with
 * groq-sdk mocked, so the wiring between them is exercised rather than grepped.
 *
 * WHY IT IS WORTH A SEPARATE BLOCK. During a mutation pass, deleting the single
 * `span.setAttributes(...)` line at the call site — which returns the span to
 * exactly its 6.1 shape — was caught by ONE test, and that test read source text
 * rather than behaviour. §22.6's whole subject is a check that runs and cannot
 * fail; a source grep is one rename away from being that. This block makes the
 * same mutation a behavioural failure.
 *
 * No network and no key: `groq-sdk` is replaced, and GROQ_API_KEY is set to a
 * placeholder for the duration of each test and restored afterwards, so the
 * `groq` precondition other suites depend on is not disturbed.
 */
jest.mock('groq-sdk');

describe('the shipped generate() annotates its span from the real response', () => {
  const Groq = require('groq-sdk');
  const studyPack = require('../services/studyPack.service');

  let recorded;
  let savedKey;

  const fakeSpan = (name, attributes) => {
    // `createdWith` is frozen at construction and `attributes` accumulates, so
    // "applied at span START" is a property a test can distinguish from
    // "applied first thing inside the callback". They differ for a sampler,
    // which sees only what existed when the span was created.
    const entry = { name, createdWith: { ...attributes }, attributes: { ...attributes } };
    recorded.push(entry);
    return {
      setAttribute(k, v) { entry.attributes[k] = v; return this; },
      setAttributes(obj) { Object.assign(entry.attributes, obj); return this; },
      setStatus() { return this; },
      recordException() { return this; },
      isRecording() { return true; },
      end() { entry.ended = true; }
    };
  };

  const provider = {
    getTracer: () => ({
      startActiveSpan: (name, options, fn) => fn(fakeSpan(name, (options && options.attributes) || {}))
    })
  };

  const respond = (completion) => {
    Groq.mockImplementation(() => ({
      chat: { completions: { create: jest.fn().mockResolvedValue(completion) } }
    }));
  };

  beforeEach(() => {
    recorded = [];
    savedKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'test-key-not-a-real-credential';
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(() => {
    trace.disable();
    if (savedKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedKey;
    jest.clearAllMocks();
  });

  test('all nine attributes are on the llm-call span after a real generate()', async () => {
    respond({
      model: SHIPPED,
      choices: [{ finish_reason: 'stop', message: { content: '{"flashcards":[],"concepts":[]}' } }],
      usage: { prompt_tokens: 1403, completion_tokens: 1832, total_tokens: 3235 }
    });

    await studyPack.generate('some context text', 4);

    const span = recorded.find((s) => s.name === 'llm-call');
    expect(span).toBeDefined();
    expect(span.ended).toBe(true);
    // The identifying three exist before the API answers; the response six
    // cannot, which is the whole reason 6.2 annotates at END as well as START.
    expect(Object.keys(span.createdWith).sort())
      .toEqual(['gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model']);
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'groq',
      'gen_ai.request.model': SHIPPED,
      'gen_ai.response.model': SHIPPED,
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 1403,
      'gen_ai.usage.output_tokens': 1832,
      'dsb.gen_ai.cost.rate_source': RATE_SOURCE,
      // 1403 x 0.15/1e6 + 1832 x 0.60/1e6. This is the mean-shaped study pack
      // from the 30-call gen-v5 ledger; EVALUATION §38.4 prices the whole run.
      'dsb.gen_ai.cost.usd': 0.00130965
    });
  });

  test('a TRUNCATED pack is visible on the span as finish_reasons=[length]', async () => {
    // 23.3% of the 30-call ledger finished this way at max_tokens 2048. The
    // shipped ceiling is 4096 and the rate at it is UNMEASURED (§35.3); what
    // this asserts is only that the span would say so.
    respond({
      model: SHIPPED,
      choices: [{ finish_reason: 'length', message: { content: '{"flashcards":[' } }],
      usage: { prompt_tokens: 1500, completion_tokens: 4096, total_tokens: 5596 }
    });

    await studyPack.generate('some context text', 4);

    const span = recorded.find((s) => s.name === 'llm-call');
    expect(span.attributes[GEN_AI.RESPONSE_FINISH_REASONS]).toEqual(['length']);
    expect(span.attributes[GEN_AI.USAGE_OUTPUT_TOKENS]).toBe(4096);
  });

  test('A SILENTLY SWAPPED MODEL SHOWS UP AS A REQUEST/RESPONSE MISMATCH', async () => {
    // CLAUDE.md §28.9: "a retired id is loud, a silently swapped model is not"
    // — the one failure mode gen:probe cannot see. A trace carrying only the
    // requested model could not show it; carrying both is what makes it a query.
    respond({
      model: 'openai/gpt-oss-20b',
      choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    });

    await studyPack.generate('some context text', 4);

    const span = recorded.find((s) => s.name === 'llm-call');
    expect(span.attributes[GEN_AI.REQUEST_MODEL]).toBe(SHIPPED);
    expect(span.attributes[GEN_AI.RESPONSE_MODEL]).toBe('openai/gpt-oss-20b');
    expect(span.attributes[GEN_AI.RESPONSE_MODEL]).not.toBe(span.attributes[GEN_AI.REQUEST_MODEL]);
    // And the unknown model is refused a price rather than charged at the
    // shipped model's rate, which would be a plausible and wrong number.
    expect(span.attributes[DSB_COST.RATE_SOURCE]).toBe('unpriced:openai/gpt-oss-20b');
    expect(span.attributes).not.toHaveProperty([DSB_COST.USD]);
  });

  test('a FAILING call keeps its identity, reports no usage, and still rethrows', async () => {
    Groq.mockImplementation(() => ({
      chat: { completions: { create: jest.fn().mockRejectedValue(
        Object.assign(new Error('429 rate_limit_exceeded'), { status: 429 })
      ) } }
    }));

    await expect(studyPack.generate('some context text', 4)).rejects.toThrow(/rate limit/i);

    const span = recorded.find((s) => s.name === 'llm-call');
    expect(span.attributes[GEN_AI.REQUEST_MODEL]).toBe(SHIPPED);
    expect(span.attributes).not.toHaveProperty([GEN_AI.USAGE_INPUT_TOKENS]);
    expect(span.attributes).not.toHaveProperty([DSB_COST.USD]);
    expect(span.ended).toBe(true);
  });
});
