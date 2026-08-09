# Per-query error analysis — `v5-embeddings` on `cooking.dev`

**Phase 3.7.** Produced 9 Aug 2026. Regenerate the computed half with:

```bash
cd backend && npm run analyse:errors
```

| | |
|---|---|
| retriever | `v5-embeddings`, the winner of the ladder — nDCG@8 **0.326893** on dev |
| split | **dev**, 2,304 judgeable queries. `data/splits/cooking.dev.txt`, sha256 `38ff8bae…` |
| run file | `results/runs/v5-embeddings.dev.run`, sha256 `89227f28f7cd61faae77f80df9f95bf088a2f6513664a21f5dbc1db24a0fbf97` |
| computed report | [`error-analysis.dev.txt`](error-analysis.dev.txt) — every count below comes from it |
| casebook | [`error-analysis-casebook.dev.txt`](error-analysis-casebook.dev.txt) — the exact text that was read |
| assignments | [`error-analysis-cases.csv`](error-analysis-cases.csv) — one row per qid, disagree with a row |

**Test was not opened, not read, and not run.** `analyse-errors.js` refuses `--split test`
in code. The test run files exist on disk and reading them would not trip
`results/runs/test-openings.json`, which governs *producing* a run — that is the reason for
the refusal rather than an argument against it. This analysis feeds Phase 7, Phase 7 feeds
mitigations, and EVALUATION.md §19.9 says any future change to a retriever is measured on
dev. Learning where the winner fails *from test* would make test a design input without ever
tripping the ledger, which is the quiet version of the failure the ledger exists to stop.

---

## 1. "The 20 worst queries" is not a selection rule

Roadmap 3.7 says *"take the 20 worst queries under the winning retriever."* Two of those
words do not survive contact with this answer key.

**There is no worst 20. There is a tie of 1,039.** The key has a median of one judgment per
query (§3.3, §19.3), so a query scores exactly 0.0 at nDCG@8 whenever its single judged
document misses the top 8. That is **45.1% of the dev split**:

| `v5-embeddings` nDCG@8 | queries | share |
|---|---|---|
| **exactly 0** | **1,039** | **45.1%** |
| 0 < x ≤ 0.1 | 15 | 0.7% |
| 0.1 < x ≤ 0.25 | 117 | 5.1% |
| 0.25 < x ≤ 0.5 | 466 | 20.2% |
| 0.5 < x < 1 | 365 | 15.8% |
| exactly 1 | 302 | 13.1% |

**And the tie is not neutral.** §5.3 measured that a document's judged degree tracks how much
corpus was created after it, ρ = +0.181, with a 2010 question roughly 4.5× more judged than a
2024 one. Ordering by raw nDCG@8 therefore preferentially surfaces recent, thinly-judged
queries where the retriever may have done nothing wrong. §5.3 says so in terms: any per-query
error analysis *"must check the age of a failing query before concluding the retriever failed
on it."*

### The rule, written before any query was looked at

**Population** — dev queries with nDCG@8 exactly 0. Every dev query is judgeable (§19.1
records 0 unjudgeable), so this means one thing only: v5 placed no judged document in its
top 8.

**Two axes, both computable.**

- **Reachable** — did *any* of the six rungs place a judged document for this query in its
  top 10? A lower bound: the run files stop at rank 10.
- **Key size** — exactly 1 judgment, or 2 and above.

**Five from each of the four cells.** Within a cell, qids sorted numerically and five taken
evenly spaced across the range. All four cells held more than five, so the pre-declared
short-cell fallback never fired.

| cell | population | picked |
|---|---|---|
| reachable / key 1 | 193 | 5 |
| reachable / key 2+ | 114 | 5 |
| unreachable / key 1 | 582 | 5 |
| unreachable / key 2+ | 150 | 5 |
| **total** | **1,039** | **20** |

**The even spacing is deliberate and it costs something.** Corpus ids ascend with creation
date, so spacing across the qid range spreads the sample across corpus age rather than
letting §5.3 choose it. The price is that **the 20's own age and key-size distribution is a
property of the sampling and is not evidence of anything.** The age finding in §5 below comes
from all 2,304 queries.

