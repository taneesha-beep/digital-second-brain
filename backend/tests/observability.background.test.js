'use strict';

/**
 * observability.background.test.js — Phase 6.3. PURE.
 *
 * No database, no network, no API key, no gitignored corpus, no OpenTelemetry
 * SDK. It adds no precondition, so the skip ledger does not move and ci.yml is
 * untouched.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT 6.3 IS, IN ONE PARAGRAPH, BECAUSE THE TESTS BELOW ONLY MAKE SENSE WITH
 * IT.
 *
 * `saveVersion` and `computeAndSaveLinks` fire un-awaited on every note save.
 * Their failures have reached nothing but console.error since the app was
 * written; PRIMER §9.1 has predicted that failure since the plan was drafted,
 * and 7.1 had to REJECT it from docs/FAILURE-MODES.md for having no frequency,
 * because no instrument existed that could count it. 6.3 gives each job a
 * DETACHED, LINKED span: a new root span in a new trace, carrying an OTel Link
 * back to the request that caused it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * A FAKE TRACER AND A FAKE CONTEXT MANAGER, BOTH BUILT FROM @opentelemetry/api
 * ALONE — 6.2's decision, applied unchanged.
 *
 * sdk-trace-base ships an InMemorySpanExporter and a real
 * AsyncLocalStorageContextManager that would make all of this trivial. Both
 * reach this repository only as TRANSITIVE dependencies of the dev-only
 * sdk-node (§37.1), which the api image drops with `--omit=dev`. A test
 * depending on a transitive dep breaks on somebody else's minor bump, and
 * promoting one would buy a twelfth runtime package for an assertion.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE THREE PROPERTIES THAT ARE ACTUALLY LOAD-BEARING, so that a reader knows
 * which failures here are cosmetic and which are not:
 *
 *   root+link   a CHILD span would outlive its parent — that is what un-awaited
 *               means — and Jaeger derives a trace's duration from
 *               max(end)-min(start) across all its spans, so the note-save
 *               trace would list a duration longer than the user's actual wait.
 *               A latency-shaped false claim, in the one artifact this phase
 *               produces. §37.4, §35.5a.
 *   no crash    detachedSpan RETHROWS. An un-awaited rejection with no handler
 *               is an unhandledRejection and modern Node terminates on one, so
 *               6.3 could ship a crash on the note-save path. fireDetached()
 *               owns that guard and it is asserted from both sides.
 *   not green   saveVersion catches its OWN errors and returns null, so a span
 *               wrapped only round the call would report success on every
 *               failure — §22.6's shape, met for the third phase running.
 */

const fs = require('fs');
const path = require('path');
const { trace, context, ROOT_CONTEXT } = require('@opentelemetry/api');

const {
  JOBS, JOB_NAMES, DSB_JOB, SPANS, SPAN_NAMES, GEN_AI, DSB_COST,
  detachedSpan, fireDetached, currentSpanContext, failActiveSpan
} = require('../observability');

const BACKEND = path.join(__dirname, '..');

/** A plausible SpanContext, shaped as the spec requires (32 hex / 16 hex). */
const ORIGIN = Object.freeze({
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: 1
});

// ───────────────────────────────────────────────────────────────────────────

