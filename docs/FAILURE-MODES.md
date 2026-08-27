# Failure modes — measured

**Phase 7.1.** Every way this system is known to break, each with a measured frequency, the
denominator that frequency is over, and the committed artifact it was read from.

**No entry without a number.** A list of things that might go wrong is a brainstorm; anyone can
write one without running anything. What makes this document worth reading is that each row was
observed at scale and counted. Modes that are real but were never counted are in §5, kept
separate on purpose, and they are not mixed into the tables above them.

This is an **assembly**, not a measurement campaign. No run was issued to produce it and no API
quota was spent. Every figure below already existed in a committed file on 23 Aug 2026.

---

## 1. How to read this

### 1.1 The denominator is part of the number

The single most repeated mistake in this project's own history is quoting a rate without saying
what it is a rate *of*. The same defect measured over calls and over items gives two different
numbers, and both are correct.

Study-pack truncation is the worked example. Over **calls** it is 23.3%. Over **items** it is
0.0%, because a truncated call contributes no items at all — every item that exists came from a
call that finished. Neither figure is wrong and quoting one where the other belongs is.

So every row names one of: **dev queries** (2,304), **calls**, **items**, **seeds**,
**judged pairs**, **JSON calls**, or **occurrences**.

### 1.2 Three kinds of entry, and they are not interchangeable

- **A rate over a full population.** A count over every unit in a named run. §2 and §3.
- **A count with no rate available.** Something observed a fixed number of times where no
  denominator exists — a provider retiring a model is not 1-in-*n* of anything. Labelled
  `occurrences`.
- **Observed but never counted.** Real, seen, and with no frequency behind it. §5, and it stays
  out of the tables.

### 1.3 What a frequency here is not

**A hand-read sample is not a frequency.** Twenty dev queries were read by hand under a protocol
fixed in advance, drawn five from each of four cells. Those counts are out of 20 and out of 5,
they are not a rate over anything, and they are **never reweighted into one**. Where a hand-read
observation is the only evidence for a mode, that mode is in §5.

**Every retrieval absolute is a lower bound.** The answer key holds positive judgments only — a
link means "related", but the absence of one does not mean "unrelated", it may only mean nobody
noticed. See §6.

---

## 2. Retrieval

The system's job is: given a note, find the other notes that relate to it. That is retrieval, and
it is measured against external human relevance judgments from a Stack Exchange dump — moderation
decisions made by cooking enthusiasts years ago for reasons unconnected to this project.

Unless stated otherwise every row is over the **dev split, 2,304 queries, all judgeable**, under
the ladder's winning retriever `v5-embeddings`, from run file sha256
`89227f28f7cd61faae77f80df9f95bf088a2f6513664a21f5dbc1db24a0fbf97`.
Source artifact: [`results/error-analysis.dev.txt`](../results/error-analysis.dev.txt),
narrative in [`results/error-analysis.md`](../results/error-analysis.md).

> **⚠️ THE MEASURED RETRIEVER AND THE SHIPPED RETRIEVER ARE NOT THE SAME ONE, AND READING THIS
> SECTION AS "WHAT THE APP DOES" WOULD BE WRONG.** `v5-embeddings` won the ladder; the
> application ships **`v4-bm25`**, chosen on storage cost rather than on score — a dense
> retriever needs a vector per note kept in sync with the text, and a stale vector has no
> symptom. So R1–R3 describe **the best retriever measured**, and are the right rows for
> "how hard is this problem", while R4 and R5 are about configurations the app has actually
> run. Where a row is about the shipped retriever it says so.
>
> The two are not far apart on this key and the gap is stated rather than waved at: on the
> held-out test split `v4-bm25` scores **0.2391** against `v1-overlap`'s **0.1361**, and
> `v5-embeddings` beats `v4` by roughly 0.08 on dev. Both sit inside the band that is
> unremarkable and probably real for lexical retrieval against duplicate judgments; anything
> above ~0.7 here would mean a bug, not a success.

### 2.1 The partition — where the winner scores zero

**45.1% of dev queries score exactly nDCG@8 = 0** (1,039 of 2,304). That is not one failure mode,
it is four, and they have very different causes. This partition is computed, not sampled:

| mode | queries | of the zero population | **of the split** |
|---|---|---|---|
| **R1** no rung of the six reached the key at all | **732** | 70.5% | **31.8%** |
| **R2** another rung found it, the winner did not | **247** | 23.8% | **10.7%** |
| **R3** near-miss — a judged document at rank 9 or 10 | **60** | 5.8% | **2.6%** |
| **R4** zero-result — the retriever returned nothing | **0** | 0.0% | **0.0%** |
| | 1,039 | 100.0% | 45.1% |

**Denominator: dev queries, 2,304.**

---

**R1 — unreachable. 732 queries, 31.8% of the split. The largest single mode in this document.**