### What was rejected

| rejected | why |
|---|---|
| raw nDCG@8 ascending, take 20 | undefined — an arbitrary draw from a tie of 1,039, and §5.3-loaded |
| ascending, tie-broken by key size descending | fills all 20 with the largest keys and hides the modal failure; 62.6% of dev has a key of one |
| uniform random from the zero population | no §5.3 protection; about two in three would be key-1, so one cell is learned and three are not |
| worst 20 by residual against the best sibling rung | isolates v5-specific failure well, and by construction selects **only** reachable queries — excluding the bucket that turned out to be 70.5% of the population. Folded in as axis 1 instead |
| a composite severity index weighting a zero-with-twelve above a zero-with-one | composite indices hide their weights; explicit strata say the same thing and can be argued with |

**Partial failures are out of population by choice.** A query scoring 0.15 with twelve
judgments is a real thing to look at, but with a median key of one, nDCG@8 > 0 usually means
the judged document *was* found and the residual is a **ranking** question rather than a
**retrieval** one. §7 of the computed report gives rank-of-first-hit over the whole split so
the exclusion is visible rather than silent.

---

## 2. The computable taxonomy — [MEASURED] over all 2,304 queries

These four partition the zero population. They are computed from run files and no reading is
involved.

| cat | meaning | queries | of zero pop | **of split** |
|---|---|---|---|---|
| **C0** | zero-result — the retriever returned nothing | 0 | 0.0% | 0.0% |
| **C1** | near-miss — a judged document at rank 9 or 10 | 60 | 5.8% | 2.6% |
| **C2** | sibling-reachable — another rung found one, v5 did not | 247 | 23.8% | **10.7%** |
| **C3** | unreachable — no rung of the six reached the key at all | 732 | 70.5% | **31.8%** |
| | **total** | **1,039** | 100.0% | **45.1%** |

**The "of split" column is the one Phase 7.1 can use.** It is a rate over a named eval run
with a SHA-256, which is what *"observed frequency from a named eval run"* means. The
hand-read categories in §3 are not rates and §7 says why they cannot be turned into any.

**Which rung reaches a key v5 misses**, over the 247 C2 queries. Rows overlap, so they do not
sum:

| rung | reached | share of C2 |
|---|---|---|
| `v1-overlap` | 69 | 27.9% |
| `v2-jaccard` | 68 | 27.5% |
| `v3-tfidf` | 127 | 51.4% |
| `v4-bm25` | 149 | 60.3% |
| `v6-hybrid` | 142 | 57.5% |

BM25 alone rescues 149 keys the winner misses. That is a **complementarity** measurement, and
§18.7 already established that complementarity is necessary and nowhere near sufficient for
fusion to pay — v6 loses to v5 by 0.015532 on dev despite this. The two facts sit together
without contradiction and neither licenses reopening the fusion question, which 3.6 closed.

---

## 3. The hand-read taxonomy — [READ], n = 1, and kept separate

Six categories, fixed before reading. No seventh was added afterwards; adding a bucket once
the cases are in front of you is how a taxonomy stops being falsifiable.

| | category | meaning |
|---|---|---|
| **H1** | unjudged hit | the results are correct and the key does not know |
| **H2** | granularity miss | right topic, wrong specificity or wrong axis |
| **H3** | wrong sense | surface match, different intent |
| **H4** | uninformative query | too little signal in the query for any retriever |
| **H5** | genuine miss | the judged document is plainly right, findable, and v5 did not return it |
| **H6** | questionable judgment | the judged document is not plausibly related to the query |

### The protocol, and the order is the point

For each case: read the query, then **the judged documents themselves**, then v5's top 5 —
in that order.

1. **Judged document first, before seeing v5's output.** Is it plausibly related to the query
   at all? If no → **H6**, stop. Reading the retriever's output first is how a reader talks
   themselves into "the key does not know."
