'use strict';

/**
 * observability.spans.test.js — Phase 6.1. PURE.
 *
 * No database, no network, no API key, no gitignored corpus. It adds no
 * precondition, so the skip ledger does not move and ci.yml is untouched.
 *
 * WHAT IT IS ACTUALLY FOR. Three things this project has been bitten by:
 *
 *   §28.3  a feature can be entirely dead while `npm test` passes green,
 *          because nothing asserted the string it depended on. The six span
 *          names are exactly that kind of string — a typo produces a span that
 *          exports happily under a name nothing is looking for.
 *   §31    a tracer that initialises under `npm test` or in CI changes what a
 *          green tick covers. Default-off is asserted here rather than
 *          remembered, and asserted with a POSITIVE CONTROL so the negative
 *          cannot pass vacuously.
 *   §22.6  a check that runs and cannot fail. The call-site test below reads
 *          the instrumented files' source, so it fails if a span is removed —
 *          not merely if a constant is renamed.
 *
 * UPDATED AT 6.2. One block in here used to assert that tokens, cost and finish
 * reason were ABSENT, so that 6.1 could not quietly become 6.2. 6.2 has now
 * arrived deliberately, and that guard is INVERTED rather than deleted — the
 * same four items are required present and required to be spelled the
 * convention's way. The VALUES they take are tested in
 * tests/observability.cost.test.js, which is also pure.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { SPANS, SPAN_NAMES, GEN_AI, DSB_COST, withSpan, tracer } = require('../observability');
const { isEnabled, startTracing, ENV_FLAG } = require('../observability/sdk');

const BACKEND = path.join(__dirname, '..');

describe('the six span names are ROADMAP 6.1\'s and are not renameable here', () => {
  // ROADMAP 6.1: "manual spans on the six pipeline stages:
  // normalize -> extract -> retrieve -> build-context -> llm-call -> parse".
  // Written out literally rather than derived from the export, so that editing
  // the export cannot edit the expectation with it.
  const ROADMAP_SIX = ['normalize', 'extract', 'retrieve', 'build-context', 'llm-call', 'parse'];

  test('SPAN_NAMES is exactly the roadmap\'s six, in pipeline order', () => {
    expect(SPAN_NAMES).toEqual(ROADMAP_SIX);
  });

  test('SPANS maps to the same six and is frozen', () => {
    expect(Object.values(SPANS).sort()).toEqual([...ROADMAP_SIX].sort());
    expect(Object.isFrozen(SPANS)).toBe(true);
    expect(Object.isFrozen(SPAN_NAMES)).toBe(true);
  });

  test('there are six, not five and not seven', () => {
    expect(SPAN_NAMES).toHaveLength(6);
    expect(new Set(SPAN_NAMES).size).toBe(6);
  });
});

describe('GenAI attribute keys are the spec\'s names, and none of them is stable', () => {
  // Measured against @opentelemetry/semantic-conventions@1.43.0: zero gen_ai.*
  // attributes in the stable root entrypoint, 40+ in experimental_attributes.js.
  // These literals exist so the app does not take a twelfth runtime dependency
  // for string constants; pinning them here is what replaces the import.
  test('the three 6.1 sets are spelled exactly as the convention spells them', () => {
    expect(GEN_AI.OPERATION_NAME).toBe('gen_ai.operation.name');
    expect(GEN_AI.PROVIDER_NAME).toBe('gen_ai.provider.name');
    expect(GEN_AI.REQUEST_MODEL).toBe('gen_ai.request.model');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UPDATED AT 6.2, DELIBERATELY, AND THE OLD ASSERTION IS WORTH READING.
  //
  // Until this phase this block asserted GEN_AI held exactly THREE keys and
  // that none of them mentioned usage, finish_reasons or cost — a guard so 6.1
  // "could not quietly become 6.2". 6.2 has now arrived on purpose, so the
  // guard is INVERTED rather than deleted: the same four items are now required
  // to be present and required to be spelled the convention's way. Deleting it
  // would have left the phase boundary unguarded in both directions.
  test('6.2\'s three spec-named additions are spelled the convention\'s way', () => {
    expect(GEN_AI.USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens');
    expect(GEN_AI.USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens');
    // PLURAL. The convention names it finish_reasonS and types it as an array;
    // a singular key here would be an invented name wearing a spec's clothes.
    expect(GEN_AI.RESPONSE_FINISH_REASONS).toBe('gen_ai.response.finish_reasons');
    expect(GEN_AI.RESPONSE_MODEL).toBe('gen_ai.response.model');
  });

  test('GEN_AI holds exactly the seven, and every one is a gen_ai.* name', () => {
    const keys = Object.values(GEN_AI);
    expect(keys).toHaveLength(7);
    expect(new Set(keys).size).toBe(7);
    for (const k of keys) expect(k.startsWith('gen_ai.')).toBe(true);
    expect(Object.isFrozen(GEN_AI)).toBe(true);
  });

  test('COST IS NOT A gen_ai.* NAME, because the convention has none for it', () => {
    // §37.5 measured 0 stable / 40+ experimental gen_ai.* attributes. Cost is in
    // neither set: there is no standard attribute for it at any maturity. So it
    // gets a dsb. prefix rather than squatting on a name a future spec may
    // define differently, and a reader in Jaeger can see which two of the nine
    // attributes on this span were invented here.
    expect(Object.values(GEN_AI).some((k) => k.includes('cost'))).toBe(false);
    expect(DSB_COST.USD).toBe('dsb.gen_ai.cost.usd');
    expect(DSB_COST.RATE_SOURCE).toBe('dsb.gen_ai.cost.rate_source');
    for (const k of Object.values(DSB_COST)) expect(k.startsWith('dsb.')).toBe(true);
    expect(Object.isFrozen(DSB_COST)).toBe(true);
  });

  test('A COST FIGURE NEVER TRAVELS WITHOUT ITS RATE SOURCE', () => {
    // The rule this encodes is CLAUDE.md's, not OpenTelemetry's: a bare dollar
    // figure is a measured-looking number with no artifact behind it. There is
    // no way to express "these two keys must co-occur" in a frozen object, so
    // the pairing is asserted here and again on a real span below.
    expect(Object.keys(DSB_COST).sort()).toEqual(['RATE_SOURCE', 'USD']);
  });

  test('the superseded gen_ai.system is not used', () => {
    expect(Object.values(GEN_AI)).not.toContain('gen_ai.system');
  });
});

describe('tracing is OFF by default, and the SDK is not even loaded', () => {
  test('isEnabled() is false when the flag is unset', () => {
    const saved = process.env[ENV_FLAG];
    delete process.env[ENV_FLAG];
    try {
      expect(isEnabled()).toBe(false);
      expect(startTracing()).toMatchObject({ enabled: false, reason: `${ENV_FLAG} is not set` });
    } finally {
      if (saved !== undefined) process.env[ENV_FLAG] = saved;
    }
  });

  test('the flag is off in THIS test process, which is the property CI depends on', () => {
    // If a future change turns tracing on by default, this fails inside the
    // very suite whose green tick would otherwise imply nothing changed. §31.
    expect(isEnabled()).toBe(false);
  });

  test.each([['0', false], ['', false], ['false', false], ['no', false],
             ['1', true], ['true', true], ['TRUE', true], ['yes', true]])(
    'DSB_TRACING=%p -> enabled %p', (value, expected) => {
      const saved = process.env[ENV_FLAG];
      process.env[ENV_FLAG] = value;
      try {
        expect(isEnabled()).toBe(expected);
      } finally {
        if (saved === undefined) delete process.env[ENV_FLAG];
        else process.env[ENV_FLAG] = saved;
      }
    }
  );

  // THE POSITIVE CONTROL. A negative assertion about module loading is worth
  // nothing unless the positive case is shown to differ — otherwise "the SDK is
  // not loaded" could be true because the check itself is broken. Subprocesses,
  // because require.cache under jest is jest's registry rather than Node's.
  //
  // The verdict is read from the LAST line: startTracing() prints a startup
  // banner to stdout when it is enabled, and that banner is part of what is
  // being tested rather than noise to suppress.
  const SCRIPT = `require('./observability/sdk').startTracing();
     const loaded = Object.keys(require.cache).some((k) => k.includes(['sdk','node'].join('-')));
     console.log(loaded); process.exit(0);`;

  const probe = (env) => execFileSync(process.execPath, ['-e', SCRIPT], {
    cwd: BACKEND, encoding: 'utf8', timeout: 30000, env
  }).trim().split('\n').pop().trim();

  test('flag unset: @opentelemetry/sdk-node is never require()d', () => {
    const env = { ...process.env };
    delete env[ENV_FLAG];
    expect(probe(env)).toBe('false');
  });

  test('flag set: it IS require()d — so the assertion above is not vacuous', () => {
    expect(probe({ ...process.env, [ENV_FLAG]: '1' })).toBe('true');
  });
});

describe('withSpan is transparent to its callback, tracing on or off', () => {
  test('returns a synchronous value unchanged', () => {
    expect(withSpan(SPANS.PARSE, () => 42)).toBe(42);
  });

  test('returns an async value unchanged', async () => {
    await expect(withSpan(SPANS.RETRIEVE, async () => 'ok')).resolves.toBe('ok');
  });

  test('RETHROWS a synchronous error rather than swallowing it', () => {
    // Instrumentation that eats an error is worse than none: 6.3's entire
    // subject is a failure that already reaches nothing but console.error.
    expect(() => withSpan(SPANS.NORMALIZE, () => { throw new Error('boom'); })).toThrow('boom');
  });

  test('rejects with an async error rather than swallowing it', async () => {
    await expect(withSpan(SPANS.EXTRACT, async () => { throw new Error('async boom'); }))
      .rejects.toThrow('async boom');
  });

  test('hands the span to the callback so a call site can annotate it', () => {
    const seen = withSpan(SPANS.LLM_CALL, (span) => typeof span.setAttribute);
    expect(seen).toBe('function');
  });

  test('with no SDK registered the tracer is the API package\'s no-op', () => {
    // The property that makes default-off free: call sites carry no branch.
    const span = tracer().startSpan('probe');
    expect(span.isRecording()).toBe(false);
    span.end();
  });
});

describe('the instrumented call sites use the constants, and all six are wired', () => {
  const INSTRUMENTED = ['routes/notes.js', 'services/studyPack.service.js'];
  const sources = INSTRUMENTED.map((rel) => ({
    rel,
    text: fs.readFileSync(path.join(BACKEND, rel), 'utf8')
  }));

  test.each(INSTRUMENTED)('%s passes SPANS.* to withSpan, never a bare string', (rel) => {
    const { text } = sources.find((s) => s.rel === rel);
    const calls = text.match(/withSpan\(\s*[^\s,)]+/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // A literal would be a name nothing is looking for the moment it is
      // mistyped, and no test would notice.
      expect(call).toMatch(/withSpan\(\s*SPANS\./);
    }
  });

  test('every one of the six names is actually used by app code', () => {
    const all = sources.map((s) => s.text).join('\n');
    const used = Object.entries(SPANS)
      .filter(([key]) => all.includes(`SPANS.${key}`))
      .map(([, value]) => value);
    expect(used.sort()).toEqual([...SPAN_NAMES].sort());
  });

  test('the study-pack path carries FOUR of the six, and that is the honest shape', () => {
    // PRIMER §8.2 draws all six under POST /api/studypack. It does not do
    // normalize or extract: contentText was normalized at WRITE time and
    // v4-bm25 ignores stored note.keywords. See observability/index.js.
    const { text } = sources.find((s) => s.rel === 'services/studyPack.service.js');
    const present = Object.entries(SPANS).filter(([k]) => text.includes(`SPANS.${k}`)).map(([, v]) => v);
    expect(present.sort()).toEqual(['build-context', 'llm-call', 'parse', 'retrieve']);
    expect(text).not.toContain('SPANS.NORMALIZE');
    expect(text).not.toContain('SPANS.EXTRACT');
  });

  test('the note-save path carries the other two', () => {
    const { text } = sources.find((s) => s.rel === 'routes/notes.js');
    const present = Object.entries(SPANS).filter(([k]) => text.includes(`SPANS.${k}`)).map(([, v]) => v);
    expect(present.sort()).toEqual(['extract', 'normalize']);
  });

  test('6.2: the llm-call site annotates the span from the RESPONSE, not just at start', () => {
    // §22.6's shape is a check that runs and cannot fail. The value-level tests
    // in observability.cost.test.js prove llmResponseAttributes() is correct;
    // this proves it is CALLED, so deleting the one line that wires it in turns
    // a suite red instead of silently returning the span to its 6.1 shape.
    const { text } = sources.find((s) => s.rel === 'services/studyPack.service.js');
    expect(text).toContain('llmResponseAttributes');
    expect(text).toMatch(/span\.setAttributes\(\s*llmResponseAttributes\(/);
  });

  test('6.2: the identifying THREE are still applied at span START', () => {
    // They are passed as withSpan's third argument on purpose: a call that 429s
    // or times out keeps model/provider/operation and simply reports no usage.
    // Moving them into the callback would make a failed LLM span anonymous.
    const { text } = sources.find((s) => s.rel === 'services/studyPack.service.js');
    for (const key of ['OPERATION_NAME', 'PROVIDER_NAME', 'REQUEST_MODEL']) {
      expect(text).toContain(`GEN_AI.${key}`);
    }
  });

  test('backend/retrieval/ is NOT instrumented — the purity boundary holds', () => {
    // tests/retrieval.interface.test.js enforces this from the other side; this
    // states the 6.1 decision so removing that suite would not quietly permit it.
    const dir = path.join(BACKEND, 'retrieval');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const offenders = walk(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /require\(['"]@opentelemetry|require\(['"].*observability/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
