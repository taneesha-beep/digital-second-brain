# ADR-0003 — No job queue

- **Status:** Accepted · carried from the pre-reorientation design · **observability half
  delivered without it, 23 Aug 2026**
- **Relates to:** [ADR-0004](0004-microbenchmark-not-load-test.md) — the other decision that turns
  on this being a single-tenant app at notebook scale.

## Context

Saving a note fires two background jobs — snapshot the version, recompute the links — and both are
deliberately **un-awaited**, so the user's response does not wait for them. That is the shape a job
queue exists to formalise: Redis plus BullMQ, a worker process, retries, a dead-letter queue, a
dashboard.

The estimated cost was roughly **15 hours of infrastructure** for a single-tenant application
whose per-user corpus is capped at 500 notes.

Two real problems were being conflated under "we need a queue":

1. **Durability** — an un-awaited job that fails is work silently lost.
2. **Observability** — an un-awaited job that fails was, in this app, *invisible*. The failure
   reached `console.error` and nothing else.

Only the second was ever observed happening.

## Decision

**Do not add a queue.** Keep the two jobs un-awaited on the note-save path, and **buy the
observability half separately and far more cheaply** — each job now runs inside a *detached,
linked* OpenTelemetry span, so a failure is a red span carrying its exception and a reference back
to the request that spawned it.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **Redis + BullMQ** | ~15 h of infrastructure, a second process to deploy and monitor, and a new hosted dependency — to solve a load problem no measurement has found. Adding a queue to a system with no load problem is resume-driven development, and it reads that way to an interviewer who asks what the queue's depth graph looks like. |
| **Awaiting the jobs** | Traces beautifully and changes save latency for every user. The un-awaited design is the product decision this record is built on top of, not one it is free to reverse. |
| **A child span instead of a detached one** | One line shorter and it manufactures a false latency claim. A child that outlives its parent is exactly what *un-awaited* means, and a trace's duration is derived from `max(end) − min(start)` across all its spans — so children inflate the note-save trace's listed duration above the time the user actually waited, on **25 of 25 saves**. |
| **`SpanKind` PRODUCER/CONSUMER** | Describes a message crossing a broker. Nothing is queued here — which is this record's whole point. |
| **Deleting the now-dead `.catch` at the call site** | The failure mode of removing a `.catch` from an un-awaited promise is a crashed process. It is left in place deliberately. |

## Consequences

- **Durability is still not bought, and this record says so rather than implying the span fixed
  it.** A failed link recomputation is still lost work; what changed is that it is now *visible*
  lost work. The next save recomputes it.
- **The cheap half turned out to be the valuable half.** Instrumenting the jobs cost one phase, no
  new hosted dependency and **zero API quota** — and it surfaced a failure mode that had been live
  since the app was written and had never once been seen.
- **One of the two jobs was failing in a way even the plan had wrong.** The version-snapshot job
  catches its own errors and returns `null`, so its call-site handler **has never fired in the life
  of the application**. That was established by breaking the collection and reading which label
  appeared. [`docs/OBSERVABILITY.md`](../OBSERVABILITY.md)
- **`fireDetached()` returns nothing**, so *"do not await this"* is structural rather than a
  comment somebody has to keep believing.

## Trigger conditions — what would flip this

Revisit when **any one** holds:

1. **The app stops being effectively single-tenant at notebook scale.** The concrete number is the
   per-user cap of 500 notes; a queue's argument begins where a save's background work stops
   fitting comfortably beside the request that spawned it.
2. **Lost work starts mattering.** Today a dropped link recomputation is repaired by the next save
   of that note. If a background job ever writes something no later save reproduces, durability
   becomes a requirement rather than a nicety.
3. **A background job becomes slow enough to need backpressure**, i.e. saves arrive faster than
   the jobs drain. Nothing measures this today, and the trace is now the instrument that would
   show it first.
4. **Retries become necessary** because a job depends on something that is legitimately flaky —
   a third-party API rather than the local database.

**None of the four holds today**, and the trace is what makes each of them observable rather than
a matter of opinion.

## Evidence

| Source | What it carries |
|---|---|
| [`docs/OBSERVABILITY.md`](../OBSERVABILITY.md) | the trace architecture, the detached-span design and the failure it made visible |
| [`results/tracing-background-failure.txt`](../../results/tracing-background-failure.txt) | the failing background job as a trace, with its exception |
| [`results/tracing-background-failure.png`](../../results/tracing-background-failure.png) | the same failure in the trace viewer |
| [`results/write-cost.txt`](../../results/write-cost.txt) | what the save path actually costs — three driver operations, constant in the link count |

**Not machine-checked:** the hour estimate is an estimate and is labelled one. The `25 of 25`
count is an integer and outside `npm run check:claims`; the reason it needs no environment is that
its *direction* is arithmetic rather than measured.