2. Reachability is already computed and on the row.
3. **Then v5's top 5.** **H1 requires the stronger claim:** naming a specific retrieved
   document and arguing it is *at least as relevant as the graded judgment*. Merely
   topically related is **H2**, not H1.

That asymmetry is the pre-committed guard against using incompleteness to excuse everything.
H1 costs something to say; H2 is what you get when you cannot pay it.

**H1 and H6 are different claims and are not interchangeable.** H1 says the key is
**incomplete** — §5.1's problem. H6 says the key is **wrong** for this pair. Only one case
was scored H6.

### Counts

| category | count | of 20 |
|---|---|---|
| **H1** unjudged hit | **12** | 60% |
| **H5** genuine miss | **5** | 25% |
| **H2** granularity miss | 2 | 10% |
| **H6** questionable judgment | 1 | 5% |
| H3 wrong sense | 0 | — |
| H4 uninformative query | 0 | — |

18 of 20 were scored `clear`, 2 `borderline` with the runner-up recorded (84278 and 93293).

### By cell — and this is the finding that broke the prediction

| cell | H1 | H2 | H5 | H6 | key's fault | retriever's fault |
|---|---|---|---|---|---|---|
| reachable / key 1 | 3 | 0 | 2 | 0 | 3 | 2 |
| reachable / key 2+ | 3 | 1 | 1 | 0 | 3 | 2 |
| unreachable / key 1 | 4 | 0 | 1 | 0 | 4 | 1 |
| unreachable / key 2+ | 2 | 1 | 1 | 1 | 3 | 2 |
| **reachable (C1∪C2)** | **6** | 1 | 3 | 0 | **6** | 4 |
| **unreachable (C3)** | **6** | 1 | 2 | 1 | **7** | 3 |

**Reachability barely moves fault.** I predicted that when a sibling rung finds the judged
document, v5 has genuinely erred — H1 at most 3 of those 10. It was 6 of 10. A key can be
simultaneously findable-by-a-lexical-rung *and* less relevant than what v5 returned; the two
properties are independent, and the prediction quietly assumed they were the same thing.

---

## 4. How many failures are the key rather than the retriever

**Stated plainly: 13 of the 20 hand-read cases are the answer key, and 7 are the retriever.**

- **The key — 13.** H1 (12) + H6 (1). In twelve of them v5 returned a document I judge at
  least as relevant as the graded one, and in one the graded documents are not about the
  query at all.
- **The retriever — 7.** H5 (5) + H2 (2). In five, a plainly correct and findable document
  was missed; in two, v5 held the right topic at the wrong specificity.

**Three things that sentence is not.**

**It is not a rate.** The 20 are a stratified sample with five per cell, drawn from a
population whose cells are 193 / 114 / 582 / 150. Reweighting 13-of-20 to the population is
arithmetically possible and would be the most quotable and least defensible number in this
document — at n = 5 per cell the variance of any projected share is enormous. **No projected
percentage appears here, and Phase 7.1 should take §2, not §3.**

**It is not an excuse.** Five genuine misses out of twenty is not a rounding error, and three
of them have a diagnosable mechanism named in §6. A taxonomy whose largest bucket is "the
result is good and the key does not know" is a finding about the **ground truth**, and it is
reported as one — it is not evidence that v5 is better than 0.326893, because nothing here
measures whether an unjudged retrieved document is *actually* relevant. That is §5.1's open
problem and its only fix is pooling and hand-labelling (§5.4 option 2), which is not done.

**It is n = 1 judging.** There is no inter-rater reliability figure and I am not going to
manufacture one: a self-agreement number produced in one sitting, having already seen my own
labels, measures nothing. What is available instead is that every assignment is committed as
a CSV row with its category, its confidence, its runner-up, and the specific document the
claim rests on. A second reader disputes row 7, not "the analysis."

**This is the fourth time §5.1's incompleteness has been observed directly and the first time
it has been counted.** 2.7 watched nine retrieved documents move without moving any metric;
§17.6 read ten queries and found topically perfect top-5s uncredited; §19.2's registered
comparison came back per-query identical. Each of those said *it happens*. This one says
*here are twenty cases and here is how they split* — still not a rate, but no longer an
anecdote either.

