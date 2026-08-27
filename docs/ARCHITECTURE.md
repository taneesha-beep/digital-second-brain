# Architecture

**A note-taking app with a measured retrieval system inside it.** This document describes how the
pieces fit together and where each non-obvious boundary is. The decisions behind those boundaries
are one level down, in [`docs/adr/`](adr/README.md); what the retrieval is *worth* is in
[`README.md`](../README.md); what it does when it breaks is in
[`docs/FAILURE-MODES.md`](FAILURE-MODES.md).

**This describes the code on `main`, at the commit you are reading.** A deployed instance exists
and holds data this repository knows nothing about.

---

## 1. The shape

```
frontend (React + Vite, Vercel)
    │  axiosInstance.js — the only HTTP entry point
    ▼
backend (Express + Node, Render)
    routes/      auth · notes · upload · llm · study-pack · graph · search · export
    middleware/  auth (protect) · rateLimit (four limiters) · objectId (router.param guard)
    services/    noteCorpus · linker · graphBuilder · llm · studyPack · version
    retrieval/   ◄── the measured boundary. PURE. See ADR-0006
    observability/  OpenTelemetry, OFF unless DSB_TRACING=1
    models/      Note · NoteLink · NoteVersion · User
    ▼
MongoDB Atlas
```

Two of the eight routers spend model quota — `llm` and `study-pack` — and both are rate limited.
The other six are not budgeted at all, which is the half of the app the measurement is about.

---

## 2. The core mechanic — what happens when you save a note

```
PUT /api/notes/:id
  │
  ├─ normalizeContent()        three historical content shapes, all with live data
  ├─ extractKeywords()         TF-IDF, top 10 — stored, and read by the graph view
  ├─ persist the note
  │
  └─ fire two UN-AWAITED background jobs, then respond
        ├─ saveVersion()             snapshot into NoteVersion
        └─ computeAndSaveLinks()     ── this is the retrieval path
```

The response does not wait for either job. That is a deliberate design with a real cost, and both
halves are recorded: the queue that would formalise it was declined
([ADR-0003](adr/0003-no-job-queue.md)), and the failure mode it created — a background job failing
into silence — was made observable instead
([`docs/OBSERVABILITY.md`](OBSERVABILITY.md)).

### The retrieval path, in detail

```
computeAndSaveLinks(noteId, userId)
  │
  ├─ services/noteCorpus.service.js
  │     loads the user's ≤500 notes and hands them across the boundary as
  │     plain { id, title, body } objects — no mongoose, no schema
  │
  ├─ backend/retrieval/  ── index(docs) → search(handle, query, k) → describe(handle)
  │     v4-bm25 over the full text. Ignores the stored keywords entirely.
  │     Rebuilt per call, in memory, thrown away — ADR-0007
  │
  └─ services/linker.service.js
        top 8 results → canonical edges → ONE ordered bulkWrite — ADR-0001
```

**Three driver operations per save, constant in the link count.** The previous storage was
`3 + 2 × links`. [`results/write-cost.txt`](../results/write-cost.txt)

---

## 3. The boundary that makes the numbers mean anything

`backend/retrieval/` contains every retriever and nothing else, and **no file in it may require
anything that resolves outside it** — a test fails the suite if one does.

The consequence is the point: **the application and the evaluation harness run the same retriever
code.** Every figure in [`results/test-ladder.txt`](../results/test-ladder.txt) is a claim about
shipped behaviour rather than about a laboratory copy, and that is proved by regenerating two
byte-identical parity artifacts on every CI run rather than asserted in a comment.
[`results/parity/README.md`](../results/parity/README.md) · [ADR-0006](adr/0006-offline-retriever-interface.md)

The boundary costs something, and the cost is paid deliberately. The corpus adapter cannot live
inside it — an adapter requires the `Note` model by definition — and neither can tracing, so
retrieval is timed from its caller with no child span.

---

## 4. Two halves that no longer share an algorithm

This is the single most surprising thing about the codebase and the easiest to get wrong when
reading it.

| Surface | What it uses |
|---|---|
| **Note linking** (the related-notes panel) | `v4-bm25` over the **full text**, through the retrieval interface. **Ignores `note.keywords`.** |
| **The graph views** and `search?mode=semantic` | the **stored** `note.keywords` list, via a separate builder |

Four callers still read stored keywords; the linker is not one of them. Recomputing keywords at
read time to close the gap was measured and declined at **2237.0 ms at N=500**, against the graph
builder's own 5.1 ms. [`results/graph-characterization.txt`](../results/graph-characterization.txt)

Two names in this area are misnomers inherited from an earlier design and documented rather than
renamed, because renaming touches a shipped schema: **`mode=semantic` uses no embeddings**, and
the `Note.embedding` field is unused.

---

## 5. Storage

| Model | Role |
|---|---|
| `Note` | the note. `linkedNotes[]` is **deprecated** — no route serves it, and it is kept as the migration's rollback target |
| `NoteLink` | **the live edge store.** One row per unordered pair, unique on `{user, noteA, noteB}` over a normal form, carrying **both directions' scores** and each direction's provenance |
| `NoteVersion` | snapshot per save |
| `User` | auth |

An edge carries two scores because `v4-bm25` is asymmetric, and the single weight a caller sees is
`max` over the observed directions, **computed on read** so it cannot ratchet. A note's degree can
therefore exceed the cap of 8, because its edge set is the union of "notes it ranked" and "notes
that ranked it". [ADR-0001](adr/0001-canonical-edge-storage.md)