*Trigger:* none of the six retrievers places any judged document in its top 10.
*Blast radius:* total for that query — the related-notes panel shows nothing the key agrees with.
*Mitigation:* none available at the retriever. This is the mode that does not respond to ranking
work, and a large share of it is the answer key rather than the system (§6).
*Detection:* `npm run analyse:errors` recomputes the partition from committed run files.

**R2 — sibling-reachable. 247 queries, 10.7% of the split.**

*Trigger:* at least one other rung of the ladder placed a judged document in its top 10 and the
shipped winner did not. `v4-bm25` alone reaches 149 of these (60.3%), `v6-hybrid` 142,
`v3-tfidf` 127, `v1-overlap` 69, `v2-jaccard` 68; the sets overlap.
*Blast radius:* one query's panel, and by construction the miss is recoverable — some other
scoring function found it.

> **This is not a defect list, and it was designed as one.** The prediction going in was that a
> sibling finding the document proves the winner erred. Of ten C2 cases read by hand, **six were
> unjudged hits** — the winner returned something at least as relevant as the graded answer.
> Findable and most-relevant are independent properties. Do not read 10.7% as 10.7% wrong.

**R3 — near-miss. 60 queries, 2.6% of the split.**

*Trigger:* a judged document at rank 9 or 10, just outside the reporting depth of 8.
*Blast radius:* small — the link cap is 8, so these are one or two slots from succeeding.
*Mitigation:* raising the cap. Measured and declined: the cap sweep is flat past 8.

**R4 — zero candidates above threshold. 0 for the shipped winner, and this row exists for its
history.**

*Trigger:* every candidate scores at or below the score floor, so nothing is returned.
*Denominator:* dev queries (2,304), and test queries (2,305) in the last column.
*Source:* the tracked run sidecars `results/runs/<label>.<split>.run.json`, field
`queries.zeroResult`. The qid lists are regenerable and not committed.

| configuration | dev | test | mechanism |
|---|---|---|---|
| `v1-overlap`, threshold **0.15** (the shipped default until Phase 4.1) | **11** (0.48%) | 9 | best candidate scores exactly 0.1000 — one shared word in ten |
| `v1-overlap`, threshold **0** | **0** | — | nothing is rejected |
| `v1-overlap`, threshold **0.2** | **461** | — | one lattice step up demands three shared words |
| `v2-jaccard`, `minShared` 2 | **12** (0.52%) | 9 | the same 11, plus one document that extracts a single keyword |
| `v2-jaccard-naive`, threshold 0.15, `minShared` 1 | **452** (19.6%) | — | Jaccard at v1's numeral demands three shared words |
| `v3-tfidf`, `v4-bm25`, `v5-embeddings`, `v6-hybrid` | **0** | **0** | no score floor |

**Three things this table says that the one-line version of this mode does not.**

The frequency is a property of the **threshold**, not of the retriever — 0, 11 and 461 are the
same algorithm at three floors one lattice step apart. **The trigger is "best candidate at or
below the threshold", not "no candidates exist"**; all 11 have candidates and are rejected by a
single word. And **the mode is dead at the top of the ladder**: the four rungs with no score
floor return results for every query in both splits, so this is a `v1`-era mode that the shipped
`v4-bm25` cannot exhibit.

### 2.2 R5 — a one-keyword note links at maximum strength

**1 of 2,304 dev queries. Denominator: dev queries.**

*Trigger:* a document whose text reduces to exactly one distinct token after stopwords. Dev query
52326 — *"What are marshmallows and how are they made?"* — is the only one.
*Mechanism:* `v1-overlap` scores `|shared| / max(|sourceKeywords|, 1)`. At one keyword any
document sharing that single word scores `1/1 = 1.0000`, the maximum the algorithm can emit, so
eight coincidental matches outrank every genuine multi-word relationship.
*Blast radius:* eight wrong links at full confidence, presented identically to correct ones.
*Why it is here despite n = 1:* it is a **false-positive** mode, and it is invisible in every
zero-result count — the query returns a full set of links, all of them maximally confident.
*Mitigation:* shipped. Normalisation fixes it: `v3-tfidf` returns 10 results for 52326 with a top
score of **0.799187** rather than 1.0000, because a cosine asks how much of the *target* is about
marshmallows instead of what fraction of the query's one word is shared. The app runs `v4-bm25`
and no longer has this mode.
*What does not fix it:* a larger vocabulary. The document holds one distinct token at full
vocabulary too, so the corner belongs to the document rather than to top-10 truncation.

---

## 3. Generation

Six AI features run on a hosted model. Five take a single note. The sixth — **Study Pack** — is
retrieval-augmented: it sends a note plus its retrieved neighbours and returns flashcards and
concepts that each cite a source note. Study Pack is where a retrieval failure and a generation
failure can compound, so most of the rows below are about it.

