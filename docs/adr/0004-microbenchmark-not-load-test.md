# ADR-0004 — Microbenchmark the code, do not load-test the tier

- **Status:** Accepted · carried from the pre-reorientation design · re-affirmed 23 Aug 2026 when
  the cost-and-latency budget was cut
- **Relates to:** [ADR-0003](0003-no-job-queue.md) — same premise, different conclusion;
  [ADR-0007](0007-in-memory-per-user-index.md) — the microbenchmarks this decision produced are
  what that record's trigger condition reads.

## Context

The obvious performance deliverable for a portfolio backend is a load test: k6 or Artillery,
a ramp, a graph of p95 against concurrency. It looks like rigour.

**On a hobby-tier host in front of a shared-tier database, it measures the tier.** The graph's
knee is where the database starts throttling, and that knee moves when the plan does. The whole
exercise dies to one interviewer question — *"what tier was that on?"* — and the honest answer
concedes the number describes a rented resource limit rather than anything about the code.

There is a second problem, specific to this repository: **the machine every measurement would run
on is an uncontrolled laptop with a browser open.** That is stated inside the artifacts rather
than discovered later — total wall time varies by 38% across five runs that produce
byte-identical output.

## Decision

**Microbenchmark the components, in-process, with no I/O, and refuse to call the result a latency
budget.** Every performance artifact in this repository names its scale, its environment, and — in
its own words — what it does not establish.

Concretely: the graph builder and the retrieval adapter are timed with the database substituted by
an in-memory store, so the figure is the code's CPU and nothing else; repeated runs are quoted as
a **median with its range** rather than as a single reading; and where a statistic's honest
precision is one significant figure, it is quoted at one.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **k6 / Artillery against the deployed app** | Measures the hosting tier and the shared database, not the code. Dies to *"what tier?"* |
| **A single-reading p95, quoted to four places** | The measurement is uncontrolled; four places asserts a precision it does not have. [`results/baseline-v1.txt`](../../results/baseline-v1.txt) rules p95 quotable *"at one figure"* for exactly this reason. |
| **A latency budget with a pass/fail threshold** | This was a planned deliverable and it was **cut**, because the controlled measurement it needs does not exist and the uncontrolled figures decline to stand in for it. Cutting it was cheaper than publishing a threshold nothing could honestly be compared against. |
| **A p95 column in the README results table** | The data exists and is tracked. Beside an nDCG column it would imply that the shipped retriever was chosen for speed, which [ADR-0002](0002-lexical-first-retrieval.md) records is false — and its honest precision, one significant figure, is an integer, i.e. the one precision no checker in this repository can see. |

## Consequences

- **The performance numbers this project quotes are small, specific and defensible**, and each
  carries its own refusal. [`results/app-adapter.analysis.txt`](../../results/app-adapter.analysis.txt)
  states in its own text that it is *"not a latency budget"*;
  [`results/graph-characterization.txt`](../../results/graph-characterization.txt) states that it
  is *"not an endpoint latency"* — no database, no network, no serialisation, no browser layout —
  and that its figures are **not extrapolable** between scales.
- **The microbenchmarks were strong enough to decide two real design questions**, which a load test
  would not have been. They priced the graph-builder rewrite and they are what
  [ADR-0007](0007-in-memory-per-user-index.md)'s trigger condition reads.
- **They also caught an error a load test would have hidden.** Reconstructing where the graph
  build's time went showed that the quadratic cost was **not** the loop the plan named: edge
  emission already ran from an inverted index, and the expensive loop was a separate pairwise pass
  — 98.5% of the build at N=500 and 99.5% at N=2000. An aggregate throughput curve cannot say
  which loop.
- **No claim in this repository is a throughput claim.** There is no requests-per-second figure
  anywhere, and that is a deliberate absence rather than an oversight.

## Trigger conditions — what would flip this

Revisit when **any one** holds:

1. **A dedicated tier exists.** A load test against a database plan whose limits are known and
   fixed measures the code again, because the confound is gone.
2. **A published budget exists to test against.** A threshold is only meaningful next to a target
   somebody committed to before the run.
3. **Concurrency becomes part of the product.** Every figure here is one process, no concurrency,
   no cold page cache. A multi-user workload is a different question and this decision does not
   answer it.
4. **A controlled environment becomes available** — a quiet, pinned machine or a CI runner with
   reserved resources — at which point the p95 figures already collected could be re-taken and
   quoted at their real precision.

## Evidence

| Source | What it carries |
|---|---|
| [`results/graph-characterization.txt`](../../results/graph-characterization.txt) | the builder at two scales, its output digests, where the time goes, and an explicit list of what it does not establish |
| [`results/app-adapter.analysis.txt`](../../results/app-adapter.analysis.txt) | index build and search at the app's N, retained memory, and its refusal to be a latency budget |
| [`results/baseline-v1.txt`](../../results/baseline-v1.txt) | the ruling that an uncontrolled p95 is quotable at one significant figure, with the repeat measurements behind it |
| [`results/v5-app-cost.txt`](../../results/v5-app-cost.txt) | cold start and resident memory for the rung that was not shipped, with the same refusals attached |

**Not machine-checked:** every millisecond and MiB figure here is outside `npm run check:claims`,
which scopes to decimals of four or more places. Each is quoted with its environment in the
artifact it comes from, and no claim in this record depends on one being stable.
