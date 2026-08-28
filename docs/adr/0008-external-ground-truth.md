# ADR-0008 — Score against strangers' relevance judgments, not my own labels

- **Status:** Accepted · Phase 1.3 · stratified for contamination at Phase 3.6, 9 Aug 2026
- **Numbering note:** this record was drafted as ADR-0005 in an early plan. **0005 was taken by
  [no response caching](0005-no-response-caching.md)**, which six references across the planning
  documents already cite by number, so this one moved rather than renumbering them.
- **Relates to:** [ADR-0002](0002-lexical-first-retrieval.md) — every score that record compares is
  computed against this key. [`docs/METHODOLOGY.md`](../METHODOLOGY.md) carries the method in full.

## Context

The project's central claim is *"when this app says two notes are related, here is how often it is
right."* That claim needs an answer key, and there were two ways to get one.

**Label my own notes.** Cheap, immediately available, and worthless as evidence: I would be
writing the questions, writing the answers, and grading the exam. The failure is not that the
labels would be dishonest — it is that nothing about them is *checkable by a reader*, and a
retrieval score against self-authored labels measures agreement with my own intuitions.

**Borrow a key strangers already wrote for their own reasons.** Stack Exchange records
`Duplicate` and `Related` links between questions, created by moderators and high-reputation users
as ordinary site maintenance, years before this project existed and with no knowledge of it.

## Decision

**Use Stack Exchange post links as graded relevance judgments**, over a single site's question
corpus, split into tuning and held-out sets. Report on the held-out split. **Publish what the key
misses in the same breath as what it says**, because a borrowed key has known defects and hiding
them would undo the reason for borrowing it.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **Self-authored labels over my own notes** | Unfalsifiable by a reader. It is the exam-grading problem, and it is the single most common way a portfolio retrieval claim is worthless. |
| **An LLM-generated answer key** | Substitutes one model's opinion for a measurement, and the retrievers being scored would then be graded by a system with correlated blind spots. |
| **A standard IR collection (TREC, BEIR)** | Better keys, wrong shape. The question here is *"given a document, find related documents"* — document-as-query — and the corpus has to plausibly resemble a notebook. |
| **`bpref` as the incompleteness mitigation** | The standard answer for incomplete judgments, **measured and rejected**: on a positive-only key it collapses to recall at the run's depth, matching `recall_1000` to 1e-12. It would have been a column silently duplicating recall under a name implying robustness. The column was dropped rather than left blank, because a blank reads *"not measured yet."* |
| **Reporting on the tuning split** | Every parameter choice was made against tuning; the ladder is reported on a split that no decision was taken against. |

## Consequences

- **The scores are low, and that is what a real key does.** For lexical retrieval on this kind of
  judgment, nDCG@8 in the 0.1–0.4 range is unremarkable and probably real — a score above ~0.7
  would be evidence of a bug rather than of success.
- **The key is thin, and its thinness is measured.** It has a **median of one judgment per query**,
  so a query scores exactly zero whenever its single judged document misses the top eight. Under
  the ladder's winner that is **1,039 of 2,304 tuning queries — 45.1%**.
  [`results/error-analysis.md`](../../results/error-analysis.md)
- **The thinness is not evenly distributed, and that biases the obvious analysis.** A document's
  judged degree tracks how much corpus was created after it — ρ = +0.181, with a 2010 question
  roughly 4.5× more judged than a 2024 one. **So ranking queries by score to find "the worst
  cases" preferentially surfaces recent, thinly-judged queries where the retriever may have done
  nothing wrong.** Any per-query error analysis has to check a failing query's age before
  concluding the retriever failed.
- **One retriever was trained on data containing this site, and that was checked rather than
  waved away.** Stratifying the held-out split by whether a judgment predates the embedding
  model's training snapshot: the dense rung's margin is **+0.050147** on the 208 fully
  post-snapshot queries and **+0.083669** on the 2,097 with any pre-snapshot judgment. The margin
  survives in the uncontaminated stratum and is **smaller** there — reported that way round.
  [`results/contamination-linkdate.test.txt`](../../results/contamination-linkdate.test.txt)
- **The metric implementation is validated against the reference, not trusted.** `nDCG`, `P`, `R`
  and `MRR` agree with `pytrec_eval` — the NIST reference — to **1.11e-16** against a tolerance of
  1e-06, on a hash-pinned wheel.
  [`results/metric-validation.txt`](../../results/metric-validation.txt)
- **The held-out split is protected procedurally, not just by intention.** The error-analysis
  driver refuses to run against it in code, so failure cases feeding later design work cannot
  quietly turn the held-out split into a design input.

## What this key cannot say

Stated here because [ADR-0002](0002-lexical-first-retrieval.md) rests on it:

- **It is not a measurement on user notes.** There are none. Stack Exchange questions are longer
  and more topically concentrated than a personal notebook, so every figure derived from them is
  an upper bound on corpus size and an unknown on style.
- **It is positive-only.** An unjudged document is not a *negative*; it is unjudged. Precision at
  small `k` is therefore pessimistic by an unmeasurable amount.
- **`Related` and `Duplicate` are one site's editorial conventions**, applied unevenly by
  different people over more than a decade.

## Evidence

| Source | What it carries |
|---|---|
| [`results/error-analysis.md`](../../results/error-analysis.md) | the key's density, the zero-score tie, and the age bias with its correlation |
| [`results/error-analysis.dev.txt`](../../results/error-analysis.dev.txt) | the computed report every count above is read from |
| [`results/contamination-linkdate.test.txt`](../../results/contamination-linkdate.test.txt) | the training-snapshot stratification, both strata, on the held-out split |
| [`results/metric-validation.txt`](../../results/metric-validation.txt) | agreement with `pytrec_eval`, its pinned wheel, and the reference's probed tie-break |
| [`results/baseline-v1.txt`](../../results/baseline-v1.txt) | why `bpref` was measured and dropped |
| [`results/test-ladder.txt`](../../results/test-ladder.txt) | per-rung query counts, zero-result counts and unjudgeable counts on the held-out split |

**Which numbers are guarded:** the four-place and exponent-form figures above are checked by
`npm run check:claims` against the artifacts listed. The counts, percentages and the
three-place correlation are **not** machine-checked and are re-read from the artifacts rather
than remembered. **The corpus, the answer key and the splits are gitignored** — they are large and
regenerable — so they are identified here by the SHA-256 each committed run sidecar records
alongside the run it produced, never by a path a reader cannot follow.
