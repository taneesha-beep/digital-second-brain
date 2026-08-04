# v1-overlap parity evidence

Output, not an assertion. Both files are produced by

```
cd backend && npm run parity:v1 -- --write
```

and are **byte-identical**, including their header — nothing in either file
names which side produced it, so `cmp` and `sha256sum` are the entire
comparison.

```
83f9e35e834b7e1f5422a1ffbbf61de90feb25aa7895632ee75c1daab35ecc5e  v1-shipped.txt
83f9e35e834b7e1f5422a1ffbbf61de90feb25aa7895632ee75c1daab35ecc5e  v1-harness.txt
```

151 lines each: 34 `KW` lines (one keyword list per document) and 116 `LINK`
lines (a ranked result with its score to four places and its shared keywords in
the shipped target-order).

- **`v1-shipped.txt`** — the shipped composition. `backend/utils/keywords.js`,
  `backend/utils/corpus.js` and `backend/services/linker.service.js`, required
  unmodified and run exactly as `routes/notes.js:118-129` runs them, minus
  Express. No database: the `Note` model is substituted, so `mongoose` is never
  loaded (0 `node_modules` entries in `require.cache` after the harness loads).
- **`v1-harness.txt`** — `backend/retrieval/v1-overlap.js` through the 2.1
  interface, at its default params.

```json
{"version":"v1-overlap","params":{"idfCorpus":"leave-one-out","topN":10,
 "threshold":0.15,"cap":8,"scorePrecision":4,"lengthBonus":true},
 "docCount":34,"digest":"93bc8d65e472ba96c27b3aaff3504b623533076114d9b127e1282de902579e30"}
```

## What byte-identity does and does not claim

Shipped v1 is **not** a deterministic function of `(query, corpus)`. It is a
function of `(query, corpus, save history, database return order)`. So this is
byte-identity under a stated freeze of three inputs the shipped code leaves
unspecified, and `parity-v1.js` also shows that each freeze is load-bearing
rather than decorative:

| | frozen as | evidence that it matters |
|---|---|---|
| tie order at the threshold and cap cut | descending score, then lexicographic on the id | reversing the store's return order changes **87 of 151 lines**, and for documents `025`, `026` and `028` changes *which eight* documents come back, not merely their order |
| which ≤500 documents feed the IDF | the whole corpus, leave-one-out | on 521 generated documents, id-ascending order yields `…,bravo` and id-descending yields `…,alpha` for the same document |
| when each document's keywords were computed | all at index time, from one corpus state | — (structural; see `v1-overlap.js`) |

The tie-order freeze reproduces shipped output **exactly when the store returns
documents in id order**, which is what a one-line `.sort({_id: 1})` in
`utils/corpus.js` would make true. That is a Phase 4.1 change, not a Phase 2
one.

## Not covered here

`linker.service.js:40-64`, the bidirectional write, is not re-expressed — it is
last-writer-wins storage, and Phase 4.2's subject. The parity script measures it
anyway: the *stored* `linkedNotes` differ on **15 lines** between the two store
orders, with links present under one ordering and absent under the other.

These files are regenerated and compared by
`backend/tests/retrieval.v1-parity.test.js`, so drift fails the test suite
rather than being discovered when a number is quoted from them.

**Environment.** MacBook Pro (Mac14,7), Apple M2, arm64, 8 GB, macOS 26.6,
Node v25.8.1, npm 11.11.0.
