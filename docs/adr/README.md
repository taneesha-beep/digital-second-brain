# Architecture decision records

One record per non-obvious decision: context, decision, alternatives rejected, consequences —
and, for a decision **not** to build something, the trigger conditions that would flip it.

**Four of these eight document a decline.** That is deliberate. A list of what was added says
what tools someone has touched; a reasoned decision not to add something, with the price of the
thing declined and the conditions under which the answer changes, is the harder thing to write and
the more useful thing to read.

| # | Decision | Kind |
|---|---|---|
| [0001](0001-canonical-edge-storage.md) | One canonical row per note pair | Build |
| [0002](0002-lexical-first-retrieval.md) | Ship the lexical retriever, not the one that won | **Decline a measured win** |
| [0003](0003-no-job-queue.md) | No job queue | **Decline** · trigger conditions |
| [0004](0004-microbenchmark-not-load-test.md) | Microbenchmark the code, do not load-test the tier | **Decline** · trigger conditions |
| [0005](0005-no-response-caching.md) | No response caching for the AI features | **Decline** · trigger conditions |
| [0006](0006-offline-retriever-interface.md) | A pure retriever interface, with no I/O inside it | Build |
| [0007](0007-in-memory-per-user-index.md) | Build the index in memory per user; no persisted DF collection | **Decline** · trigger conditions |
| [0008](0008-external-ground-truth.md) | Score against strangers' relevance judgments, not my own labels | Build |

## Rules these records follow

- **Every number traces to a committed artifact under [`results/`](../../results/).** No record
  cites a planning document, because most of this project's planning documents are unpublished and
  a reference a reader cannot follow is worse than no reference.
- **Figures of four or more decimal places are machine-checked** by `npm run check:claims`, which
  requires each to be the correct rounding of a value in a committed artifact. **Counts,
  percentages and shorter decimals are not** — every record says so where it quotes one.
- **A decline names its price.** Declining something cheap is not a decision.

## Numbering

**0008 was drafted as 0005 and moved.** By the time these were written, `0005` was cited as
*no response caching* by six references across the planning documents and `0007` was cited as
*the in-memory per-user index* by five, while an early plan's file tree had assigned `0005` to
external ground truth — a collision, not a gap. The numbers with citations kept them and the one
without moved, so no existing reference needed renumbering. Numbers are never reused.
