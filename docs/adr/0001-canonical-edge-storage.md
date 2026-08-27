# ADR-0001 — One canonical row per note pair

- **Status:** Accepted · 11 Aug 2026 · Phase 4.2
- **Relates to:** [ADR-0002](0002-lexical-first-retrieval.md) — the asymmetry this record is
  built around is a property of the retriever that ADR chose.

## Context

A note's related notes were stored as an array on the note itself: `Note.linkedNotes`, written in
both directions on every save. That storage predates any measurement of the retriever, and Phase
4.1 broke two of its assumptions at once.

**The retriever became asymmetric.** `v4-bm25` length-normalises and saturates the document side
of the score and does neither on the query side, so `score(A→B) ≠ score(B→A)`. This is measured,
not assumed: on the committed fixture corpus, **92 of the 96 pairs that are scored in both
directions disagree** — see [`results/write-cost.txt`](../../results/write-cost.txt). A store that
keeps one number per pair has to destroy one of two real values.

**The write cost was linear in the link count.** The same artifact fits the old path exactly at
`ops = 3 + 2 × links`, mean 9.82 driver operations per save and worst case 19. A cap of 8 links
therefore bought a worst case of nineteen round trips on a path that runs on every keystroke-driven
save.

## Decision

Store **one row per unordered pair** in `backend/models/NoteLink.js`, behind a unique index on
`{user, noteA, noteB}` over a normal form where `String(noteA) < String(noteB)`. The row carries
**both directions' scores** — `scoreAB` and `scoreBA` — each replaced only by its own source
note's save. The single weight a caller sees is `max` over the observed directions, **computed on
read** by `backend/utils/notePair.js` and never stored.

All of a save's edges are written in **one ordered `bulkWrite`**.

`Note.linkedNotes` is left on disk, deprecated and unread by any route.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **One score column, `mean`** | Symmetrising means scoring `f(A,B) + f(B,A)`, which is a different retriever rather than a setting. A mean is a value **no rung on the ladder ever produced**, and ADR-0003's sibling decision — stamping the retriever version on the row — would then be stamping a lie. |
| **One score column, `min`** | BM25 normalises by document length, so `min` systematically selects the view in which the target is the long document. Long notes' edges would be uniformly weak for a reason that is an artifact of the scoring function. |
| **A stored `max`** | It ratchets. A stored maximum can only be raised by a later save, never lowered, so an edge that has genuinely weakened keeps its old strength forever. Deriving it on read cannot ratchet. |
| **Last-writer-wins** | What the old array did. Whichever note was saved most recently silently decided the pair's strength. |
| **A directed unique index** | The revived model shipped with `{user, sourceNote, targetNote}` — directed — under a comment reading *"One undirected edge per note pair per user"*. The comment was the correct intention; the index was not. |
| **Deleting `Note.linkedNotes`** | It is the migration's rollback target and it holds the v1-era `sharedKeywords` that nothing else records. |

## Consequences

- **Write cost is now constant in the link count.** Measured on the same fixture:
  `ops = 3 + 0 × links`, **exactly 3 on every note**, min = p50 = max = 3, against the old path's
  mean 9.82 and max 19. [`results/write-cost.txt`](../../results/write-cost.txt)
- **A note's degree can exceed the cap of 8**, because its edge set is the *union* of "notes it
  ranked" and "notes that ranked it". On the fixture, **22 of 34 notes sit above the cap**, median
  degree 9. This is not new — the old bidirectional write pushed into the target's array with no
  cap at all — but it stops being an accident and becomes a stated property.
- **`strength` is no longer in `[0,1]`.** It is the raw retriever score, and the revived model's
  `max: 1` ceiling would have rejected the write. `sharedKeywords` is empty, because BM25 explains
  a hit with a count rather than a term list.
- **A migration was required before deploying**, because the render path reads `NoteLink` and
  nothing else: shipping this against an unmigrated database empties every existing note's related
  panel until that note is next saved, and an empty collection is indistinguishable from a user
  with no links. The migration is additive, idempotent and reversible, and was applied to
  production before the redeploy. [`results/migration-verification.txt`](../../results/migration-verification.txt)
- **Two functions read one row** — `weight()` and `weightProvenance()` — with nothing structurally
  forcing them to agree. A test pins their agreement across five row shapes; that is a guard, not
  a proof.

## Evidence

| Source | What it carries |
|---|---|
| [`results/write-cost.txt`](../../results/write-cost.txt) | operations per save before and after, both fitted exactly; the stored graph's shape; the degree-above-cap count |
| [`results/migration-verification.txt`](../../results/migration-verification.txt) | the migration and its rollback against a pinned MongoDB 7 |
| [`results/provenance-query.txt`](../../results/provenance-query.txt) | the per-direction labelling added immediately after, in Phase 4.3 |
| `backend/models/NoteLink.js` · `backend/utils/notePair.js` | the schema, the normal form, and the read-time weight |

**Not machine-checked:** the integer counts above are outside `npm run check:claims`, which scopes
to decimals of four or more places. They are re-read from the artifact rather than remembered.