---

## 5. Age — §5.3's check, against the baseline it demands

§5.3 requires a failing query's corpus age to be checked before the retriever is blamed.
The decile below is §5.3's own axis, recomputed: **D1 is the newest tenth of the corpus, D10
the oldest.**

| decile | split queries | zero pop | **zero rate** |
|---|---|---|---|
| D1 (newest) | 179 | 99 | **55.3%** |
| D2 | 149 | 74 | 49.7% |
| D3 | 177 | 80 | 45.2% |
| D4 | 191 | 76 | 39.8% |
| D5 | 212 | 89 | 42.0% |
| D6 | 255 | 127 | 49.8% |
| D7 | 251 | 125 | 49.8% |
| D8 | 259 | 115 | 44.4% |
| D9 | 276 | 119 | 43.1% |
| D10 (oldest) | 355 | 135 | **38.0%** |

mean decile — **zero population 5.981, scoring population 6.333** (higher is older)
mean key size — zero **1.411**, scoring **2.328**

**§5.3's prediction holds, and it is weaker than the warning implies.** The failing population
*is* the younger one and the newest decile fails at 55.3% against the oldest decile's 38.0% —
but the curve is not monotone (D5 through D7 sit above D4) and the mean decile gap is 0.35 of
a decile. **Age is a real contributor and it is not the main story.** The much larger gap in
the same table is key size: failing queries carry 1.411 judgments on average against 2.328
for scoring ones.

That reframes §5.3's warning usefully rather than refuting it. The warning was that ranking
queries by score would over-select recent ones. It would — and the mechanism is mostly *key
thinness*, of which recency is one cause among several. The stratification defended against
the right thing by the right axis.

---

## 6. Two mechanisms the hand read found, then measured

Both started as an observation on one case and became a computed row. Each prediction was
written before its measurement ran; both are in `analyse-errors.js`.

### 6a. A grade-1 "linked" judgment is a citation, not a relevance judgment

Case **52209**, *"How do I pick the best fillet mignon at the supermarket?"*, is judged
against two documents about **salting** a steak. §2.1: `LinkTypeId 1` records that an answer
or comment *referenced* another question — a citation. `LinkTypeId 3`, grade 2, is a
duplicate closure, which *is* a claim that two questions are the same. If the distinction is
real, keys containing a grade 2 should fail markedly less often. **Predicted before running:
a gap of 10 to 20 points.**

| key composition | queries | zero pop | zero rate | mean nDCG@8 |
|---|---|---|---|---|
| grade 1 only (linked) | 1,766 | 872 | **49.4%** | 0.297554 |
| any grade 2 (duplicate) | 538 | 167 | **31.0%** | 0.423199 |

**18.4 points**, and the mean nDCG@8 gap is 0.126 — larger than the entire v4→v5 step. The
part of this key that encodes "same question" is substantially easier than the part that
encodes "an answer here linked there," and every headline in this project averages the two.

### 6b. §5.2's hubs land on the failures

784 (*"Translating cooking terms between US / UK / AU / CA / NZ"*, degree 103) appears as a
judgment in **two** of the twenty — for a crème brûlée question and a Victorian egg-sizing
question. 21068 (the degree-209 food-storage reference) appears in a third.

| key contains a top-1% hub | queries | zero pop | zero rate | mean nDCG@8 |
|---|---|---|---|---|
| yes | 396 | 243 | **61.4%** | 0.169033 |
| no | 1,908 | 796 | **41.7%** | 0.359657 |

mean max judged degree — zero **26.566**, scoring **8.406**; medians identical at **3**.

The identical medians against a 3.2× mean gap say this is a **heavy tail**, not a shift: most
failing queries are not hub-judged, and the ones that are, are judged against something no
content-based retriever should be expected to return for a specific question.

**Neither 6a nor 6b is controlled.** Grade composition, hub degree and corpus age are
correlated with each other, so these rows describe and do not attribute.