Source artifacts: the per-call ledgers `results/gen-*.calls.jsonl`, all tracked, and the three
pure reporters over them — `npm run eval:gen`, `npm run eval:judge`, `npm run eval:v7`. None of
the three issues an API call.

### 3.1 G1 — a study pack truncates at the output ceiling

**7 of 30 calls (23.3%) in each of two arms; 14 of 60 pooled. Denominator: calls.**

| arm | retriever | truncated | mean words, truncated seeds | mean words, kept |
|---|---|---|---|---|
| gen-v5 | `v4-bm25` | 7 of 30 — **23.3%** | 140.4 | 87.3 |
| gen-v7 | `v5-embeddings` | 7 of 30 — **23.3%** | 151.3 | 84.0 |

*Trigger:* seed length. **Truncation is a property of the seed, not of the retriever** — the two
arms truncate at the identical rate and share 5 of their 7 seeds, which is what a 64%-better
retriever failing to move it establishes.
*Blast radius:* **total, and it is the worst in this document.** A cut-off pack is not partial
JSON, it is unparseable — so shape conformance, cardinality and item count all fail together and
the call yields **zero** items. Shape conformance 76.7% and empty-pack rate 23.3% are not three
findings, they are the same seven calls: `76.7 = 100 − 23.3`.
*Second-order cost:* the item set is **censored at the call level**, and not at random. The seven
lost packs are systematically the longer seeds, so judged items by length quintile run
Q1 84, Q2 70, Q3 56, Q4 70, Q5 42 — six of six seeds surviving in the shortest quintile and three
of six in the longest. **Every groundedness figure in §3.6 is therefore measured over 23 of 30
seeds, skewed short.**
*Detection:* `finish_reason === 'length'`, recorded on every ledger row.

> **Mitigation shipped 23 Aug 2026, and the after-figure does not exist yet.**
> The ceiling was `max_tokens: 2048`, inherited from a single-note feature and never derived for
> a study pack. `services/studyPack.service.js` now sets its own `STUDY_PACK_MAX_TOKENS = 4096`.
> **23.3% is the before-figure. The post-change truncation rate is UNMEASURED** — establishing it
> needs a run at the new ceiling, which has not been bought. The honest sentence is *"the ceiling
> was inherited from a different feature, it bound on 23.3% of packs, and it is now set for this
> one"*, never *"conformance improved to X"*.
>
> The value is **picked, not derived**, and the distinction matters: every run this project holds
> is censored at exactly the quantity that would have to be estimated, because a truncated call is
> recorded at the ceiling rather than at what it wanted. Across 60 calls in two arms the worst
> *completing* call wrote **2,044 of 2,048**. 4,096 is the smallest doubling that requires no
> estimate of the region the data cannot see.

### 3.2 G2 — a single-note feature truncates, and it is a cliff rather than a slope

**Denominator: calls per feature, 30 seeds each.** The five single-note features are held at
`max_tokens: 2048` deliberately — they are the A/B control for Study Pack — so the second column
is the live configuration.

| feature | truncated at 1,024 (`gen-v1`) | truncated at 2,048 (`gen-v2`) |
|---|---|---|
| `examQs` | **14 of 30 — 46.7%** | **1 of 30 — 3.3%** |
| `eli5` | 2 of 30 — 6.7% | 0 of 30 — 0.0% |
| `flashcards` | 0 of 30 — 0.0% | 0 of 30 — 0.0% |
| `concepts` | 0 of 30 — 0.0% | 0 of 30 — 0.0% |
| `summarize` | 0 of 30 — 0.0% | 0 of 30 — 0.0% |

*Trigger:* a prompt that asks for long-form content. `examQs` requests *"5 exam-style questions
with detailed answers"* and averaged 945 output tokens against a 1,024 ceiling; `flashcards`
averaged 602 and `concepts` 402.
*The shape is the finding.* An output ceiling produces a **threshold**, not a gradient — three of
five features sat at exactly zero while one sat near half. Predicting a smooth ordering by
requested output length was wrong for four features at once.
*Caveat on the 46.7%:* a re-draw counterfactual over the full 30 seeds puts the 1,024 ceiling as
genuinely binding on **43.3%**. The remaining 3.4 points are within-cell variance, not the
ceiling — the same draw that truncates once may not truncate again.
*Blast radius:* for `examQs`, a malformed JSON payload the client cannot render.
*Detection:* `finish_reason`, and the pure schema predicate `scripts/lib/gen-schema.js`.

### 3.3 G3 — a prose feature truncates and no metric can see it

**2 of 30 calls (6.7%) at 1,024; 0 of 30 (0.0%) at 2,048. Denominator: calls.**