describe('the two background jobs are named separately from the six stages', () => {
  test('JOB_NAMES is exactly the two un-awaited jobs', () => {
    expect(JOB_NAMES).toEqual(['background-link', 'background-version']);
  });

  test('JOBS and JOB_NAMES are frozen', () => {
    expect(Object.isFrozen(JOBS)).toBe(true);
    expect(Object.isFrozen(JOB_NAMES)).toBe(true);
  });

  test('no job name collides with a pipeline stage name', () => {
    // The structural reason they are a separate object: SPANS is ROADMAP 6.1's
    // contract and observability.spans.test.js pins it at exactly six. Adding
    // these two there would have widened a list a test exists to hold still.
    for (const name of JOB_NAMES) expect(SPAN_NAMES).not.toContain(name);
  });

  test('6.1\'s six are STILL exactly six — 6.3 did not widen them', () => {
    // Stated here as well as in 6.1's suite, so deleting that suite would not
    // quietly permit the widening this one was designed to avoid.
    expect(SPAN_NAMES).toHaveLength(6);
    expect(Object.values(SPANS)).toHaveLength(6);
  });

  test('the names are kebab-case with no whitespace, like the six', () => {
    for (const name of JOB_NAMES) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

describe('6.3\'s attributes are this project\'s own, and say so', () => {
  test('the three keys are the literals the artifacts quote', () => {
    expect(DSB_JOB.ORIGIN_TRACE_ID).toBe('dsb.job.origin_trace_id');
    expect(DSB_JOB.ORIGIN_SPAN_ID).toBe('dsb.job.origin_span_id');
    expect(DSB_JOB.NOTE_ID).toBe('dsb.note.id');
  });

  test('all three carry the dsb. prefix, because no convention names them', () => {
    // §38.2 measured that cost has no spec name at any maturity level; neither
    // does "which request caused this background job". The prefix says "this
    // project invented this" at a glance in a UI.
    for (const key of Object.values(DSB_JOB)) expect(key.startsWith('dsb.')).toBe(true);
  });

  test('DSB_JOB is frozen and disjoint from the GenAI and cost keys', () => {
    expect(Object.isFrozen(DSB_JOB)).toBe(true);
    const others = [...Object.values(GEN_AI), ...Object.values(DSB_COST)];
    for (const key of Object.values(DSB_JOB)) expect(others).not.toContain(key);
  });

  test('no user id is written, and that is deliberate', () => {
    // A trace UI has no authorisation model in front of it. A note id is
    // already all over this app's URLs and is what makes a failed job
    // actionable; a user id is a durable identifier for a person and no
    // debugging question here needs one.
    const keys = Object.values(DSB_JOB).join(' ');
    expect(keys).not.toMatch(/user/i);
  });
});

describe('detachedSpan is transparent to its callback, tracing on or off', () => {
  test('a synchronous return value passes straight through', () => {
    expect(detachedSpan(JOBS.LINK, ORIGIN, () => 42)).toBe(42);
  });

  test('an async return value resolves unchanged', async () => {
    await expect(detachedSpan(JOBS.LINK, ORIGIN, async () => 'ok')).resolves.toBe('ok');
  });

  test('a synchronous throw is RETHROWN, not swallowed', () => {
    expect(() => detachedSpan(JOBS.LINK, ORIGIN, () => { throw new Error('boom'); }))
      .toThrow('boom');
  });

  test('an async rejection is RETHROWN, not swallowed', async () => {
    // This is the property that makes fireDetached's guard mandatory rather
    // than defensive. Instrumentation that eats an error is worse than none.
    await expect(detachedSpan(JOBS.LINK, ORIGIN, async () => { throw new Error('async boom'); }))
      .rejects.toThrow('async boom');
  });

  test('the span is handed to the callback', () => {
    const seen = detachedSpan(JOBS.VERSION, ORIGIN, (span) => typeof span.setAttribute);
    expect(seen).toBe('function');
  });

  test('a missing origin is not an error — it is the tracing-off answer', () => {
    expect(detachedSpan(JOBS.LINK, undefined, () => 'fine')).toBe('fine');
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('it is a ROOT span carrying a LINK, and that is the phase', () => {
  let recorded;

  const fakeSpan = (name, options) => {
    const attributes = { ...((options && options.attributes) || {}) };
    const entry = {
      name,
      // Frozen at construction, so "set at span START" stays distinguishable
      // from "set first thing in the callback" — they differ for a sampler.
      createdWith: { ...attributes },
      attributes,
      root: options ? options.root : undefined,
      links: options ? options.links : undefined,
      hasLinksKey: !!options && Object.prototype.hasOwnProperty.call(options, 'links'),
      exceptions: [],
      status: null,
      ended: false
    };
    recorded.push(entry);
    return {
      setAttribute(k, v) { entry.attributes[k] = v; return this; },
      setAttributes(obj) { Object.assign(entry.attributes, obj); return this; },
      setStatus(s) { entry.status = s; return this; },
      recordException(e) { entry.exceptions.push(e); return this; },
      isRecording() { return true; },
      end() { entry.ended = true; }
    };
  };

  const fakeProvider = {
    getTracer: () => ({
      startActiveSpan(name, options, fn) { return fn(fakeSpan(name, options)); }
    })
  };

  beforeEach(() => {
    recorded = [];
    trace.setGlobalTracerProvider(fakeProvider);
  });

  afterEach(() => {
    // Leaving a recording tracer registered would leak into every other test
    // file sharing this worker. §37.8's near-miss is why this is explicit.
    trace.disable();
  });

  test('root: true is set, so the job does NOT nest inside the request', () => {
    detachedSpan(JOBS.LINK, ORIGIN, () => null);
    expect(recorded[0].root).toBe(true);
  });

  test('the origin travels as a real OTel Link', () => {
    detachedSpan(JOBS.LINK, ORIGIN, () => null);
    expect(recorded[0].links).toEqual([{ context: ORIGIN }]);
  });

  test('the origin ids are ALSO attributes, because Jaeger v1 hides links', () => {
    // §38.2 measured the v1 tag API flattening an array attribute so that a UI
    // filter silently matched nothing. Links are worse: v1 renders them as
    // FOLLOWS_FROM references in the span detail panel, not in the waterfall
    // and not in tag search. The causal edge is therefore recorded twice —
    // once correctly, once findably.
    detachedSpan(JOBS.LINK, ORIGIN, () => null);
    expect(recorded[0].attributes[DSB_JOB.ORIGIN_TRACE_ID]).toBe(ORIGIN.traceId);
    expect(recorded[0].attributes[DSB_JOB.ORIGIN_SPAN_ID]).toBe(ORIGIN.spanId);
  });

  test('the origin ids are set at span START, not inside the callback', () => {
    detachedSpan(JOBS.LINK, ORIGIN, () => null);
    expect(recorded[0].createdWith).toHaveProperty([DSB_JOB.ORIGIN_TRACE_ID], ORIGIN.traceId);
  });

  test('with no origin there is no links key at all, and no origin attributes', () => {
    // An empty array is not the same as absent to every exporter, and there is
    // genuinely no origin when tracing is off or when a job is fired from a
    // script rather than a request.
    detachedSpan(JOBS.LINK, undefined, () => null);
    expect(recorded[0].hasLinksKey).toBe(false);
    expect(recorded[0].attributes).not.toHaveProperty([DSB_JOB.ORIGIN_TRACE_ID]);
    expect(recorded[0].attributes).not.toHaveProperty([DSB_JOB.ORIGIN_SPAN_ID]);
  });

  test('caller attributes survive alongside the origin ids', () => {
    detachedSpan(JOBS.LINK, ORIGIN, () => null, { [DSB_JOB.NOTE_ID]: 'abc123' });
    expect(recorded[0].attributes).toHaveProperty([DSB_JOB.NOTE_ID], 'abc123');
    expect(recorded[0].attributes).toHaveProperty([DSB_JOB.ORIGIN_TRACE_ID], ORIGIN.traceId);
  });

  test('the caller\'s attributes object is not mutated', () => {
    const attrs = { [DSB_JOB.NOTE_ID]: 'abc123' };
    detachedSpan(JOBS.LINK, ORIGIN, () => null, attrs);
    expect(Object.keys(attrs)).toEqual([DSB_JOB.NOTE_ID]);
  });

  test('the span is named by the JOBS constant it was given', () => {
    detachedSpan(JOBS.VERSION, ORIGIN, () => null);
    expect(recorded[0].name).toBe('background-version');
  });

  test('a successful job ends its span and records no exception', () => {
    detachedSpan(JOBS.LINK, ORIGIN, () => 'done');
    expect(recorded[0].ended).toBe(true);
    expect(recorded[0].exceptions).toHaveLength(0);
    expect(recorded[0].status).toBeNull();
  });

  test('A FAILING JOB RECORDS THE EXCEPTION, GOES ERROR, AND STILL ENDS', async () => {
    // 6.3's Done criterion in miniature: the error is ATTACHED to the span.
    // recordException carries type/message/stack; the status is what turns the
    // bar red. Either alone is half a report.
    const err = new Error('Namespace dsb.notelinks is a view, not a collection');
    await expect(detachedSpan(JOBS.LINK, ORIGIN, async () => { throw err; })).rejects.toThrow();
    const span = recorded[0];
    expect(span.exceptions).toEqual([err]);
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span.status.message).toContain('not a collection');
    expect(span.ended).toBe(true);
  });

  test('a failing job KEEPS its identity — the attributes survive the throw', () => {
    // The property §38.5 depends on, one span over: the spans most worth
    // finding are the ones that failed, and an anonymous failed span is not
    // findable. Attributes are applied at start precisely for this.
    expect(() => detachedSpan(JOBS.LINK, ORIGIN, () => { throw new Error('x'); },
      { [DSB_JOB.NOTE_ID]: 'note-9' })).toThrow();
    expect(recorded[0].attributes).toHaveProperty([DSB_JOB.NOTE_ID], 'note-9');
    expect(recorded[0].attributes).toHaveProperty([DSB_JOB.ORIGIN_TRACE_ID], ORIGIN.traceId);
  });

  test('a SYNCHRONOUS throw also ends the span and records it', () => {
    expect(() => detachedSpan(JOBS.LINK, ORIGIN, () => { throw new Error('sync'); })).toThrow();
    expect(recorded[0].ended).toBe(true);
    expect(recorded[0].exceptions).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('fireDetached never lets a background failure reach the process', () => {
  let recorded;
  const fakeProvider = {
    getTracer: () => ({
      startActiveSpan(name, options, fn) {
        const entry = { name, ended: false, exceptions: [] };
        recorded.push(entry);
        return fn({
          setAttribute() { return this; }, setAttributes() { return this; },
          setStatus() { return this; },
          recordException(e) { entry.exceptions.push(e); return this; },
          isRecording() { return true; }, end() { entry.ended = true; }
        });
      }
    })
  };

  beforeEach(() => { recorded = []; trace.setGlobalTracerProvider(fakeProvider); });
  afterEach(() => { trace.disable(); });

  test('it returns undefined, so it cannot be awaited by accident', () => {
    // "Do not await this" is 6.3's entire constraint. A function returning no
    // promise enforces it structurally rather than by comment.
    expect(fireDetached(JOBS.LINK, ORIGIN, async () => 'x')).toBeUndefined();
  });

  test('an ASYNC rejection reaches onError instead of the process', async () => {
    const seen = [];
    fireDetached(JOBS.LINK, ORIGIN, async () => { throw new Error('mongo down'); }, {},
      (e) => seen.push(e.message));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(seen).toEqual(['mongo down']);
  });

  test('a SYNCHRONOUS throw reaches onError instead of the request handler', () => {
    // Both jobs are async today, so this path is unreachable now. It is covered
    // because a future synchronous throw would propagate out of detachedSpan
    // synchronously — into the request handler — turning a failed background
    // job into a 500 on a save that had already succeeded.
    const seen = [];
    fireDetached(JOBS.LINK, ORIGIN, () => { throw new Error('sync boom'); }, {},
      (e) => seen.push(e.message));
    expect(seen).toEqual(['sync boom']);
  });

  test('the span is still marked failed on the way past the guard', async () => {
    fireDetached(JOBS.LINK, ORIGIN, async () => { throw new Error('recorded'); }, {}, () => {});
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(recorded[0].exceptions).toHaveLength(1);
    expect(recorded[0].ended).toBe(true);
  });

  test('a THROWING onError cannot take the process down either', () => {
    // The same crash by a longer route: an error handler that throws on an
    // un-awaited path is still an unhandled rejection.
    expect(() => fireDetached(JOBS.LINK, ORIGIN, () => { throw new Error('a'); }, {},
      () => { throw new Error('the logger itself failed'); })).not.toThrow();
  });

  test('a success path never calls onError', async () => {
    const seen = [];
    fireDetached(JOBS.LINK, ORIGIN, async () => 'fine', {}, (e) => seen.push(e));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(seen).toEqual([]);
    expect(recorded[0].ended).toBe(true);
  });

  test('onError is optional', () => {
    expect(() => fireDetached(JOBS.LINK, ORIGIN, () => { throw new Error('x'); })).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('currentSpanContext and failActiveSpan read the ACTIVE span', () => {
  // A minimal stack context manager, from @opentelemetry/api alone. The API's
  // default NoopContextManager returns ROOT_CONTEXT from active() and does not
  // store what with() was given, so without this there is no way to test the
  // "there IS an active span" branch at all.
  let current = ROOT_CONTEXT;
  const stackContextManager = {
    active: () => current,
    with(ctx, fn, thisArg, ...args) {
      const previous = current;
      current = ctx;
      try { return fn.call(thisArg, ...args); } finally { current = previous; }
    },
    bind: (ctx, target) => target,
    enable() { return this; },
    disable() { current = ROOT_CONTEXT; return this; }
  };

  const recordingSpan = (entry) => ({
    spanContext: () => ORIGIN,
    setAttribute() { return this; }, setAttributes() { return this; },
    setStatus(s) { entry.status = s; return this; },
    recordException(e) { entry.exceptions.push(e); return this; },
    isRecording() { return true; }, end() { entry.ended = true; }
  });

  beforeEach(() => { current = ROOT_CONTEXT; context.setGlobalContextManager(stackContextManager); });
  afterEach(() => { context.disable(); trace.disable(); });

  test('currentSpanContext is undefined when nothing is active', () => {
    // The tracing-off answer, and every caller treats it as "no origin to link
    // to" rather than as an error.
    expect(currentSpanContext()).toBeUndefined();
  });

  test('currentSpanContext returns the active span\'s context', () => {
    const entry = { exceptions: [] };
    const ctx = trace.setSpan(context.active(), recordingSpan(entry));
    const got = context.with(ctx, () => currentSpanContext());
    expect(got).toEqual(ORIGIN);
  });

  test('failActiveSpan returns null when there is no active span', () => {
    expect(failActiveSpan(new Error('nobody listening'))).toBeNull();
  });

  test('failActiveSpan records the exception AND sets ERROR status', () => {
    // This is what stops saveVersion's span being green on every failure.
    const entry = { exceptions: [] };
    const err = new Error('version write failed');
    const ctx = trace.setSpan(context.active(), recordingSpan(entry));
    const returned = context.with(ctx, () => failActiveSpan(err));
    expect(returned).not.toBeNull();
    expect(entry.exceptions).toEqual([err]);
    expect(entry.status.code).toBe(2);
    expect(entry.status.message).toContain('version write failed');
  });

  test('failActiveSpan does NOT end the span — its caller still owns that', () => {
    // saveVersion returns null and keeps going; ending the span here would cut
    // it short of the work fireDetached still has to finish.
    const entry = { exceptions: [] };
    const ctx = trace.setSpan(context.active(), recordingSpan(entry));
    context.with(ctx, () => failActiveSpan(new Error('x')));
    expect(entry.ended).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────

describe('the call sites are wired, and a rename cannot quietly unwire them', () => {
  const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

  /**
   * CODE ONLY — the comments in these files are dense and they NAME the very
   * identifiers these tests look for. Counting `fireDetached(` across the raw
   * text finds three: one call and two mentions in prose. An assertion that
   * cannot tell a call from a sentence about a call is §38.6's lesson in a new
   * costume: text matching has to look at the right text.
   *
   * Block comments and whole-line comments only. Deliberately NOT a general
   * tokenizer — a `//` inside a string literal is left alone, which is safe
   * here and honest about what this is.
   *
   * ⚠️ THE ORDER IS LOAD-BEARING: LINE COMMENTS FIRST, THEN BLOCK COMMENTS.
   * This file used to strip block comments first, and that is a real bug —
   * a `//` comment CONTAINING `/*` opens a block comment as far as a regex is
   * concerned, so the stripper deletes everything from there to the next `*​/`.
   * This repository writes `/api/llm/*` constantly, and that string inside a
   * `//` comment is exactly the shape. It cost the pre-deployment session a red
   * suite against entirely correct source, was fixed in tests/rate-limit.test.js
   * and pinned there with the input that broke it, and this copy was left on the
   * noticed list — where it stayed for two sessions.
   *
   * WHICH WAY IT FAILS IS WHY IT WAS SURVIVABLE AND NOT WHY IT WAS FINE: the
   * block-first ordering DELETES code, so assertions go red rather than
   * vacuously green. A latent false alarm, not a latent false negative. The
   * fix is one line and the ordering is now pinned by the test below rather
   * than by this paragraph.
   */
  const codeOnly = (text) => text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const notes = codeOnly(read('routes/notes.js'));
  const version = codeOnly(read('services/version.service.js'));

  test('the comment stripper actually strips — otherwise everything below is vacuous', () => {
    // POSITIVE CONTROL. These files' comments NAME the identifiers the
    // assertions look for: `fireDetached(` appears three times in
    // routes/notes.js and only one is a call. If codeOnly stopped working every
    // assertion below would pass on prose. §22.6's shape, guarded.
    const raw = read('routes/notes.js');
    expect(raw).toMatch(/^\s*\/\//m);
    expect(codeOnly(raw)).not.toMatch(/^\s*\/\//m);
  });

  test('a line comment containing a glob does not swallow the code after it', () => {
    // THE REGRESSION THIS FILE SHIPPED FOR TWO SESSIONS. Stripping block
    // comments FIRST makes `/*` inside a `//` comment open a block comment, and
    // everything to the next `*​/` disappears — including the calls being
    // asserted. Pinned with the exact shape so the ordering in codeOnly cannot
    // be "simplified" back.
    const source = [
      '// this job is on /api/llm/* only',
      'fireDetached(JOBS.LINK);',
      '/** a real block comment */',
      'fireDetached(JOBS.VERSION);'
    ].join('\n');
    expect(codeOnly(source)).toContain('fireDetached(JOBS.LINK)');
    expect(codeOnly(source)).toContain('fireDetached(JOBS.VERSION)');
    expect(codeOnly(source)).not.toContain('a real block comment');
  });

  test('routes/notes.js fires BOTH jobs through fireDetached', () => {
    expect(notes).toContain('JOBS.LINK');
    expect(notes).toContain('JOBS.VERSION');
    expect(notes).toContain('fireDetached(');
  });

  test('every job span is named by a JOBS.* constant, never a bare string', () => {
    // 6.1's reason, unchanged: a mistyped literal exports happily under a name
    // nothing is looking for, and no test notices. The name is chosen at the
    // fireJob() layer, so that is the layer this checks — and fireDetached is
    // reached from exactly ONE place, so there is exactly one door a bare
    // string could come through.
    // The lookbehind drops `function fireJob(` — the declaration is not a call site.
    const calls = notes.match(/(?<!function )fireJob\(\s*[^\s,)]+/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/fireJob\(\s*JOBS\./);
    expect(notes.match(/fireDetached\(/g)).toHaveLength(1);
  });

  test('NEITHER JOB IS AWAITED — the constraint the whole phase works under', () => {
    // Making them awaited would trace beautifully and change save latency for
    // every user, which is the one thing 6.3 is not allowed to do.
    expect(notes).not.toMatch(/await\s+fireDetached\(/);
    expect(notes).not.toMatch(/await\s+fireJob\(/);
    expect(notes).not.toMatch(/await\s+runLinkingAsync\(/);
    expect(notes).not.toMatch(/await\s+saveVersion\(/);
    expect(notes).not.toMatch(/await\s+computeAndSaveLinks\(/);
  });

  test('NEITHER JOB IS REACHABLE EXCEPT THROUGH THE WRAPPER', () => {
    // The "not awaited" test above is a grep and a grep is one restructure away
    // from vacuous — §38.6's lesson. This is the property that actually holds:
    // each job function is INVOKED from exactly one place, so there is no
    // second call site where somebody could add an await, and adding one turns
    // this red rather than silently changing save latency for every user.
    expect(notes.match(/computeAndSaveLinks\(/g)).toHaveLength(1);
    expect(notes.match(/saveVersion\(/g)).toHaveLength(1);
  });

  test('both invocations sit inside a fireJob callback', () => {
    expect(notes).toMatch(/fireJob\([\s\S]{0,300}computeAndSaveLinks\(/);
    expect(notes).toMatch(/fireJob\([\s\S]{0,300}saveVersion\(/);
  });

  test('the origin is captured on the request path, at both save routes', () => {
    // Two calls: POST /api/notes and PUT /api/notes/:id. If this were read
    // inside the job instead, there would be no active context left to read.
    const captures = notes.match(/currentSpanContext\(\)/g) || [];
    expect(captures).toHaveLength(2);
  });

  test('the log labels a terminal is grepped for are unchanged', () => {
    expect(notes).toContain('Background linking error');
    expect(notes).toContain('Version save skipped');
  });

  test('version.service.js marks the span from inside its OWN catch', () => {
    // Without this line the span around saveVersion is §22.6's shape: a check
    // that runs and cannot fail, because saveVersion never rejects.
    expect(version).toContain('failActiveSpan(err)');
    const catchIndex = version.indexOf('} catch (err) {');
    const markIndex = version.indexOf('failActiveSpan(err)');
    expect(catchIndex).toBeGreaterThan(-1);
    expect(markIndex).toBeGreaterThan(catchIndex);
  });

  test('saveVersion still returns null and still logs — behaviour unchanged', () => {
    expect(version).toContain("console.error('Version save failed (non-critical):'");
    expect(version).toMatch(/failActiveSpan\(err\);[\s\S]{0,200}return null;/);
  });

  test('no app file imports @opentelemetry/api directly', () => {
    // observability/index.js is the app-side interface, and "how much OTel is
    // in this codebase" stays answerable by reading one require.
    for (const rel of ['routes/notes.js', 'services/version.service.js',
                       'services/linker.service.js', 'services/studyPack.service.js']) {
      expect(read(rel)).not.toMatch(/require\(['"]@opentelemetry/);
    }
  });

  test('backend/retrieval/ is STILL not instrumented — the boundary holds', () => {
    // Eighteenth phase. 6.3 touches routes/ and services/ only.
    const dir = path.join(BACKEND, 'retrieval');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const offenders = walk(dir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /require\(['"]@opentelemetry|require\(['"].*observability/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
