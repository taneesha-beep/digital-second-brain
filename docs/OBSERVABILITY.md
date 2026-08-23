# Observability — what a trace shows, and the failure it made visible

**Phase 6.** OpenTelemetry over the note-linking and study-pack paths, exported to a local
Jaeger. Off by default, on behind one environment variable, and pointed at one specific
question: **a background job that had been failing into silence since the app was written.**

This is not a monitoring setup looking for a use. Phase 6 was cut from six items to three, and
the item it was kept for is the last one on this page.

---

## 1. Why this exists

On every note save, two jobs fire **without `await`** so the response can go back immediately:

```
PUT /api/notes/:id ──► save the note ──► 200 OK to the user
                            │
                            ├─ saveVersion()          un-awaited
                            └─ computeAndSaveLinks()  un-awaited
```

That is a deliberate product decision and it is still the decision. Its cost was that when one
of those jobs failed, **the failure reached one line of `console.error` and nothing else.** A
user whose links failed to compute sees an empty related-notes panel, which is
**indistinguishable from a note that genuinely has no related notes** — to the user, and to
every metric in this repository.

`docs/FAILURE-MODES.md` §5 lists that mode among the ones that are real and have **no measured
frequency**, because no instrument existed that could produce one.

---

## 2. Running it

Tracing is **off unless `DSB_TRACING=1`**. The collector is behind a compose profile, so a plain
`docker compose up` does not start it.

```bash
docker compose --profile tracing up -d jaeger
```

```bash
cd backend && DSB_TRACING=1 npm run dev
```

The Jaeger UI is then on `http://localhost:16686`. Without the flag, **not one SDK module is
loaded** — no exporter, no instrumentation, no socket — and `npm test` and CI run the identical
process they ran before any of this existed.

```bash
cd backend && npm test
```

### 2.1 Why not `OTEL_SDK_DISABLED`

OpenTelemetry ships its own switch and it is **opt-out**: the SDK runs unless the variable is
set. That is the wrong polarity here. A tracer that initialises under `npm test` changes what a
green CI tick covers, and adopting the standard name would mean every environment has to
*remember* to disable it. A safety property held by every caller remembering is not held.

### 2.2 What it costs when it is off

Nothing branches. `@opentelemetry/api` is the only OpenTelemetry package in `dependencies`; with
no SDK registered its tracer is a no-op that still invokes the callback, so the instrumented
call sites carry no `if`. The SDK, the exporter and the two instrumentations are
**devDependencies**, and the Dockerfile's api stage installs with `--omit=dev`, so the container
image is unchanged by construction.

---

## 3. The spans

Six pipeline stages, plus two background jobs added in 6.3.

| span | where |
|---|---|
| `normalize` | `backend/routes/notes.js` — note save |
| `extract` | `backend/routes/notes.js` — note save |
| `retrieve` | `backend/services/studyPack.service.js` |
| `build-context` | `backend/services/studyPack.service.js` |
| `llm-call` | `backend/services/studyPack.service.js` |
| `parse` | `backend/services/studyPack.service.js` |
| `background-link` | `backend/routes/notes.js` — detached |
| `background-version` | `backend/routes/notes.js` — detached |

**A Study Pack request carries four of the six, not six.** `normalize` and `extract` are not on
that path at all: `contentText` is normalized at write time and the retriever ignores stored
keywords. The six stages span **two request paths**, and no single request has ever exercised
all of them. The names were kept and placed where the operations actually happen, rather than
moved to satisfy a diagram.

`backend/retrieval/` is **not instrumented**, and cannot be: a test walks that directory's
require graph and fails on any import that resolves outside it. So `retrieve` is timed from the
caller as one span with no child. That is a real cost of the purity boundary rather than an
omission — the price of a module nothing may depend on is that nothing can see into it.

### 3.1 A real trace

```
POST /api/study-pack/:noteId  ###################################   3762.5 ms
  middleware - protect        #                                        3.6 ms
  request handler             ###################################   3757.0 ms
    retrieve                  #                                        1.5 ms
    build-context             #                                        0.4 ms
    llm-call                  ###################################   3743.3 ms
    parse                                                    #         0.1 ms
```

