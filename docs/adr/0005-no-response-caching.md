# ADR-0005 — No response caching for the AI features

- **Status:** Accepted · 23 Aug 2026 · closed as WON'T DO
- **Relates to:** [ADR-0003](0003-no-job-queue.md) — the same argument, pointed at this repository
  rather than at a rejected dependency.

## Context

Six AI features call a hosted model. Five take one note; the sixth — the study pack — takes a note
plus its retrieved neighbours. A cache is the obvious optimisation, and the key writes itself:
`(noteId, feature, contentHash, retrieverVersion)`. Content-addressed, so an edited note misses
correctly, and retriever-versioned, so a re-ranked neighbourhood misses correctly too.

It was scoped, and then it was declined, because **the problem it optimises has never been
measured happening here.**

Two things the numbers say, and they point the same way:

- **The binding constraint is a rate limit, not a bill.** Spend runs against a free tier: the
  published list price of a study pack is **$0.001310**, and the real invoice is **$0.00**.
  [`results/studypack-cost.txt`](../../results/studypack-cost.txt) says so in its own header —
  *"this is a published list price, it is not money anybody was charged."* A cache reduces money.
  Money is not what runs out.
- **What does run out is quota, and that was addressed directly.** The provider caps the
  *organisation* on a rolling window, so the app carries explicit limiters instead: per account on
  each AI route, plus one budget shared by every user across both.
  [`results/rate-limit-verification.txt`](../../results/rate-limit-verification.txt)

## Decision

**Do not build it.** Record the design, and record the conditions that would make it worth
building.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **Build the cache and report a hit rate** | The interviewer's question is *"what was your hit rate and what did it save?"*, and the only available answer would be a number produced by a synthetic session someone invented — a measurement of the script rather than of the product. |
| **Build it and skip the hit rate** | Ships infrastructure with no evidence it does anything, which is precisely the pattern [ADR-0003](0003-no-job-queue.md) declines. |
| **Cache to save money** | The bill is $0.00. |
| **Cache to save latency** | There is no controlled latency measurement to improve against — [ADR-0004](0004-microbenchmark-not-load-test.md) records why, and the budget that would have supplied the target was cut the same day this was. |
| **Leave it on the backlog as "later"** | An open item with no trigger gets re-proposed every phase. That is what these trigger conditions replace. |

## Consequences

- **Repeat invocations of an unchanged note cost a call every time.** That is the accepted cost,
  stated rather than hidden. Nothing measures how often it happens, which is the point.
- **The cache's absence is invisible to a user** and visible in the shared budget, which is
  surfaced to visitors in [`README.md`](../../README.md) rather than left to be discovered as a
  failure.
- **A résumé bullet had to be rewritten.** It claimed a percentage of LLM spend cut via
  content-hash caching. That number will never exist, and a bullet promising it was removed rather
  than left to be asked about.
- **If it is ever built, the measurement it needs already exists.** The per-call ledgers record
  every request with its token counts, so a hit rate could be computed retrospectively over real
  traffic instead of forecast from a synthetic one.

## Trigger conditions — what would flip this

Revisit when **any one** holds:

1. **Invocations of a single unchanged note exceed a handful per session**, measured on real
   traffic from the per-call ledgers — not modelled. This is the direct hit-rate precondition.
2. **Provider spend becomes a binding *cost* rather than a binding *rate limit*.** The distinction
   is the whole record: today the app is stopped by quota and charged $0.00. A paid tier inverts
   that and a cache starts saving something real.
3. **The shared budget starts refusing legitimate visitors often enough to matter.** Today it is a
   documented limit on a demo; if it becomes the app's normal failure mode, a cache is one of the
   cheaper mitigations.
4. **A controlled latency budget exists** — see [ADR-0004](0004-microbenchmark-not-load-test.md) —
   so a cache could be shown to improve a number somebody committed to in advance.

**None of the four holds today.**

## Evidence

| Source | What it carries |
|---|---|
| [`results/studypack-cost.txt`](../../results/studypack-cost.txt) | cost per study pack at published list price, with its free-tier caveat and its censoring caveat |
| [`results/rate-limit-verification.txt`](../../results/rate-limit-verification.txt) | the limiters, driven against a real server over a real socket |
| [`results/gen-v5.calls.jsonl`](../../results/gen-v5.calls.jsonl) | the per-call ledger a real hit rate would be computed from |
| [`docs/FAILURE-MODES.md`](../FAILURE-MODES.md) | G5 — how often the provider actually refuses, and on what denominator |

**⚠️ The cost figure prices a configuration that is no longer shipped**, and the artifact says so
itself: the ledger was taken at an output ceiling of 2048 and the study pack now ships at 4096, so
**$0.001310 is a lower bound**. Re-pricing needs a fresh run that has not been made. That does not
weaken this record — a lower bound on a bill of $0.00 argues the same way.