---

## 7. The twenty cases

Every row traces to a qid, and through `error-analysis-casebook.dev.txt` to the exact text
read. Full reasons are in `error-analysis-cases.csv`.

| qid | cell | cat | key | D | hand | conf | one line |
|---|---|---|---|---|---|---|---|
| 1027 | reach/1 | C2 | 1 | D10 | **H1** | clear | judged doc is about albumin on cooking salmon; v5 rank 3 is *"How can I barbecue salmon steak?"* |
| 29209 | reach/1 | C2 | 1 | D8 | **H5** | clear | the judged follow-up quotes this query's title verbatim; four lexical rungs matched on that, v5 did not |
| 57097 | reach/1 | C2 | 1 | D6 | **H1** | clear | the key names one of a family of near-identical raw-meat-utensil questions; v5 returned four others |
| 91237 | reach/1 | C2 | 1 | D3 | **H5** | clear | judged *"Jars didn't seal"*; v5 rank 1 is *"Can I reprocess jars that have SEALED?"* — condition inverted |
| 127937 | reach/1 | C2 | 1 | D1 | **H1** | clear | judged doc is about reshaping dough; v5 rank 1 is the query's actual question |
| 17 | reach/2+ | C2 | 2 | D10 | **H1** | clear | canonical chicken time/temp query with a large unjudged family |
| 16310 | reach/2+ | C2 | 2 | D9 | **H1** | clear | the query's own body names its target; the key points at two narrow sub-skills, v5 found the target's family |
| 42567 | reach/2+ | C2 | 3 | D7 | **H5** | clear | judged *"Safe to leave oven on at 180F while at work"* is the query restated; v1 and v2 found it |
| 84278 | reach/2+ | C2 | 2 | D4 | **H2** | *borderline* | query bundles three sub-questions; v5 stayed at knives-in-general where one judgment is dishwasher-specific |
| 124961 | reach/2+ | C2 | 2 | D1 | **H1** | clear | v5 rank 1 explains exactly why two nutrition sources disagree |
| 316 | unreach/1 | C3 | 1 | D10 | **H1** | clear | judged doc is about installing a gas stove; v5 ranks 1 and 3 are the query |
| 25663 | unreach/1 | C3 | 1 | D8 | **H1** | clear | judged doc is about **roasting**; v5 rank 2 is the smoked-chicken-skin question almost word for word |
| 56520 | unreach/1 | C3 | 1 | D6 | **H1** | clear | the judgment is a provenance link — the query quotes an answer living on it |
| 93293 | unreach/1 | C3 | 1 | D3 | **H1** | *borderline* | closed as a duplicate of the degree-209 catch-all; v5 returned specific documents on the actual question |
| 127891 | unreach/1 | C3 | 1 | D1 | **H5** | clear | the same question at grade 2, missed by every rung; the gap is the brand term *iSi canister* |
| 626 | unreach/2+ | C3 | 2 | D10 | **H1** | clear | v5 rank 1 is *"Crème brûlée without torch"*; one judgment is the degree-103 dialect glossary |
| 20121 | unreach/2+ | C3 | 3 | D9 | **H2** | clear | query asks about spoilage **contagion**; v5 returned spoilage-versus-temperature — right topic, wrong axis |
| 52209 | unreach/2+ | C3 | 2 | D6 | **H6** | clear | both judgments are about **salting** a steak for a question about **choosing** one |
| 78021 | unreach/2+ | C3 | 2 | D5 | **H5** | clear | the body is a long quoted Victorian recipe; all five results are almond cakes, the question was egg sizes |
| 125643 | unreach/2+ | C3 | 2 | D1 | **H1** | clear | v5 rank 4 is *"Did I ruin my wok?"* against a query *"Can this wok be saved?"* |

### The three genuine misses with a named mechanism

