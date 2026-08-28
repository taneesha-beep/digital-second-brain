# 🧠 Digital Second Brain

> **A note-taking app whose notes link themselves.** Save a note and it is scored against the
> rest of your collection; its strongest matches become its related notes — no tagging, no
> backlink syntax.
>
> The engine underneath is a retrieval system, and it is **measured like one**: six
> implementations benchmarked against external human relevance judgments from Stack Exchange,
> rather than against labels I wrote about my own notes.

[![CI](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml)

**▶ Live demo — [taneesha-digital-second-brain.vercel.app](https://taneesha-digital-second-brain.vercel.app)**

Sign up, write two notes on the same subject, and the second one links itself.

> The AI features run on a free tier and are budgeted — 10 requests and 6 study packs per account
> per 15 minutes, plus 18 requests per 24 hours shared by *all* visitors
> ([`backend/middleware/rateLimit.js`](backend/middleware/rateLimit.js)). Everything else has no
> limit. This README describes the code on `main`, which is what CI runs — not the deployed
> instance, which holds real data this repository knows nothing about.

---

## Results

Six retrieval implementations, each scored against **external human relevance judgments** —
Stack Exchange duplicate and related links, written by strangers for unrelated reasons rather
than by me about my own notes. The figures below are the **held-out** split; the tuning split,
every other cutoff and the per-run provenance are in
[`results/test-ladder.txt`](results/test-ladder.txt).

| Retriever | How it scores | nDCG@8 | P@8 |
|---|---|---|---|
| `v1-overlap` | shared-keyword overlap coefficient — **what the app shipped before this work** | 0.1361 | 0.0351 |
| `v2-jaccard` | Jaccard over the same keyword sets | 0.1371 | 0.0357 |
| `v3-tfidf` | tf·idf cosine over the full vocabulary | 0.1952 | 0.0511 |
| `v4-bm25` | Okapi BM25 over the full text — **what the app ships today** | 0.2391 | 0.0617 |
| `v5-embeddings` | MiniLM-L6-v2 dense vectors, cosine similarity | **0.3197** | **0.0811** |
| `v6-hybrid` | reciprocal-rank fusion of `v4-bm25` and `v5-embeddings` | 0.2996 | 0.0768 |

Every comparison between rungs carries a paired-bootstrap confidence interval
([one example](results/comparisons/v5-embeddings-vs-v4-bm25.test.txt)), and the metric
implementation is validated against `pytrec_eval`, the NIST reference
([`results/metric-validation.txt`](results/metric-validation.txt)).

**Two results worth stating because they are not the flattering ones.** Dense embeddings won,
contradicting the prediction written down before the run — and the hybrid lost to embeddings
alone on both splits, despite being the standard recommendation.

**The app ships `v4-bm25` rather than the winner, and not for speed** — at a notebook's scale both
are sub-millisecond. The embedding model needs a vector stored and kept in sync per note, a
backfill for every existing one, and a few hundred megabytes resident; and it cannot explain why
it matched, where BM25 can.

---

## What it does

- **Auto-links notes.** On save, a note is scored against the rest of your collection with BM25
  over the full text, and its top 8 matches become its related notes.
- **Visualises the collection.** A per-note graph and a whole-collection graph in Cytoscape.js,
  with keyword nodes you can expand. These are built from each note's **stored keywords, not the
  link scores above** — two notes appear connected in the global view when they share a keyword,
  while the scored links are what the related-notes panel shows.
- **Generates study material with an LLM.** Five features work from the note you have open —
  summaries, flashcards, key concepts, exam-style questions and ELI5. The sixth, **Study Pack,
  joins the two halves of this project**: it pulls the note *and its retrieved neighbours*,
  assembles them under a token budget, and returns items that each cite the source note they came
  from. Every citation is checked against the context that was actually sent.
- **Keeps full version history.** Every edit snapshots the previous content; any snapshot loads
  back into the editor.
- **Searches three ways** — full-text, tag, and keyword-expansion.
- **Imports files.** Drop in `.txt`, `.md`, `.pdf` or `.docx` and the text becomes a note.
  `.docx` and `.md` are parsed in the browser; `.txt` and `.pdf` go through the server.
- **Exports** single notes to PDF, Markdown or plain text, and LLM output to HTML.
- **Scopes everything per user** behind JWT auth with bcrypt-hashed passwords, and rate-limits
  the two routes that spend money plus account registration.

---

## How the linking works

The interesting part of this project isn't the CRUD — it's how notes get connected without
anyone tagging them.

### 1. Keyword extraction

On save, the note's title (weighted 2×) and body are tokenised, lowercased, stripped of
punctuation, and filtered against a stopword list. Each surviving term is scored:

```
score(term) = tf(term) × idf(term) × (1 + log(term.length))
idf(term)   = log((N + 1) / (df + 1)) + 1
```

`df` is the number of the user's *other* notes containing the term; `N` is the size of that
corpus, up to 500 notes. The smoothing keeps the score finite when a term appears in no other
note — the common case for a small collection. The top 10 terms are stored on the note. The
length bonus is a heuristic rather than a standard IR weighting: it biases toward longer, more
specific terms.

### 2. Scoring the links

**Okapi BM25 over the full text**, through the same retrieval code the evaluation harness calls,
so the app and the measurements cannot drift apart. A note is scored against the rest of the
collection as a query against a corpus, and the top **8** are kept. It does not read the stored
keywords from step 1 at all — those feed the graph and search instead.

There is **no score threshold**. BM25's score has no fixed scale, so a cutoff on it would mean
nothing; the cap of 8 is a rank cutoff and the only filter.

**What it replaced**, kept here because it is the baseline everything is measured against — the
overlap coefficient over the two notes' keyword sets:

```
strength(A, B) = |keywords(A) ∩ keywords(B)| / max(|keywords(A)|, 1)
```

Pairs above `0.15` were kept, sorted and capped at 8 — with 10 keywords, exactly *"share at least
2 words out of 10."* That version is preserved at tag `v0-pre-reorientation` and is still executed
on every CI run as the reference side of a byte-for-byte parity proof, so the "before" it defines
cannot quietly rot. It is the `v1-overlap` row in the table above.

### 3. Storing them

**Links are stored once per pair, not once per direction.** BM25 is asymmetric —
`score(A→B) ≠ score(B→A)` — so a row keeps both numbers, each rewritten only by its own note's
save, and the pair's single weight is derived on read rather than stored. Every stored direction
also records which retriever version and which parameters produced it. One consequence: a note's
related-notes set is the union of "notes it ranked" and "notes that ranked it", so it can
exceed 8.

**Where this breaks is measured rather than assumed** — fifteen failure modes, each with a
frequency, its denominator, and the artifact it was read from:
[`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    FRONTEND (React 18 + Vite)                │
│                                                              │
│  LoginPage / RegisterPage ──► AuthContext (holds the JWT)    │
│  Dashboard  ──► NoteEditor (Quill, loaded from CDN)          │
│             ──► NoteGraph · LinkedNotesPanel · AIPanel       │
│             ──► SearchBar · VersionHistory · ExportMenu      │
│  GraphPage  ──► GlobalGraph                                  │
│                                                              │
│  api/axiosInstance.js — attaches the JWT, handles 401        │
└───────────────────────────┬──────────────────────────────────┘
                            │  HTTP
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                  BACKEND (Node + Express 4)                  │
│                                                              │
│  /api/auth       register / login → JWT       (no protect;   │
│                  register is rate limited, login is not)     │
│  /api/notes      CRUD; on save fires two background jobs:    │
│                    saveVersion()  ·  computeAndSaveLinks()   │
│  /api/graph      Cytoscape elements, per-note and global     │
│  /api/llm        Groq openai/gpt-oss-120b, five single-note  │
│                  features                     (rate limited) │
│  /api/study-pack one note + its BM25 neighbours → one cited  │
│                  generation                   (rate limited) │
│  /api/search     keyword · tag · keyword-expansion           │
│  /api/upload     multer + pdf-parse                          │
│  /api/export     single note → pdf | markdown | text         │
│                                                              │
│  middleware/  auth.js verifies the Bearer token on all of    │
│  the above except /api/auth · rateLimit.js holds four        │
│  limiters · objectId.js turns a malformed id into the        │
│  route's own not-found rather than a 500                     │
└───────────────────────────┬──────────────────────────────────┘
                            │  Mongoose 8
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                          MongoDB                             │
│  users         { name, username, email, password }           │
│  notes         { title, content, contentText, tags,          │
│                  keywords, color, category, user }           │
│  notelinks     { user, noteA, noteB, scoreAB / scoreBA,      │
│                  and per direction the retriever version     │
│                  + params digest } — one row per unordered   │
│                  pair, behind a unique index                 │
│  noteversions  { noteId, versionNumber, content, ... }       │
└──────────────────────────────────────────────────────────────┘
```

**The two background jobs are deliberately not awaited**, so a save returns immediately. What
that used to cost was silence: a failure reached one line of `console.error`, and a user whose
links failed to compute saw an empty related-notes panel — indistinguishable from a note that
genuinely has none. Each job now runs inside its own **detached, linked trace span**, so a
failure is a red span carrying the exception and a reference back to the save that started it.
Tracing is **off unless `DSB_TRACING=1`**, including under `npm test`, where a test asserts it.

---

## Documentation

| Document | What it answers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces actually fit — the retrieval path in detail, the boundary that makes the numbers above claims about shipped code, and the things in here that will surprise you |
| [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) | Where the answer key came from, how the scoring was checked against the NIST reference, what was tuned on which split, and what the key *cannot* tell you |
| [`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md) | Fifteen measured ways this system breaks, each with a frequency, its denominator, and the artifact it was read from |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | A background job that had been failing into silence since the app was written, and the trace that shows it |
| [`docs/adr/`](docs/adr/README.md) | Eight architecture decision records — **four of them a decision *not* to build something**, each with the price of the thing declined and the conditions that would change the answer |

---

## Running locally

### With Docker — nothing to install but Docker

```bash
docker compose up
```

Frontend on `http://localhost:4173`, API on `http://localhost:5001`, Mongo in a container with a
persistent volume. No `.env` file is needed. Export `GROQ_API_KEY` before `up` to enable the LLM
features; everything else works without one. Images are pinned by digest rather than by tag, so
the environment is fixed rather than approximately fixed.

Jaeger sits behind a Compose profile, so a plain `up` does not start it:

```bash
docker compose --profile tracing up -d jaeger
```

### With Node directly

**Prerequisites:** Node 25.8.1 — what CI and the Docker image both pin, and the only version
anything is tested against — a MongoDB connection string, and a Groq API key for the LLM features
only (free at `console.groq.com`).

```bash
git clone https://github.com/taneesha-beep/digital-second-brain.git
cd digital-second-brain

# Backend — http://localhost:5001
cd backend && npm install && npm run dev

# Frontend — http://localhost:5173, in a second terminal
cd frontend && npm install && npm run dev
```

`backend/.env` takes `PORT`, `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRE` and `GROQ_API_KEY`;
`.env.example` in the repo root is a template.

### Tests

```bash
cd backend && npm test
```

Most of the suite needs nothing but Node. The integration tests need a throwaway MongoDB and
**skip themselves loudly when one is not configured** — they never fail for its absence, and the
run prints what it skipped and why:

```bash
docker run -d --rm --name dsb-mongo -p 27017:27017 \
  mongo:7@sha256:9bdaeb6dac6e7e762e84e2f84103d1f9bb078fa1ba6bde8bb9d2274f655ad173
MONGO_TEST_URI=mongodb://127.0.0.1:27017/dsb_integration_test npm test
```

`MONGO_TEST_URI` is deliberately a different variable from `MONGO_URI`: these tests drop
collections, so they refuse any host that is not localhost, and there is no override.

**A green badge covers the checked subset, not the project.** CI runs the backend suite, both
retrieval parity proofs, the two documentation checkers, and both database migrations against a
real MongoDB. It does not cover the frontend, which has no tests; the evaluation scripts, which
need a Stack Exchange corpus too large for the repository; or the LLM features, which need an API
key. Those are run by hand from `backend/scripts/`.

---

## API reference

All routes require `Authorization: Bearer <token>` except the two under `/api/auth`.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create an account, returns a JWT. **Rate limited across all visitors** |
| POST | `/api/auth/login` | Log in, returns a JWT. Deliberately not rate limited |
| GET | `/api/notes` | All notes for the current user |
| POST | `/api/notes` | Create a note. Normalises the content but deliberately does **not** extract keywords — those arrive on the first update |
| GET | `/api/notes/:id` | One note. Related notes are **not** included — use `/links` below |
| PUT | `/api/notes/:id` | Update; re-extracts keywords and re-links |
| DELETE | `/api/notes/:id` | Delete and clean up inbound links |
| GET | `/api/notes/:id/links` | Related notes: the ones this note ranked first, by its own score, then the ones that ranked it |
| DELETE | `/api/notes/:id/relations/:relatedId` | Remove one link, both directions |
| GET | `/api/notes/:id/versions` | Version list |
| GET | `/api/notes/:id/versions/:versionNumber` | One version |
| GET | `/api/graph/note/:noteId` | Cytoscape elements for one note |
| GET | `/api/graph/note/:noteId/expand/:keyword` | Sub-keywords for a keyword node |
| GET | `/api/graph/global` | Cytoscape elements for the whole collection |
| POST | `/api/llm/:noteId/:feature` | `summarize`, `flashcards`, `concepts`, `examQs`, `eli5`. **Rate limited** |
| POST | `/api/study-pack/:noteId` | The note plus its BM25 neighbours → flashcards and concepts, each citing a source note. **Rate limited** |
| GET | `/api/search?q=&mode=` | `mode` is `keyword` (MongoDB `$text`), `tags`, or `semantic` |
| POST | `/api/upload` | Upload a `.txt` / `.pdf`, creates a note |
| GET | `/api/export/:noteId?format=` | `pdf`, `markdown`, or `text` |

Three things a caller should know:

- **The graph endpoints return `{ elements: [...] }`** in Cytoscape's own format, not
  `{ nodes, links }`. The global one adds a sibling `meta` naming the keywords a
  document-frequency cutoff suppressed, so a missing edge can be told apart from an absent
  relationship. Nothing renders `meta`; it exists to be read.
- **`/api/study-pack` returns more than the panel shows** — which notes went into the prompt,
  which were dropped to fit the token budget, the retriever version and parameter digest that
  chose them, the finish reason, and the citation counts — so a call can be audited afterwards
  rather than only watched.
- **`mode=semantic` is a misnomer** inherited from an earlier design: it extracts keywords from
  the query and scores notes on keyword, title and body matches. There are no embeddings behind
  it, and the `embedding` field on the note schema is likewise unused.

---

## Tech stack

| Layer | Technology |
|---|---|
| UI | React 18, React Router 6, Tailwind CSS |
| Build | Vite |
| Graph | Cytoscape.js |
| Rich text | Quill 1.3 (injected from CDN at runtime) |
| File parsing, client | pdf.js, mammoth.js (both injected from CDN) |
| HTTP | Axios |
| Server | Node.js, Express 4 |
| Database | MongoDB Atlas, Mongoose 8 |
| Auth | JWT, bcryptjs |
| Rate limiting | express-rate-limit (pinned exactly) |
| Uploads | multer, pdf-parse |
| PDF generation | pdfkit (server-side) |
| LLM | Groq — `openai/gpt-oss-120b` |
| Keyword extraction | Hand-written TF-IDF, no NLP library |
| Tracing | OpenTelemetry → Jaeger, dev-only and off by default |
| Tests | Jest |