Each direction also carries **two** provenance fields — the retriever version and its parameter
digest — because a version string alone is not provenance: the same name means different things
under different parameters, and a stored score's scale is set by those parameters. Rows nothing
can identify are labelled `unknown`, which is a value rather than a blank.

Two migrations, applied in order, each additive, idempotent and reversible, and each refusing a
non-localhost host without an explicit flag.
[`results/migration-verification.txt`](../results/migration-verification.txt)

---

## 6. Retrieval reaches generation

Six AI features. Five take a single note. **One is retrieval-augmented**, and it is the join this
project exists to build:

```
POST /api/study-pack/:noteId
  │
  ├─ the note + its v4-bm25 neighbours, through the SAME interface the linker uses
  ├─ assembled under a context-token budget                 ── a measured bound, not a tokenizer
  ├─ ONE generation call
  └─ items that each cite a source note by id
```

The five single-note features are deliberately **untouched** — they are the A/B control for the
sixth, and a test asserts their prompt set has exactly five entries so a sixth prompt there turns
red on the shape.

The context budget drops **whole notes** from the tail of the ranked list rather than truncating a
note, because an item must not cite text the model never saw. Every response reports its estimate
beside the API's actual token count, so the bound is checked on every call.
[`results/estimator-bound.txt`](../results/estimator-bound.txt)

**Citation validity is measured; groundedness is measured and reported beside its judge–human
agreement.** Both, with their denominators and their caveats, are in
[`docs/FAILURE-MODES.md`](FAILURE-MODES.md).

---

## 7. What a request meets before it reaches a handler

Three layers, in order, and each exists because of something that actually happened:

1. **CORS**, with an allowlist. A rejected origin gets a `403` with a body saying so rather than a
   generic server fault.
2. **`protect`** — JWT. `/api/auth` is mounted without it, deliberately.
3. **Rate limiting** — four limiters. Two are per-account on the quota-spending routes; one is a
   budget **shared by every user** across both; the fourth is on registration and is keyed
   globally, because that route runs before `protect` so there is no account to key on and the
   only alternative is an IP behind at least two proxies. **Login is deliberately uncapped** — a
   shared budget on login is an outage for every existing user, where on registration it is a wait
   for a new visitor. [`results/rate-limit-verification.txt`](../results/rate-limit-verification.txt)

Then a **`router.param` guard** on every id-taking route: a malformed id returns each router's own
*not found* response rather than a `500`, so malformed is indistinguishable from absent — which
cross-user isolation requires. It runs *after* the limiters, so a refused request is still counted.

**`trust proxy` is deliberately unset.** The app sits behind at least two hops and any number
written down would be a guess.

---

## 8. Observability

OpenTelemetry, **off unless `DSB_TRACING=1`**, and a test asserts it is off under `npm test`. Six
pipeline spans plus two detached background-job spans. The LLM span carries nine attributes
including a computed cost — which is a **published list price and not money anyone was charged**;
the project runs on a free tier.

The background jobs get a **new root span carrying a link back to the request**, never a child,
because a child that outlives its parent is exactly what *un-awaited* means and would inflate the
save's own reported duration.

Full detail, including the failure this made visible for the first time:
[`docs/OBSERVABILITY.md`](OBSERVABILITY.md).

---

## 9. What is deliberately absent

Each of these is a decision with a price attached, not an omission:

| Absent | Record |
|---|---|
| A job queue | [ADR-0003](adr/0003-no-job-queue.md) |
| A load test, and any throughput claim | [ADR-0004](adr/0004-microbenchmark-not-load-test.md) |
| Response caching for the AI features | [ADR-0005](adr/0005-no-response-caching.md) |
| A persisted document-frequency collection | [ADR-0007](adr/0007-in-memory-per-user-index.md) |
| Dense embeddings in the shipped path — **the rung that won the ladder** | [ADR-0002](adr/0002-lexical-first-retrieval.md) |

---

## 10. Things that will surprise you

- **Quill, pdf.js and mammoth are injected from CDNs at runtime** and appear in no manifest. Their
  absence from `package.json` does not mean they are unused.
- **`normalizeContent()` handles three historical content shapes** and there is real data in all
  three.
- **`POST /api/notes` normalizes but deliberately does not extract keywords**, so a new note
  carries an empty keyword list until its first update. A test pins that, so a later widening goes
  red rather than silently becoming §4's declined change.
- **The graph endpoints return `{ elements: [...] }`** in Cytoscape's format, not `{ nodes, links }`.
  The global one also returns a sibling `meta` naming the keywords a document-frequency cutoff
  suppressed, so a suppressed edge cannot be mistaken for an absent relationship.
- **`buildNoteGraph`, `expandKeyword` and `getVersions` take a note id with no user filter** and
  are safe only because every caller checks ownership first. A test pins them as unscoped, so
  scoping them is a deliberate change rather than a drive-by.
- **There are three tokenizers**, not one. The graph builder has its own, with a different
  minimum length and a shorter stopword list, and nothing has ever measured it.

---

## 11. Provenance

**Every source named here is a committed file**, for the reason
[`docs/FAILURE-MODES.md`](FAILURE-MODES.md) gives in its own provenance section: this project's
design documents are deliberately unpublished, and a reference a reader cannot follow is worse than
no reference.

**A note on which numbers are guarded.** This file is scanned by `npm run check:claims`, which
verifies that every decimal of four or more places traces to a committed artifact. Most figures
here are **counts and millisecond timings, which are outside that scope and are not
machine-checked** — they are re-read from the artifacts above rather than remembered. No
performance claim is made from any timing in this document; see
[ADR-0004](adr/0004-microbenchmark-not-load-test.md) for why this repository does not make one.