`results/tracing-verification.txt`.

**Two readings, and the second one paid for itself immediately.** The first is that the model is
essentially the whole wall time, so optimising retrieval would be a wasted afternoon. The second
is the **gap**: the manual spans sum to 11.7 ms less than their parent, and that hole is two
Mongo round trips carrying no span. It is left visible as a hole rather than folded into a
neighbour, because a gap folded into its neighbour stops being findable.

> ⚠️ **These durations are uncontrolled and are not a latency claim.** One laptop, one process,
> no concurrency, no warmup, no repeats, and a third-party API call in the middle. This project
> publishes **no** controlled latency figure and has recorded the decision not to build one.
> A waterfall here is read for **structure** — what nests inside what, and which bar dominates.

---

## 4. Attributes on the LLM span

Nine, of which seven are the specification's names and two are this project's own.

```
gen_ai.operation.name           chat
gen_ai.provider.name            groq
gen_ai.request.model            openai/gpt-oss-120b
gen_ai.response.model           openai/gpt-oss-120b
gen_ai.usage.input_tokens       832
gen_ai.usage.output_tokens      1796
gen_ai.response.finish_reasons  ["stop"]
dsb.gen_ai.cost.usd             0.0012024
dsb.gen_ai.cost.rate_source     groq-list-price-2026-08-23
```

`results/tracing-attributes.txt`.

**None of OpenTelemetry's `gen_ai.*` attributes is stable** — measured against the published
conventions package, zero in its stable entry point against forty-plus in its experimental one.
They are written as literals in one file and pinned by a test rather than imported, because
importing them would add a runtime dependency for string constants.

**Cost has no specification name at any maturity level**, so it carries a `dsb.` prefix that says
"this project invented this" at a glance beside seven attributes that did not have to be
invented.

**And it never travels without its rate source.** A bare dollar figure on a span is a
measured-looking number with no artifact behind it. The second attribute names the rate table
and the date it was read, resolving to `backend/observability/cost.js` — one copy of the price,
which also produces the committed cost artifact, so the span and the artifact cannot drift.

> **The dollars are a published list price and nobody was charged them.** This project runs on a
> free tier and the real invoice is $0.00. Token counts are real regardless of price; the
> transferable claim is that per-request cost was **attributed through the pipeline**, not the
> size of an invoice.

`gen_ai.response.model` is set alongside the request model on purpose: a retired model id fails
loudly, but a silently substituted one does not, and a trace showing only what was *asked for*
cannot show that something else answered.

**There is no budget table on this page**, and that is a decision rather than an omission. An
honest budget needs a controlled measurement, and this project has written down that its
existing figures cannot stand in for one. Assembling a pass/fail table out of uncontrolled
numbers would be a claim with no environment behind it.

---

## 5. The background jobs — Phase 6.3

This is the item Phase 6 was kept for.

### 5.1 A link, not a child

The two un-awaited jobs get a **detached span**: a new root span in a new trace, carrying an
OpenTelemetry **Link** back to the request that caused it.

```
trace A   PUT /api/notes/:id ─────────────  9.4 ms      what the user waited for
                  │
                  │  Link (FOLLOWS_FROM)
                  ├──────────────► trace B   background-version   6.7 ms
                  └──────────────► trace C   background-link      3.5 ms
```

Making them **children** would have been one line shorter and would have been wrong. A child
that outlives its parent is exactly what un-awaited *means*, and a trace's duration is derived
from the earliest start and the latest end across all of its spans — so attaching the jobs as
children inflates the note-save trace's listed duration above the time the user actually waited.

Measured across every save in one verification session:

| | |
|---|---|
| saves examined | 25 |
| inflated if the jobs were children | **25 of 25** |
| inflation, smallest | 36% |
| inflation, median | 135% |
| inflation, largest | 266% |

> **Read the sign, not the size.** The direction is arithmetic and guaranteed — a span ending
> after its parent can only push the latest end later — so "25 of 25" is not a sample result.
> The *magnitude* is a ratio of uncontrolled durations and is not a performance figure. What the
> table establishes is that the distortion is large enough to matter, not how large it is.