*Trigger:* the same output ceiling, on `eli5` and `summarize`, which return prose.
*Blast radius:* small per incident and **structurally invisible**, which is why it has its own
row. Those two features have no schema, so a response cut off mid-sentence passes every
conformance check in the project. It counts as a success everywhere.
*Why the study pack does not have this defect despite truncating far more:* a study pack is JSON,
so a cut-off pack fails the shape predicate and is caught. The mode is not "truncation", it is
"truncation with no schema behind it", and only `summarize` and `eli5` can exhibit it.
*Mitigation:* `eval:gen` now prints a truncation column for all five features beside an `n/a` in
the conformance column, so the invisible case is visible in the same table.

### 3.4 G4 — a schema failure that is not truncation

**Denominator: JSON calls, 90 per run — three schema-bearing features × 30 seeds.**

| run | ceiling | conformance | failures | truncation-caused | other |
|---|---|---|---|---|---|
| `gen-v1` | 1,024 | 83.3% | 15 of 90 | 14 | **1** malformed |
| `gen-v2` | 2,048 | 94.4% | 5 of 90 | 1 | **4** — 2 malformed, 2 element-shape |

*Trigger:* the model emits valid-looking output whose structure is wrong — a malformed envelope,
or array elements with the wrong keys.
*Blast radius:* one feature response fails to render.
*Note:* at the lower ceiling **93.3% of all schema failures were truncation**, so the non-truncation
modes are a thin residue that only becomes visible once the ceiling stops dominating.
*A named defect that never fired:* the markdown code-fence wrapper. The repair at
`llm.service.js:59-60` exists for a failure that occurred **0 times in 90 JSON calls**. It is
retained rather than removed — deleting an inert defect nobody has counted is a change no number
asked for — but it should not be described as a mitigation for anything observed.

### 3.5 G5 — the provider refuses on a rate limit

**46 of 1,779 attempted calls (2.6%) across all six committed ledgers. Denominator: attempted
calls.** Counted by reading the tracked ledgers; no call was issued.

| ledger | attempted | refused | published delivery |
|---|---|---|---|
| `gen-baseline` | 235 | 1 | 99.6% |
| `gen-v2` | 188 | **37** | 80.3% |
| `gen-v5` | 33 | 3 | 90.9% |
| `gen-v7` | 30 | 0 | — |
| `gen-judge` | 646 | 2 | 99.7% |
| `gen-judge-v7` | 647 | 3 | — |
| **total** | **1,779** | **46** | **97.4%** |

*Trigger:* **tokens per day**, not requests per minute. The daily cap is 200,000 per
*organisation* — a new API key inherits the old key's spend — and no `x-ratelimit-*` header
exposes it. It is visible only in the 429 body:
`Limit 200000, Used 197981, Requested 2824. Please try again in 5m47.76s.`
*The rate is not a property of the API.* 2.6% is a property of how much quota remained when each
run happened; the spread from 0.0% to 19.7% across runs is the evidence for that. It should be
read as "how often a measurement campaign was interrupted", not as provider reliability.
*Evidence limitation, stated because the ledger is the source:* only **10** of the 46 rows are
confirmable as tokens-per-day from the ledger itself. The other 36 — 35 of them in `gen-v2` —
carry only the application's friendly error sentence, because the provider's response body was
discarded before it was reached. Later runs record `providerMessage` and `retryAfterMs`.
*Blast radius:* **for a measurement run, a pause rather than a loss** — the per-call ledger is
resumable, and five stopped runs across the project resumed with nothing lost. **For a user, one
failed feature request.**
*Mitigation:* the resumable ledger, and serial pacing against the per-minute reservation. Retry
with backoff was considered and **refused for the eval path on a measurement reason**: a retried
call's latency is not the shipped call's latency.
*Detection:* HTTP 429 with `status`, `providerMessage` and `retryAfterMs` on the ledger row.

### 3.6 G6 — an item is not supported by the note it cites

**Denominator: items, 322.** Graded by a second model — `qwen/qwen3.6-27b` judging
`openai/gpt-oss-120b` — against a rubric committed before the run, over 644 pairs (each item
judged twice: against the note it cited, and against a note from the same prompt it did not).

| rubric level | against the cited note | against a distractor | gap |
|---|---|---|---|
| 2 — SUPPORTED | **5.0%** (16 of 322) | **0.0%** (0 of 322) | +5.0pp |
| 1 — PARTIAL | 10.2% (33) | 0.9% (3) | +9.3pp |
| 0 — UNSUPPORTED | 84.8% (273) | 99.1% (319) | −14.3pp |

