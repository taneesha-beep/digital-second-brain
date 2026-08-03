# `mini-corpus.jsonl`

34 hand-written cooking documents. Committed, unlike everything under `data/`,
because the v1 parity proof has to run on a clean clone and in CI.

```
cd backend && npm run parity:v1
cd backend && npm test
```

## Shape

```json
{"id":"001","title":"Why won't my sourdough rise?","body":"My sourdough starter looks active…"}
```

Three fields, matching the fields v1 consumes from `data/corpus/cooking.jsonl`.
The real corpus records also carry `tags`, `score` and `creationDate`; those are
**omitted rather than invented**, because a hand-written fixture cannot have a
real score or a real creation date and a plausible-looking fake one is the kind
of thing that later gets quoted.

`id` is a string, matching the corpus build's decision (`docs/EVALUATION.md` §2)
to give document ids exactly one representation so a qrels join cannot fail on
`1 !== "1"`.

## What each part of it is for

A fixture that only proves the happy path proves very little. Each group exists
to reach a specific branch, and `tests/retrieval.v1-parity.test.js` asserts the
fixture still reaches them — so shrinking it later fails loudly instead of
quietly reducing what parity covers.

| ids | what it exercises |
|---|---|
| `001`–`011` | bread and dough. Overlapping topic, but distinct vocabulary, so leave-one-out IDF pushes each keyword list toward its own idiosyncratic terms. Produces the *sparse* linking that is v1's normal behaviour. |
| `012`–`016` | knives. A second cluster, so document frequency is not dominated by one topic. |
| `017`–`020` | oven temperatures. Contains the numeric tokens `350`, `180`, `220`, `250`, `200`. **Load-bearing:** digits tokenise to integer-like object keys, which JavaScript enumerates *before* string keys, and `extractKeywords` reads its ranking out of a plain object with a stable sort — so those keys change how ties between equal-scoring terms are broken. Without a numeric token in the fixture, that behaviour is untested. |
| `021`–`024` | very short questions. Their keyword lists come out at 5 and 6 terms, which is where `strength > 0.15` stops meaning "share two words in ten" and starts meaning "share one word". |
| `025`–`034` | near-duplicate brining questions, deliberately sharing most of their vocabulary. This is the group that makes `slice(0, 8)` bind: eleven documents come back with exactly 8 links, the ninth candidate is dropped, and the tie sits *at* the cap boundary — which is what turns "shipped v1's output depends on database return order" from an argument into a demonstration. |

## Size, and what it deliberately does not cover

34 documents: enough for the cap to bind and for document frequency to be
non-degenerate, small enough that the shipped extractor's O(N²) rebuild of the
document-frequency table finishes instantly and a human can read the whole file.

It is **under 500 on purpose**, so `loadUserCorpus`'s unsorted `limit(500)` is
never reached and the parity run cannot be read as covering it. That case is
demonstrated separately, on 521 generated documents, in `scripts/parity-v1.js`
(demonstration C) — generated rather than committed, because 521 documents of
filler prose earn nothing by being in the repository.
