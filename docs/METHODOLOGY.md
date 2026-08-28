# How the retrieval was measured

**The results in [`README.md`](../README.md) rest on four claims.** This document answers each one
and points at the committed file that proves it.

It is deliberately short. The full lab notebook is not published — it is written to a reader who
has the whole repository in their head, and this is not that. **Everything below traces to a file
in [`results/`](../results/) that you can open.**

| The question | Short answer |
|---|---|
| [Where did the answer key come from?](#1-where-did-the-answer-key-come-from) | Strangers' link decisions on Stack Exchange, made years earlier for their own reasons |
| [How do you know the scoring is correct?](#2-how-do-you-know-the-scoring-is-correct) | Checked against `pytrec_eval`, the NIST reference, to 1.11e-16 |
| [What did you tune on, and what did you report?](#3-what-did-you-tune-on-and-what-did-you-report) | Tuned on one split, reported on another, and the code refuses to cross the line |
| [What can this key *not* tell you?](#4-what-can-this-key-not-tell-you) | A great deal — measured, and published |

---

## 1. Where did the answer key come from?

**Not from me.** Labelling my own notes would mean writing the exam, taking it, and grading it —
and marking as correct exactly the links the algorithm was already built to find.

The judgments come from **Seasoned Advice** (`cooking.stackexchange.com`), where moderators and
high-reputation users have spent years marking one question as a duplicate of another, or as
merely related. That labelling was done long before this project existed and with no knowledge of
it.

**The corpus** is every question in that site's public data dump — **27,325 documents**, recorded
in every run's sidecar as `retriever.docCount`.

**The judgments** come from the dump's `PostLinks.xml`, **9,336 rows**, of which two link types
appear:

| Link type | What a human did | Grade |
|---|---|---|
| `1` — *Linked* | An answer or comment referenced another question | **1** |
| `3` — *Duplicate* | Closed as a duplicate, on multiple independent close votes | **2** |

Duplicates grade higher because finding a genuine duplicate is a better result than finding
something merely adjacent, and nDCG's `2^grade − 1` gain rewards it accordingly.

**The inputs are large and are not in this repository** — the corpus and the answer key are tens
of megabytes and are regenerable from the public dump. **What makes them citable is not their
presence but their SHA-256**, and every run records the digest of every input it consumed:

```json
"inputs": [
  {"name": "corpus", "file": "…/cooking.jsonl",  "sha256": "db8902c5…", "matchesManifest": true},
  {"name": "qrels",  "file": "…/cooking.qrels",  "sha256": "d92fb8c6…", "matchesManifest": true},
  {"name": "split",  "file": "…/cooking.test.txt","sha256": "95d3f5a7…", "matchesManifest": true}
],
"git": {"commit": "8d6334d2…", "dirty": false}
```

So a figure in the README is traceable to a run, the run to its exact input bytes, and those bytes
to the commit that produced them. **Every `.run.json` sidecar under
[`results/runs/`](../results/runs/) carries this block** — they are committed; the run files
themselves are not, because they regenerate and the provenance does not.

> **The dump's own digest is recorded too.** `PostLinks.xml`, the file every judgment derives
> from, is `4e8ccda4…` — quoted in
> [`results/contamination-linkdate.test.txt`](../results/contamination-linkdate.test.txt), which
> also records the 9,336-row count.

---

## 2. How do you know the scoring is correct?

**Because it was checked against the reference implementation rather than trusted.**

Writing your own nDCG is easy and getting it subtly wrong is easier — a tie-break, a gain formula,
whether an unjudged document counts as zero. Any of those shifts every number in the project
without failing anything.

The metrics here — nDCG, precision, recall and MRR — are computed against **`pytrec_eval`**, the
Python binding to NIST's `trec_eval`, on a **hash-pinned wheel** installed with
`pip --require-hashes`.

```
maximum absolute difference   1.11e-16     against a tolerance of 1e-06
```

`1.11e-16` is floating-point noise — the smallest gap two doubles can have near 1. The
implementations agree exactly.

**The reference's own behaviour was probed, not assumed.** Its tie-break on equal scores is
*docid descending*, which had to be discovered by testing the installed binary, because that
choice changes scores whenever two documents tie.

**Every run re-states this**, so it cannot quietly stop being true:

```json
"metricsValidation": {
  "reference": "pytrec-eval-terrier 0.5.10",
  "tolerance": 1e-06, "maxAbsDelta": 1.11e-16,
  "evidence": "results/metric-validation.txt"
}
```

**One measured negative worth stating.** `bpref` is the standard fix for incomplete judgments, and
it was measured and **rejected**: on a key with only positive judgments it collapses to recall at
the run's depth, matching `recall_1000` to 1e-12. It would have been a column duplicating recall
under a name implying robustness. The column was dropped rather than left blank — a blank reads
*"not measured yet"*, and this was measured.

→ [`results/metric-validation.txt`](../results/metric-validation.txt) ·
[`results/baseline-v1.txt`](../results/baseline-v1.txt)

---

## 3. What did you tune on, and what did you report?

**Tuning happened on one split. Every number in the README comes from a different one.**

The queries were divided with a seeded shuffle into **train / dev / test**. Two of those matter
here:

| Split | Queries | Used for |
|---|---|---|
| **dev** | **2,304** | every parameter choice, every sweep, every ablation, all six rungs' development |
| **test** | **2,305** | reported once, at the end |

The split is reproducible by construction: a **seeded** `mulberry32` generator with integer-only
state, so the shuffle is identical on every platform. Node's `Math.random()` cannot be seeded and
was unusable. Each split file's SHA-256 is recorded in every run that used it.

**The discipline is enforced in code, not by intention.** The per-query error analysis — the step
that looks at *why* the winner failed and feeds later design work — **refuses `--split test` in
the script itself.** Reading failure cases out of the held-out split would make it a design input
without anything noticing, which is the quiet version of the failure this separation exists to
prevent.

→ [`results/error-analysis.md`](../results/error-analysis.md) says so in its own header.

**Comparisons carry intervals, and the family was registered in advance.** Every rung-to-rung
comparison has a paired-bootstrap confidence interval, in
[`results/comparisons/`](../results/comparisons/). Seven of them were **pre-registered** in
[`results/comparisons/registry.json`](../results/comparisons/registry.json) before the test split
was opened, and a Holm–Bonferroni correction is applied to that family at a family-wise
`alpha 0.05`, smallest threshold `alpha/7 = 0.00714`.

**And the correction's limits are stated rather than glossed.** The five ladder steps run on test
carry intervals and **no p-value**, and do not enter the family — *"survives Holm"* is a statement
about the split a comparison was registered on.

→ [`results/holm-family.txt`](../results/holm-family.txt) ·
[`results/test-ladder.txt`](../results/test-ladder.txt)

**Predictions were written down before the runs, and two of them were wrong.** That is recorded in
the rungs' own artifacts rather than quietly dropped — see
[ADR-0002](adr/0002-lexical-first-retrieval.md).

---

## 4. What can this key *not* tell you?

**The most important section, and the shortest to state honestly.**

**It is thin.** The key has a **median of one judgment per query**. A query therefore scores
exactly zero whenever its single judged document misses the top eight — which, under the best
retriever on the ladder, is **1,039 of 2,304 dev queries: 45.1%**. Those are not 1,039 failures;
most are a coarse key meeting a short list.

**It is positive-only.** An unjudged document is *unjudged*, not a negative. Precision at small
`k` is therefore pessimistic by an amount nobody can measure.

**It contains two populations, not one.** Splitting the same queries by what kind of judgment they
carry:

| Key composition | Queries | Zero rate | Mean nDCG@8 |
|---|---|---|---|
| grade 1 only (*linked*) | 1,766 | 49.4% | 0.297554 |
| any grade 2 (*duplicate*) | 538 | 31.0% | 0.423199 |

**That gap is larger than the entire step from the shipped retriever to the winner.** Nothing
published is wrong because of it — both sides of every comparison face the identical mixed key —
but every single figure is an average across two quite different populations, and a reader should
know that.

**Its density is uneven in a way that biases the obvious analysis.** A document's judged degree
tracks how much of the corpus was created after it (ρ = +0.181; a 2010 question is roughly 4.5×
more judged than a 2024 one). **So ranking queries by score to find "the worst cases"
preferentially surfaces recent, thinly-judged queries where the retriever may have done nothing
wrong.**

**One retriever was trained on data containing this site**, and that was checked rather than waved
away. Stratifying the held-out split by whether a judgment predates the embedding model's training
snapshot, the dense rung's advantage is **+0.050147** on the 208 fully post-snapshot queries and
**+0.083669** on the 2,097 others. It survives in the uncontaminated stratum, and it is
**smaller** there — reported that way round.

**It is not a measurement on personal notes.** There are none. Stack Exchange questions are longer
and more topically concentrated than a notebook, so these figures are an upper bound on corpus
size and an unknown on style.

→ [`results/error-analysis.md`](../results/error-analysis.md) ·
[`results/error-analysis.dev.txt`](../results/error-analysis.dev.txt) ·
[`results/contamination-linkdate.test.txt`](../results/contamination-linkdate.test.txt) ·
[ADR-0008](adr/0008-external-ground-truth.md)

---

## Where to go next

- **The results** → [`README.md`](../README.md), and every rung on both splits in
  [`results/test-ladder.txt`](../results/test-ladder.txt)
- **Why the winner is not what ships** → [ADR-0002](adr/0002-lexical-first-retrieval.md)
- **How the system is built** → [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
- **How it fails** → [`docs/FAILURE-MODES.md`](FAILURE-MODES.md)

## Provenance

**Every source named here is a committed file.** This document cites artifacts only — never the
project's planning documents, which are deliberately unpublished, because a reference a reader
cannot follow is worse than no reference. The large inputs are named by **SHA-256 taken from a
committed run sidecar**, never by a path that resolves only on the author's machine.

**Which numbers are guarded.** This file is scanned by `npm run check:claims`, which verifies that
every decimal of four or more places is the correct rounding of a value in a committed artifact —
so the nDCG figures above are checked. **The counts and percentages are not**, by construction:
that scope is deliberate, and it means percentages like `45.1%` and `49.4%` are outside it.

**A second guard covers what `check:claims` structurally cannot.**
`backend/tests/methodology-tables.test.js` pins the two measured tables, the corpus size and the
input digests to the specific artifacts they claim to come from — because a checker that verifies
a number *exists somewhere* cannot see a number in the **wrong row**, and swapping the two rows of
the key-composition table would invert this document's main finding while every value in it stayed
real. Mutation-checked with eight deliberate corruptions.

**One figure is deliberately absent.** The total query set and the size of the *train* split
appear in no committed artifact — only in a gitignored manifest — so they are not quoted here.
Train is never reported on, so nothing above needs them.