> ### The 5.0% must never be quoted as a hallucination rate, and here is the mechanism
>
> **The instrument built to validate it cannot speak about it.** Sixty items were also labelled
> by a human, blind, from the same rubric. The human **never used the top level — not once in 60
> items.** So the binary collapse the headline makes has a degenerate marginal, chance agreement
> equals observed agreement, and Cohen's kappa is **exactly 0.000 at P₀ 94.0%**. That is not a bug
> or a rounding artifact; it is what kappa is defined to return when one rater's answer carries no
> information to disagree about.
>
> **What the labels do support:** two blind raters independently found that items are rarely fully
> supported by the note they cite, agreeing on the three-level scale at **P₀ 64.0%, κ 0.246** —
> "fair" and no better. The disagreement is structured rather than noisy, with the judge
> consistently harsher: of 21 items the human called PARTIAL the judge called 13 UNSUPPORTED,
> while of 29 called UNSUPPORTED they agreed on 27.
>
> **The null runs the other way and is the strongest single result here.** SUPPORTED was awarded
> 16 times against a cited note and **0 times against 322 distractors** — perfect specificity, not
> one false positive. A judge scoring 5.0% could be lazy or mis-calibrated; a judge scoring 5.0%
> that never once awards it to a note the item did not cite is discriminating at a very strict
> threshold.
>
> **So this row measures a strict rubric meeting an abstractive generator, not a hallucination
> rate.** The prompt asks for items that *connect or contrast* two notes rather than restate one,
> and a top level requiring every assertion to appear in the passage almost never fires against a
> writer doing that. Reporting it as "5% of flashcards are grounded" would be a serious misreading.
> **Never quote a groundedness score without its judge–human agreement beside it, and never quote
> kappa without P₀ beside it.** This run is the extreme case of why.

*Corroborating lexical proxy, same 322 items:* a claim shares **0.283** of its terms with the note
it cites against **0.119** with the notes in the same prompt it did not — a gap of 0.163, roughly
2.3×. The cited note is the best lexical match on 77.3% of items. On the 22.7% where it is not,
the judge's rate(2) is 2.1% against 6.2% elsewhere, so the two instruments partly agree and that
pile does contain real mis-attribution.
*Blast radius:* a plausible-looking flashcard attributed to a note that does not fully support it.
Bounded by the citation being **valid** — see G7 — so a user can always check.
*Detection:* `npm run eval:judge`, pure. It withholds every rate until all 60 hand labels exist.

### 3.7 G7 — a citation points at a note that was not in the context

**0 of 322 items — 0.0%. Denominator: items. A mode that was measured and did not occur.**

*Trigger:* the model emits a source label that does not resolve to any note in the prompt.
*Result:* 322 of 322 valid. Out-of-range 0, missing 0.
*This is the weakest of the four programmatic metrics and the reason is a design choice.* Source
labels are small integers rather than 24-character database ids — about 1 token each instead of
~10, and a model copies a small integer reliably. So this mostly measures **out-of-range labels,
not fabricated identifiers**, and 100% is close to what the design predicts. The interesting
failure — a valid label on a claim the note does not support — is invisible here by construction
and is G6's.
*Related figure with a different denominator:* a pack cites 5.93 of the 8.70 notes in its context,
**67.0% coverage** — and that number is over all 30 calls including the 7 that truncated and cited
nothing.

### 3.8 G8 — the shipped model string stops existing

**1 occurrence, 19 Aug 2026. Denominator: occurrences — this is a count, not a rate.**

*Trigger:* the provider retires a model id. Nothing in this repository changed.
*Blast radius:* **total, and it is the highest-consequence entry in this document.** All five AI
features returned HTTP 500 to every user for an unknown number of days. `llama-3.3-70b-versatile`
returned 404 `model_not_found`, was absent from the 13 models the key could reach, and the key
authenticated fine throughout.
*Why nothing caught it:* no test, no checker and no CI step read the model string, and **`npm test`
passed green with the feature entirely dead**. Frozen evidence:
[`results/gen-model-retired.txt`](../results/gen-model-retired.txt), which must not be
regenerated — the probe now succeeds, so re-running it would overwrite the record of the defect.
*Mitigation and its limit:* two checks now read the live model string — `npm run gen:probe`, which
exits non-zero when it stops resolving, and a test behind an API-key precondition. Both cost **no
quota**, because listing models consumes no completion tokens. **Neither runs in CI**, which sets
no key deliberately, so a future retirement is caught the next time somebody exports a key rather
than the day it happens.
*The failure mode neither check can see:* a model **silently swapped behind a name that still
resolves**. A retired id is loud; drift is not. The partial answer is carrying untouched features
as controls in every generation experiment — if a feature nobody changed moves, something else did.

### 3.9 G9 — the context-token estimator underestimates

**27 of 60 cluster prompts (45.0%) across two arms. Denominator: cluster prompts, 30 per arm.**

| arm | underestimates | worst slack |
|---|---|---|
| gen-v5 (`v4-bm25`) | 14 of 30 — 46.7% | −63 tokens (−3.53%) |
| gen-v7 (`v5-embeddings`) | 13 of 30 — 43.3% | **−97 tokens** |

