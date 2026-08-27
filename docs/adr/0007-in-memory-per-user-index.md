# ADR-0007 — Build the index in memory per user; no persisted document-frequency collection

- **Status:** Accepted · 11 Aug 2026 · Phase 4.1, with its trigger condition re-derived 16 Aug 2026
- **Relates to:** [ADR-0002](0002-lexical-first-retrieval.md) — the retriever whose index this is;
  [ADR-0004](0004-microbenchmark-not-load-test.md) — the measurements this record's trigger reads.

## Context

BM25 needs document frequencies, and document frequencies are a property of a *collection*. The
textbook answer is to persist them: a collection of terms and counts, updated as notes are written,
so no request pays to rebuild.

This app rebuilds the whole index, in memory, from the user's notes, on every call that needs one —
and then throws it away.

## Decision

**Keep it.** Build per user, in memory, per call. Persist nothing, cache nothing.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **A persisted document-frequency collection** | It is a second source of truth for a derived value. Every write has to update it, and any write that fails to leaves the index silently wrong — and *silently* is the operative word, because a retriever with a stale DF table returns well-formed, plausibly-ranked results. |
| **A cached per-user handle, invalidated on write** | Cheaper and still wrong for the same reason: a cache needs invalidation on every write, and a stale index is the same class of defect as the stale stored-keyword lists this project has already measured. It is also **2.57 MiB resident per user** if a cache holds one handle each — a real number that a single-tenant app has no reason to start spending. |
| **Recomputing keywords at read time instead** | Measured and declined at a price: **2237.0 ms at N=500** against the graph builder's own 5.1 ms. That is a separate closed decision and it is not re-opened here. |
| **Capping the global graph's input** | What "the global graph" means at several thousand notes is a product decision, not a performance one. |

## Consequences

- **The index build is paid on every call that needs one**, and it is small at the scale the app
  runs. At N=500 — the per-user cap — index build is **mean 14.0 ms** and search is **mean
  0.04 ms**, both in-process with no I/O.
  [`results/app-adapter.analysis.txt`](../../results/app-adapter.analysis.txt)
- **It is paid off the response path.** The note-save path's two jobs are un-awaited, so the
  rebuild does not sit in front of the user — see [ADR-0003](0003-no-job-queue.md).
- **There is no second source of truth to go stale**, which is the property being bought.
- **The document-frequency cutoff in the graph builder is inert at the app's scale and live above
  it**, which is measured rather than assumed: at N=500 **no term exceeds the cutoff and zero
  edges are removed**; at N=2000, 54 terms exceed it and **52.7% of cross-edges** are removed.
  [`results/graph-characterization.txt`](../../results/graph-characterization.txt)

## Trigger conditions — what would flip this

**Read the N=500 row, and read it as a direction rather than as a discount.** This is the part of
the record that took a correction, and it matters:

`Σ_t df_t²` — the bound on all-pairs edge emission — is **2.0710e+4** over the truncated
vocabulary at N=500, against **1.5626e+5** over the full one: a ratio of **7.55×**, inside a
worst case of 250,000. At the corpus scale the eval harness runs, the same ratio is **21.78×**.

**The ratio is not scale-free, and this record originally assumed it was.** `Σ_t df_t²` is
dominated by the head of the document-frequency distribution; that head grows super-linearly in N
while the truncation rule does not. **So the penalty grows as a collection grows.** It is not a
discount bought once.

Revisit when **any one** holds:

1. **Per-user corpora exceed a few thousand notes.** The concrete evidence is the jump above:
   between N=500 and N=2000 the cutoff goes from removing nothing to removing more than half the
   emitted edges, and the frozen builder's whole-build cost goes from 225.1 ms to 3656.9 ms.
2. **Index rebuild appears in a latency budget.** There is no such budget today
   ([ADR-0004](0004-microbenchmark-not-load-test.md)); if one is ever published, this is one of
   the first lines it would price.
3. **Index build moves onto the response path.** Today it is off it. If a synchronous caller ever
   needs a fresh index, the 14.0 ms becomes user-visible and the arithmetic changes.
4. **A per-user cache becomes affordable and invalidation becomes trustworthy** — the 2.57 MiB
   figure is the per-user rent, and the invalidation correctness is the real blocker, not the
   memory.

**None of the four holds today**, and the figures that would show the first one are re-derivable
by one pure command against a committed script.

## Evidence

| Source | What it carries |
|---|---|
| [`results/app-adapter.analysis.txt`](../../results/app-adapter.analysis.txt) | index build and search across the ≤500 bracket, retained memory per handle, and the `Σ_t df_t²` table at app scale — it names this record's trigger condition in its own text |
| [`results/graph-characterization.txt`](../../results/graph-characterization.txt) | the document-frequency table at N=500 and N=2000, the cutoff's arithmetic derived independently of any diff, and the statement that these figures are **not extrapolable** between scales |
| [`results/keyword-stability.txt`](../../results/keyword-stability.txt) | how unstable a *stored* derived list is — the defect this decision avoids by not persisting one |

**Which numbers are guarded:** the exponent-form `Σ_t df_t²` figures are checked by
`npm run check:claims` against the artifacts above. The millisecond, MiB and percentage figures are
**not** machine-checked — they are uncontrolled in-process measurements quoted with their
environment, and this record's argument rests on the **direction** of the N=500 → N=2000 change
rather than on any single value.