- **29209 and 78021 — long bodies drown a short question.** Both query documents are
  dominated by quoted material: a full cookie recipe, and a full Victorian almond-icing
  recipe. The lexical rungs still matched the title; v5's mean-pooled 256-token embedding
  drifted to the quotation and lost the one-sentence question. This is PRIMER §9.1's
  predicted *"keyword degeneration on very short or code-heavy notes"* appearing in its
  dense form — and in the opposite size regime to the one that phrase anticipates.
- **91237 — negation.** v5 ranked *"jars that have sealed"* first for a query about jars that
  **didn't**. A known dense-retrieval weakness, visible here on one case.
- **127891 — vocabulary.** The judged document says *iSi canister*; the query says *whip
  cream dispenser* and *charger*. No rung bridged it, which makes it the clearest case in the
  set that C3 is not a synonym for "the key is strange."

---

## 8. Predictions, written first, and how they scored

Four right, five wrong, one marginal. Recorded because 3.4's and 3.5's were wrong, 3.6's was
nine of ten, and writing them down has been worth more than being right.

| prediction | outcome |
|---|---|
| zero population 1,250–1,450 (54–63%) | **WRONG** — 1,039, 45.1%. I over-estimated how often a median-one key misses |
| largest computable bucket is C3 | **right** |
| C3 is 45–60% of the zero population | **WRONG** — 70.5%, well outside the band |
| C1 near-miss is 2–5% of the zero population | **marginal** — 5.8% |
| largest hand-read bucket is H1 | **right** — 12 of 20, at the top of the predicted 8–12 |
| H1 at most 3 of the 10 reachable cases | **WRONG, and the most useful one** — 6 of 10 |
| H5 genuine misses 4–7 of 20 | **right** — 5 |
| H6 questionable judgments 1–3 | **right** — 1, at the bottom edge |
| H4 uninformative queries 1–3 | **WRONG** — 0 |
| the zero population is age-shifted younger | **right**, and weaker than expected (§5) |

**The H1-within-reachable failure is the one worth carrying.** The reasoning was: if a
sibling rung found the judged document, the document is findable, so v5 genuinely erred. The
first clause is true and the second does not follow. *Findable* and *most relevant* are
independent properties, and on this key a lexical rung frequently finds a judged document
that is worse than what v5 returned instead.

**H4 = 0 is the other instructive miss.** I expected some queries to carry too little signal
to retrieve on, and specifically expected the image-dependent ones to be it — 84278
(*"Here's a picture of the knife set"*) and 125643 (*"It now looks like this?"*, 42 tokens).
Both got sensible, on-topic results anyway, because titles and tags carried the query.
**The queries that failed for a text reason failed for having too much text, not too little.**

---

## 9. What this analysis cannot establish

- **It is not a frequency for the hand-read categories.** §2 is a rate over 2,304 queries;
  §3 is 20 cases in four cells of five. Phase 7.1 takes §2. Any reweighting of §3 to the
  population is unsupported and none is offered.
- **It is n = 1 judging with no inter-rater reliability.** The mitigation is that every
  assignment is a disputable committed row, not that the judgments are independently
  validated. They are not.
- **It cannot tell an unjudged hit from a genuine miss in the general case** — only under the
  stated protocol, whose H1 threshold ("at least as relevant as the graded judgment") is a
  human judgment and not a measurement. Two of twenty were borderline under it and are
  labelled so.
- **It does not measure whether unjudged retrieved documents are relevant.** That is §5.1's
  problem, its fix is pooling and hand-labelling (§5.4 option 2), and it is not done. So this
  document cannot say v5 is *really* better than 0.326893, and does not.
- **Reachable is a lower bound.** Run files stop at rank 10; a judged document a rung would
  have found at rank 11 counts here as unreachable.
- **C3 is not "unfindable."** It says the six rungs on this ladder do not find it in ten
  slots.
- **§6a and §6b are uncontrolled.** Grade, hub degree and age are mutually correlated and
  nothing here separates them.
- **Dev only.** Nothing here is a test-set result, and nothing here was checked against test.
- **It is one retriever on one corpus.** §19.9's limits are untouched: 2,304 cooking
  questions whose queries are whole documents, one 384-dimension local model, one
  positive-only key.