*Trigger:* the input budget is estimated with a measured character-per-token bound rather than a
tokenizer, deliberately — no new dependency. The bound was fitted on single-note calls and does not
hold on cluster prompts roughly ten times longer.
*Blast radius:* small and bounded — the worst observed overshoot is 3.5% of the input budget, and
the budget is well clear of the model's context window.
*Why it is here anyway:* **a budget's guarantee is set by its worst call, and the worst case got
54% worse under a second retriever.** The −63 was not the tail; it was the tail *of one
retriever's neighbour lengths*. The rate converged across three readings and the bound did not.
*Not fixed:* changing the divisor is a one-variable product change and was out of scope.
*A test cannot currently fail on it,* because the test checks the single-note rows the constant was
fitted on.
*Detection:* every response reports the estimate beside the API's actual figure, so the
extrapolation is measured on every call.

### 3.10 G10 — the latency tail on a generation call

**p50 4,870 ms, p95 25,223 ms, slowest 29,702 ms over 30 calls. Denominator: calls.**

*Trigger:* provider-side queueing. 18 of 30 calls land within 25% of the linear
output-length prediction; the rest run long, and the spread does not track output length.
*Blast radius:* a user waiting up to ~30 seconds for a study pack, with no streaming.

> **This figure is UNCONTROLLED and will remain so permanently.** One home connection, one
> afternoon, macOS on an M2 laptop. Several earlier sections of this project's internal record
> deferred a controlled latency measurement to a phase that has since been cut, so **this project
> will never publish a controlled latency figure** — "uncontrolled" is a final state here, not a
> placeholder. Quote it with the environment or not at all.

---

## 4. Summary

| # | mode | frequency | denominator |
|---|---|---|---|
| R1 | no rung reaches the key | 732 — 31.8% | dev queries, 2,304 |
| R2 | sibling rung reached it, winner did not | 247 — 10.7% | dev queries |
| R3 | near-miss at rank 9–10 | 60 — 2.6% | dev queries |
| R4 | zero candidates above threshold | **0** for the winner; 11 at `v1` thr 0.15 | dev queries |
| R5 | one-keyword note links at strength 1.0000 | 1 | dev queries |
| G1 | study pack truncates at the ceiling | 7 of 30 per arm — 23.3% | calls |
| G2 | single-note truncation (`examQs`) | 14 of 30 → 1 of 30 | calls per feature |
| G3 | prose truncation, no schema to catch it | 2 of 30 → 0 of 30 | calls |
| G4 | schema failure that is not truncation | 1 of 90 → 4 of 90 | JSON calls |
| G5 | provider rate-limit refusal | 46 of 1,779 — 2.6% | attempted calls |
| G6 | item not supported by the note it cites | 273 UNSUPPORTED of 322 | items |
| G7 | citation to a note not in context | **0 of 322 — 0.0%** | items |
| G8 | shipped model string retired | 1 | occurrences |
| G9 | context estimator underestimates | 27 of 60 — 45.0% | cluster prompts |
| G10 | generation latency tail | p95 25,223 ms | calls |

---

## 5. Observed but never counted

**These are real and they have no frequency.** They are kept out of §2–§4 because a catalog whose
rule is *no entry without a number* stops meaning anything the moment one entry is exempted.

**Dilution by quoted or pasted material.** A query whose actual question is one sentence buried in
a long pasted recipe. The dense retriever's mean-pooled embedding drifts to the quotation while
the lexical rungs still match the title. Seen in **2 of 20 hand-read cases** — dev queries 29209
(276 tokens, most of it an ingredient list) and 78021 (a one-line egg-sizing question wrapped in a
Victorian almond-icing recipe). Two of twenty is not a rate and no computed frequency exists.

> **This replaces an expected entry that measurement contradicted.** The plan anticipated
> *"keyword extraction degenerates on very short or code-heavy notes"*. Read by hand, the
> near-empty queries did **not** fail — 84278 (*"Here's a picture of the knife set"*) and 125643
> (42 tokens) both got sensible results, carried by their titles and tags. **The queries that
> failed for a text reason failed for having too much text.** The short-note mode is not in this
> document because nothing supports it, and the mode that replaces it points the opposite way.

**Silent background link failure.** On save, two jobs fire un-awaited — version capture and link
computation — and their failures reach `console.error` (`backend/routes/notes.js`,
`backend/services/version.service.js`). A user whose links silently failed to compute sees an
empty panel, which is indistinguishable from having no related notes. **Still no frequency, and
it stays in this section.**