The cost of the choice is stated rather than hidden: **a link is harder to find in a UI than a
child.** Jaeger renders links as references in the span detail panel, not in the waterfall and
not in tag search. So the causal edge is recorded **twice** — once correctly as a Link, and once
findably as a plain attribute, `dsb.job.origin_trace_id`. One query on that attribute returns
every background job descended from one save.

### 5.2 What propagation actually costs

Nothing on the request path becomes awaited. The context is read from the active span
synchronously, at the call site, before the job is fired — by the time the job runs, the response
has gone and there is no ambient context left to inherit, which is exactly why propagation has to
be explicit.

```
awaited round trips, PUT /api/notes/:id     before 3    after 3
awaited round trips, POST /api/notes        before 1    after 1
```

What is added per save is one context read and one span creation, and with tracing off that span
creation is a no-op. The helper that fires the job **returns nothing at all**, so "do not await
this" is enforced structurally rather than by a comment.

### 5.3 The failure, made visible

Reproduced with **no fault injection anywhere in the shipped code**: the write target was
replaced with a MongoDB *view*, which every write refuses, and the linker then does all of its
real work and fails at its write — a real driver error from a real broken database object.

What the user sees is unchanged and is the whole problem: **`200 OK`, the note saved correctly,
and an empty related-notes panel.**

![A failed background link job in the Jaeger UI: the span is red, its status is ERROR, the
exception is attached, and a FOLLOWS_FROM reference points back to the note save that caused
it.](../results/tracing-background-failure.png)

```
span                      background-link                    ERROR
otel.status_description   Namespace ...notelinks is a view, not a collection
exception.message         (same)
exception.stacktrace      MongoBulkWriteError: ...
dsb.job.origin_trace_id   d707d42c400fc71b29a8977d00df2ad2
dsb.note.id               6a8b31656ca1424af0ea3c8c
References (1)            FOLLOWS_FROM -> the PUT that caused it
```

`results/tracing-background-failure.txt`.

### 5.4 The second job had the same defect one layer deeper

`computeAndSaveLinks` at least *rejects*, so its caller's handler fires. `saveVersion` does not:
it catches its own errors, logs, and returns `null`. **Its caller's handler had never once
fired**, and a span wrapped only around the call would have reported success on every failure —
a check that runs and cannot fail.

One line inside that existing catch fixes it, marking the active span before the function returns
`null` as it always did. Verified by breaking the versions collection the same way: the span goes
red, while the log line that appears is the *internal* one, proving which catch actually fired.

### 5.5 Two things that will look like bugs

- **`exception.type` is a number, not the error class.** The span reports `166` where a reader
  expects `MongoBulkWriteError`. That is OpenTelemetry's own precedence rule — an exception's
  `code` wins over its `name` — and MongoDB driver errors carry a numeric code. The class name
  survives inside the stack trace. Not worked around: stripping `code` to make `name` display
  would discard the more precise identifier for the less precise one.
- **The `error` tag is visible in the UI and not findable by tag search.** `error` and
  `otel.status_code` are *derived* by Jaeger from the span status; they render as tags but are
  not indexed as tags, so a filter on them silently matches nothing. Real attributes are indexed
  — which is the second reason `dsb.job.origin_trace_id` exists.

---

## 6. What this does not establish

- **No latency claim of any kind**, and no controlled figure will ever exist here. Every duration
  on this page and in every artifact it cites is labelled uncontrolled at the point of use.
- **The failure mode is now countable. It has not been counted.** 6.3 built the instrument;
  producing a frequency needs the system run at scale with tracing on, and that has not happened.
  `docs/FAILURE-MODES.md` §5 still carries this mode with no number, correctly.
- **`n=1` for each trace shape**, on synthetic notes in a throwaway local database rather than
  anybody's notebook.
- **Nothing traces in CI**, by design, and the workflow is untouched. A green tick covers exactly
  what it covered before.
- **The cost figure prices a configuration that is no longer shipped** — it comes from a ledger
  taken at a lower output ceiling than the one the study pack now uses, and part of that ledger
  was truncated at exactly the quantity being priced. It is a lower bound, not an estimate.
