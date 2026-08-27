# ADR-0002 — Ship the lexical retriever, not the one that won

- **Status:** Accepted · 11 Aug 2026 · Phase 4.1, after the ladder closed at Phase 3.6
- **Relates to:** [ADR-0006](0006-offline-retriever-interface.md) — the boundary that made six
  implementations comparable; [ADR-0008](0008-external-ground-truth.md) — what the scores are
  scored against; [ADR-0007](0007-in-memory-per-user-index.md) — where this retriever's index lives.

## Context

Six retrieval implementations were built and scored against external human relevance judgments on
a held-out split. The full table is in [`README.md`](../../README.md) and every rung on both
splits is in [`results/test-ladder.txt`](../../results/test-ladder.txt). The two that matter here:

| rung | nDCG@8, held-out split |
|---|---|
| `v4-bm25` — Okapi BM25 over the full text | 0.2391 |
| `v5-embeddings` — MiniLM-L6-v2 dense vectors | **0.3197** |

**Dense embeddings won, and the prediction recorded before the run said they would lose.** That
prediction and its refutation are in the rung's own artifact, which opens *"IT WINS, AND I
PREDICTED IT WOULD LOSE"* — the expectation was ~0.16, on four named arguments, two of which were
then tested and both failed. [`results/v5-embeddings.txt`](../../results/v5-embeddings.txt)

**The hybrid lost to dense alone on both splits** — `v6-hybrid` reaches 0.2996 — despite
reciprocal-rank fusion being the standard recommendation, and **that prediction was wrong too**,
in the other direction. [`results/v6-hybrid.txt`](../../results/v6-hybrid.txt)

Every rung-to-rung comparison carries a paired-bootstrap interval; the one that decides this
record is
[`results/comparisons/v5-embeddings-vs-v4-bm25.test.txt`](../../results/comparisons/v5-embeddings-vs-v4-bm25.test.txt).

So the measurement is unambiguous, and the app ships the rung that came fourth.

## Decision

**Ship `v4-bm25`. Record that it is not the winner, in the README, at the top.**

The reason is **not** latency, and this record exists mostly to stop that story being told later.

## Alternatives rejected

**Ship `v5-embeddings`, the winner.** Rejected on the cost of *keeping it correct*, which is a
schema and lifecycle cost rather than a speed one:

- a **vector stored per note**, which is a schema change on live data;
- that vector **kept in sync with the text** on every save, so a save that updates text and fails
  to re-embed leaves a silently wrong index — and a dense retriever fails *quietly*: handed stale
  vectors it returns ten well-formed, correctly-ordered, plausibly-scored documents;
- a **backfill** for every note that already exists;
- **~232 MiB resident** for the model, paid for the lifetime of the process whether or not anyone
  saves a note — measured at 276.6 MiB RSS after load against a 44.9 MiB baseline, plus 86.9 MiB
  of weights on disk. [`results/v5-app-cost.txt`](../../results/v5-app-cost.txt)
- **it cannot explain why it matched.** BM25 can name the terms.

**Ship it for speed.** Rejected because the premise is false at this scale, and stating it plainly
is the point of this section. At N=500 — the size the app actually runs — index build is 14.0 ms
for BM25 against 1.7 ms for dense, and **search is sub-millisecond for both**: 0.04 ms mean against
0.28 ms. [`results/app-adapter.analysis.txt`](../../results/app-adapter.analysis.txt) says it
directly: the search gap *"is not what decides anything"*. **A latency column beside the nDCG
column would have implied a causal story that the measurements contradict**, which is why the
README table has no such column.

**Ship `v6-hybrid`, as the literature suggests.** It lost to dense alone on both splits, and it
builds *both* indexes — so it inherits every cost above and adds BM25's. It was shipped untuned at
the published `rrfK = 60` default, and it is the rung this project reports as a negative result
rather than omitting. [`results/v6-hybrid.analysis.txt`](../../results/v6-hybrid.analysis.txt)

**Keep the pre-existing overlap coefficient.** `v1-overlap` reaches 0.1361. The shipped rung is a
substantial improvement over what the app had, which is the honest framing of what this decision
bought — not that the best available option was taken.

## Consequences

- **The README leads with a table in which the shipped rung is not the top row.** That is
  deliberate and is the single most load-bearing presentation decision in the project.
- **The app and the eval harness run the same retriever code**, through the interface
  [ADR-0006](0006-offline-retriever-interface.md) defines — so this table is a claim about shipped
  behaviour and not about a laboratory twin.
- **The measured advantage of dense is not an artifact of training contamination**, and that was
  checked rather than assumed. Stratifying the held-out split by whether the judgment predates the
  embedding model's training snapshot, the margin holds **within** the unseen stratum:
  +0.050147 on 208 unseen queries and +0.083669 on 2097 seen ones.
  [`results/contamination-linkdate.test.txt`](../../results/contamination-linkdate.test.txt).
  The gap between those two figures is real and is the reason the decision is recorded as
  *declining a measured win* rather than *disputing it*.
- **A reversal is cheap to argue and expensive to ship.** See the trigger conditions.

## Trigger conditions — what would flip this

Revisit when **any one** holds:

1. **The vector lifecycle stops being the cost.** If notes gain a durable derived-field pipeline
   for another reason — so that "store a vector, keep it in sync, backfill it" is infrastructure
   that already exists — the main objection is paid for by something else.
2. **Resident memory stops being scarce.** ~232 MiB is the figure; it is a bill against the
   hosting tier, not against the laptop it was measured on.
3. **Explainability stops being required by the product.** The related-notes panel currently shows
   a rank derived from a score a human can trace to shared terms.
4. **A hosted embedding endpoint is on the table**, moving the resident cost off the backend
   entirely — which changes the arithmetic above rather than the ranking.

## Evidence

| Source | What it carries |
|---|---|
| [`results/test-ladder.txt`](../../results/test-ladder.txt) | every rung, every metric, every cutoff, held-out split |
| [`results/comparisons/v5-embeddings-vs-v4-bm25.test.txt`](../../results/comparisons/v5-embeddings-vs-v4-bm25.test.txt) | the paired-bootstrap interval on the decisive comparison |
| [`results/contamination-linkdate.test.txt`](../../results/contamination-linkdate.test.txt) | the stratified check on the embedding model's training snapshot |
| [`results/v5-app-cost.txt`](../../results/v5-app-cost.txt) | cold start, per-note embed, resident memory, weights on disk |
| [`results/app-adapter.analysis.txt`](../../results/app-adapter.analysis.txt) | both rungs' index and search cost at the app's N |
| [`results/v6-hybrid.analysis.txt`](../../results/v6-hybrid.analysis.txt) | what RRF fuses, and what it cost |
| [`results/v5-embeddings.txt`](../../results/v5-embeddings.txt) | the winning rung, and the prediction it refuted |
| [`results/v6-hybrid.txt`](../../results/v6-hybrid.txt) | the fusion rung, and the second wrong prediction |
| [`results/test-predictions.txt`](../../results/test-predictions.txt) | the held-out ordering, predicted in its own commit before any test run existed |

**Which numbers are guarded:** the four-place nDCG figures are checked by `npm run check:claims`
against committed artifacts, and the README table's cells are additionally pinned to their own run
sidecars by `backend/tests/readme-results-table.test.js`. The millisecond and MiB figures are
**not** machine-checked — they are uncontrolled laptop measurements, quoted with their environment
in the artifacts above, and no performance claim rests on them.