> **↳ IT HAS NOW BEEN OBSERVED FIRING (23 Aug 2026), AND THAT CHANGES ITS STATUS BUT NOT ITS
> SECTION.** Phase 6.3 gives each job a detached, linked span, so a failed job is a red span
> carrying its exception and a reference back to the save that caused it, instead of a line of
> stdout — `results/tracing-background-failure.txt`, and the screenshot in
> `docs/OBSERVABILITY.md`. Two sentences this entry used to carry are now false: it *has* been
> observed firing, and instrumentation that could produce a number *does* exist.
>
> **What has not changed is the only thing that would move it into a table: there is still no
> number.** Observing a mode once, on a failure induced on purpose in a throwaway database, is an
> existence proof and not a rate. Counting it needs the system run at scale with tracing on, and
> that has not happened. §1.2's third category — observed, real, uncounted — is exactly where it
> belongs, and 6.3 making it *countable* is not the same as counting it.

> **↳ THE BLOCKER MOVED ON 26 Aug 2026, AND IT DID NOT GO AWAY.** It used to be *"there is no
> deployment"*, and it is now **no collector and no traffic** — two separate obstacles that a
> deployment does not remove. **The entry stays here and every number in this document is
> unchanged, because none was ever attached to it.**
>
> *No collector.* `backend/observability/sdk.js` exports OTLP to
> `http://localhost:4318/v1/traces` unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` names something
> else, and the deployed host has nothing on that port. The four SDK packages are also
> `devDependencies`, so a production install that omits them turns the flag into one printed
> warning rather than a trace — by design, and it means switching tracing on in production is a
> configuration task with a reachable endpoint behind it, not a flag flip.
>
> *No traffic.* A frequency needs a denominator, and §1.1 is the rule this document is built on.
> Note saves by a handful of accounts would give a count over a population too small to divide by,
> which is the same mistake as §1.3's hand-read twenty. **Counting this mode is a phase with a
> price, not an afternoon:** a reachable OTLP endpoint, a sampling decision, a redaction pass
> — the default resource capture carries host and process identifiers, which is why
> `results/tracing-background-failure.png` needed `OTEL_NODE_RESOURCE_DETECTORS=env` before it
> could be committed — and then enough saves to divide by. **Priced here, not done here.**

**A different match set for users with more than 500 notes.** `routes/search.js:79` loads the user
corpus without excluding the query note, so semantic search over a corpus at the 500-note cap
returns a different set than the linker does. The trigger is countable — more than 500 notes — but
the frequency is **zero by construction**, because nothing is deployed and there are no users.

> **↳ THE APP WAS DEPLOYED ON 26 Aug 2026 AND THE SECOND HALF OF THAT REASON IS GONE.** There
> are users now. **The frequency is still zero and this entry does not move** — no account has
> reached the 500-note cap — but the zero has changed *class*, and that is the part worth
> recording. *By construction* meant the trigger could not fire because the population was empty.
> What holds today is only that the population is small. Nothing in the repository changed, and
> **nothing in the repository would notice the day it stops holding** — there is no check, no
> test and no alert on a per-account note count. A zero resting on a fact about today's data is a
> **circumstantial** zero, not a structural one, and §1.2's third category is where it now
> belongs: real, uncounted, and no longer guaranteed by anything.

**A third tokenizer, unmeasured.** `services/graphBuilder.service.js:10` carries its own `tokenise`
keeping words longer than 3 characters over a shorter stopword list, where the shared utility keeps
words longer than 2. It drives the graph view. **Nothing has ever measured it** — it appears in no
ladder rung and no eval run.

**Not a failure mode, recorded to prevent a wrong inference.** Cross-user isolation was tested
across 11 route surfaces, with a control re-issuing each request as the owner so that a 404 means
authorisation rather than a broken route. **No hole was found.** Three internal functions take a
note id with no user filter and are safe only because every caller checks ownership first; a test
pins them as unscoped so that scoping them is a deliberate change.

---

## 6. What the answer key contributes, and why it is not in the tables

**The single largest finding of the retrieval error analysis is not a failure of the system.**
Of twenty dev queries read by hand under a protocol fixed in advance, **13 were the answer key
rather than the retriever** — 12 unjudged hits where the retriever returned something at least as
relevant as the graded answer, and 1 where the graded judgment is not plausibly related at all.

**That is 13 of 20 cases in a deliberately balanced sample. It is not "63% of failures are the
key", it cannot be reweighted into a population rate, and it must not be used to discount the
7 that are real.** Both halves of that sentence are load-bearing.

Three properties of the key *are* computed over the full split, and they are limitations rather
than modes — the system is not doing anything wrong when they bite:

**Judgments are positive-only.** A recorded link means "related"; no link does not mean
"unrelated", only that nobody recorded one. **Every absolute retrieval number in this document is
therefore a lower bound.** The standard remedy for incomplete judgments does not apply here — with
zero judged non-relevant documents it collapses to recall — so the load-bearing claims are
*comparisons* between rungs facing the identical incomplete key.

**Half the key is a weaker relation than the other half.** A grade-1 judgment records that an
answer or comment *referenced* another question; a grade-2 judgment is a duplicate closure, a
claim that two questions are the same thing.

| key composition | queries | zero rate | mean nDCG@8 |
|---|---|---|---|
| grade 1 only (linked) | 1,766 | **49.4%** | 0.297554 |
| any grade 2 (duplicate) | 538 | **31.0%** | 0.423199 |

An 18.4-point gap, and a mean gap of 0.126 — **larger than the entire step between the two best
rungs on the ladder.** Every headline figure averages the two populations.

**Some judgments point at catch-all references no content-based retriever should return.** One
degree-103 document is *"Translating cooking terms between US / UK / AU / CA / NZ"*.

| key contains a top-1% hub | queries | zero rate | mean nDCG@8 |
|---|---|---|---|
| yes | 396 | **61.4%** | 0.169033 |
| no | 1,908 | **41.7%** | 0.359657 |

The mean maximum judged degree is 26.6 for failing queries against 8.4 for scoring ones while the
**medians are identical at 3** — a heavy tail rather than a shift. Most failing queries are not
hub-judged; the ones that are are being asked to return a glossary.

**Neither table is controlled.** Grade composition, hub degree and document age move together, so
these rows describe and do not attribute.

---

## 7. What this catalog cannot say

- **No noise floor exists under any generation figure.** One draw per seed at temperature 0.4, no
  repeats. A re-draw was measured to flip 32.1% of verdicts on one single-note feature, and
  **nothing establishes the equivalent for a study pack.** So no generation figure here may be
  compared against a later one as though the difference were real. Buying the floor was priced at
  ~456,000 tokens and declined; the decision is recorded rather than the caveat being dropped.
- **The groundedness rate has no human validation.** §3.6 in full. The binary kappa is exactly
  0.000 with a degenerate marginal.
- **The retrieval axis is sparse and nearly binary.** The key has a median of one judged document
  per query, so a per-query score largely answers *"was the one linked question found"* rather than
  *"how good were these eight results"*.
- **The generation seeds are not app-shaped.** Neighbours are retrieved over 27,325 Stack Exchange
  documents rather than a user's own ≤500 notes, and the seeds are Stack Exchange questions shaped
  as notes.
- **Retrieval figures are dev-split only.** The held-out test split was deliberately not opened for
  error analysis; the analysis script refuses it in code, because learning where the system fails
  from the test split makes it a design input.
- **Frequencies are conditional on a configuration.** R4 is the clearest case — the same retriever
  gives 0, 11 or 461 at three adjacent thresholds. A frequency here is a property of a named run,
  not a constant of the system.
- **One mitigation is verified by construction rather than by observation.** No live call has been
  made at the raised study-pack ceiling; the change is covered by pure tests asserting the constant
  and by a ledger guard that refuses to mix ceilings. *"It should work"* and *"I watched it work"*
  are different claims, and G8 is the record of what that distinction costs.

---

## 8. Provenance

**Every source named here is a committed file.** This document cites artifacts only — not the
project's planning documents, which are deliberately unpublished, and a reference a reader cannot
follow is worse than no reference. The path checker resolves paths against the working tree and
cannot tell a gitignored file from a live one, so that rule is held by hand.

| source | what it carries |
|---|---|
| [`results/error-analysis.dev.txt`](../results/error-analysis.dev.txt) | the computed retrieval report — R1–R3, §6's tables |
| [`results/error-analysis.md`](../results/error-analysis.md) | the retrieval narrative and the selection protocol |
| [`results/error-analysis-cases.csv`](../results/error-analysis-cases.csv) | the twenty hand-read cases, one disputable row each |
| `results/runs/*.run.json` | per-run sidecars — R4's zero-result counts |
| `results/gen-*.calls.jsonl` | per-call generation and judge ledgers — G1–G7, G9, G10 |
| [`results/gen-model-retired.txt`](../results/gen-model-retired.txt) | G8, frozen; must not be regenerated |
| [`results/studypack-constants.txt`](../results/studypack-constants.txt) | the context-budget constants behind G9 |

Regenerate the computed halves — all four are pure, need no API key and issue no call:

```bash
cd backend && npm run eval:gen      # G1-G4, G7, G10
cd backend && npm run eval:judge    # G6 and its kappa
cd backend && npm run eval:v7       # G1 and G9 across both retriever arms
cd backend && npm run analyse:errors  # R1-R3 (needs the gitignored corpus)
```

**A note on which numbers are guarded.** This file is scanned by `npm run check:claims`, which
verifies that every decimal of four or more places traces to a committed artifact. That scoping is
deliberate and it means **most of the figures here — the percentages and the integer counts — are
out of its scope and are not machine-checked.** The guard against those going stale is re-reading
the artifact after any re-run, which is a habit rather than a mechanism, and this project's own
record contains several occasions when the habit failed.

**Last assembled 23 Aug 2026.** Environment for every measured figure quoted: MacBook Pro
(Mac14,7), Apple M2, arm64, 8 GB, macOS 26.6, Node v25.8.1.
