# 🧠 Digital Second Brain

> A full-stack note-taking app whose notes link themselves. On save, every note is
> scored against the rest of your collection and its strongest matches become its
> related notes. A separate keyword graph makes the whole collection browsable.

[![CI](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml)

> **This document describes the code on `main`, and nothing is currently deployed.**
> There was a hosted demo; its backend is gone, so the link has been removed rather
> than left pointing at a frontend that cannot log anyone in. Everything below is
> true of this repository at the commit you are reading, which is also what CI runs
> — not of any running instance. To try it, see **Running locally**.

> **What the badge covers, so a green tick is not read as more than it is.**
> The backend test suite, including integration tests against a real MongoDB;
> both retrieval parity proofs *regenerated rather than read*; the two
> documentation checkers; and **both database migrations with their rollbacks
> against a real MongoDB 7**.
> **One of those checkers runs partially there, deliberately.** It verifies that
> every command and path the published documentation names is real, but it
> cannot check the reverse — that every file is *described* somewhere — because
> the design documents it would read are not published. It says so on every run
> rather than passing quietly, and that half is checked before every commit
> instead.
> **What it does not cover:** the frontend, which has no tests at all; the
> evaluation scripts — the eval runner, the three parameter sweeps, the analysis
> drivers and the graph characterization — which need a multi-hundred-megabyte
> Stack Exchange corpus that is not in the repository; metric validation against
> `pytrec_eval`, which needs a pinned Python environment; and the LLM features,
> which need an API key. Those are run by hand, from the drivers in
> `backend/scripts/`. A green tick means **the checked subset passed**, not that
> the project is fully tested.

---

## What it does

- **Auto-links notes.** On save, a note is scored against the rest of your collection
  with BM25 over the full text, and its top 8 matches become its related notes — no
  manual tagging, no backlink syntax.
- **Visualises the collection.** A per-note graph and a whole-collection graph, both
  rendered with Cytoscape.js, with keyword nodes you can expand into the terms
  surrounding them. **These graphs are built from each note's extracted keywords, not
  from the link scores above** — two notes appear connected in the global view when
  they share a keyword. The scored links are what the related-notes panel shows.
- **Generates study material with an LLM.** Summaries, flashcards, key concepts,
  exam-style questions, and ELI5 explanations, from the note you have open.
- **Keeps full version history.** Every edit snapshots the previous content; any
  snapshot can be loaded back into the editor.
- **Searches three ways** — full-text, tag, and a keyword-expansion mode.
- **Imports files.** Drop in `.txt`, `.pdf`, or `.docx` and the text becomes a note.
- **Exports single notes** to PDF, Markdown, or plain text, and LLM output to HTML.
- **Scopes everything per user** behind JWT auth with bcrypt-hashed passwords.

---

## How the linking works

The interesting part of this project isn't the CRUD — it's how notes get connected
without anyone tagging them.

### 1. Keyword extraction

On save, the note's title (weighted 2x) and body are tokenised, lowercased, stripped
of punctuation, and filtered against a stopword list. Each surviving term is scored:

```
score(term) = tf(term) × idf(term) × (1 + log(term.length))
idf(term)   = log((N + 1) / (df + 1)) + 1
```

where `df` is the number of the user's *other* notes containing the term and `N` is
the size of that corpus — up to 500 notes, oldest first. The smoothing keeps the score
finite when a term appears in no other note, which is the common case for a small
collection. The top 10 terms become the note's keywords, and they are **stored on the
note** at that moment; see the third limitation below.

The length bonus is a heuristic, not a standard IR weighting — it biases toward
longer, more specific terms.

### 2. Scoring the links

**What runs today: Okapi BM25 over the full text**, through the same retrieval code the
evaluation harness calls, so the app and the measurements cannot drift apart. A note is
scored against the rest of the collection as a query against a corpus, and the top **8**
are kept. It does not read the stored keywords from step 1 at all — those feed the graph
and search instead.

There is **no score threshold**. BM25's score has no fixed scale, so a cutoff on it would
mean nothing; the cap of 8 is the only filter, and it is a rank cutoff.

**What it replaced, kept here because it is the baseline everything is measured against.**
The original scoring was the **overlap coefficient** over the two notes' keyword sets:

```
strength(A, B) = |keywords(A) ∩ keywords(B)| / max(|keywords(A)|, 1)
```

Pairs above `0.15` were kept, sorted, and capped at 8. With 10 keywords that threshold is
exactly *"share at least 2 words out of 10."* That version is preserved at tag
`v0-pre-reorientation` and is still executed on every CI run, as the reference side of a
byte-for-byte parity proof — so the "before" it defines cannot quietly rot.

**Links are stored once per pair, not once per direction.** BM25 is asymmetric —
`score(A→B) ≠ score(B→A)` — so a row keeps both numbers, each rewritten only by its own
note's save, and the single weight for the pair is derived from them on read rather than
stored. Every stored direction also records which retriever version and which parameters
produced it. One consequence worth knowing: a note's related-notes set is the union of
"notes it ranked" and "notes that ranked it", so it can exceed 8.

### 3. Known limitations of the above

Stated plainly, because this part of the codebase is being measured rather than
assumed, and a limitation nobody writes down is one nobody fixes:

- **The cap of 8 is a product constant, not a tuned one.** The original `0.15` and `8`
  *were* measured — swept exhaustively against the external judgments, where the best
  available setting beat the shipped guess by an amount whose confidence interval
  straddles zero. So the guesses were fine, which is a result rather than a
  disappointment: the point was that nobody could say. The threshold is now gone
  entirely; the cap survives untuned because a rank cutoff is the only kind of floor a
  scale-free score admits.
- **A note's keywords are a snapshot of the collection as it stood when that note was
  last saved.** The IDF above is computed over the notes that existed at save time and
  nothing recomputes it afterwards, so two notes with identical text saved at different
  times get different keywords — and the earliest notes in a collection are worst
  affected, because an almost-empty corpus gives every term the same IDF and the ranking
  collapses toward the longest words present. *Which* notes form that corpus is now
  specified; *when* is not, and cannot be fixed from that function: any stored value
  derived from a moving corpus is a function of when it was derived, and the only
  remedies are to stop storing it or to recompute everything. Measured on Stack Exchange
  questions shaped as notes, not on a real notebook.
- **Keyword extraction is believed to degrade on short notes and on code-heavy text**,
  where identifiers and boilerplate dominate the term distribution. **This one is
  unmeasured** — it is stated as the expectation it is, and the error analysis that
  looked hardest at short documents found the opposite failure (dilution by long quoted
  material) for a different component.
- **The whole-collection graph used to compare every pair of notes.** It is now built
  from a single inverted index, and the cost is `O(N·K)` to build the index plus
  `O(Σ df²)` to emit edges from it — output-sensitive, and still quadratic if one
  keyword appears in every note, which is why a document-frequency cutoff bounds it.
  The payload is the remaining problem: it is still tens of thousands of elements on
  a large collection, and browser-side layout is now the dominant cost and is
  unmeasured.

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
│  /api/auth    register / login → JWT          (unprotected)  │
│  /api/notes   CRUD; on save fires two background jobs:       │
│                 saveVersion()  ·  computeAndSaveLinks()      │
│  /api/graph   Cytoscape elements, per-note and global        │
│  /api/llm     Groq openai/gpt-oss-120b, five features        │
│  /api/search  keyword · tag · keyword-expansion              │
│  /api/upload  multer + pdf-parse                             │
│  /api/export  single note → pdf | markdown | text            │
│                                                              │
│  middleware/auth.js verifies the Bearer token on all of the  │
│  above except /api/auth                                      │
└───────────────────────────┬──────────────────────────────────┘
                            │  Mongoose 8
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                          MongoDB                             │
│  users         { name, username, email, password }           │
│  notes         { title, content, contentText, tags,          │
│                  keywords, color, category, user,            │
│                  linkedNotes[] — DEPRECATED, never written,  │
│                  embedding — unused }                        │
│  notelinks     { user, noteA, noteB,                         │
│                  scoreAB / scoreBA, and per direction the    │
│                  retriever version + params digest }         │
│                  one row per unordered pair, unique index    │
│  noteversions  { noteId, versionNumber, content, ... }       │
└──────────────────────────────────────────────────────────────┘
```

**Note on the two background jobs:** `saveVersion` and `computeAndSaveLinks` are
deliberately not awaited, so a save returns immediately. The cost is that their
failures currently only reach `console.error`.

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
| Uploads | multer, pdf-parse |
| PDF generation | pdfkit (server-side) |
| LLM | Groq — `openai/gpt-oss-120b` |
| Keyword extraction | Hand-written TF-IDF, no NLP library |
| Tests | Jest |

---

## Running locally

### With Docker (nothing to install but Docker)

```bash
docker compose up
```

Frontend on `http://localhost:4173`, API on `http://localhost:5001`, Mongo in a
container with a persistent volume. No `.env` file is needed — Compose supplies a
local-only `JWT_SECRET` and points the API at the containerised database. LLM features
need a key; export `GROQ_API_KEY` before `up` to enable them, and everything else works
without one.

Images are pinned by digest rather than by tag, so the environment is fixed rather than
approximately fixed. That matters because a separate one-off container rebuilds the
Stack Exchange evaluation corpus and its output is checked byte-for-byte against a
published SHA-256:

```bash
docker compose run corpus
```

That one needs the raw Stack Exchange dump in `data/raw/`, which is not in the repository:
it is hundreds of megabytes and is fetched from the public `archive.org` Stack Exchange
data dumps. The build script is `backend/scripts/build-corpus.js`.

### With Node directly

**Prerequisites:** Node — CI and the Docker image both pin **25.8.1**, which is the only
version anything is tested against; a MongoDB connection string; and a Groq API key for
the LLM features (free at `console.groq.com`), which everything else runs without.

```bash
git clone https://github.com/taneesha-beep/digital-second-brain.git
cd digital-second-brain

# Backend — http://localhost:5001
cd backend
npm install
npm run dev

# Frontend — http://localhost:5173, in a second terminal
cd frontend
npm install
npm run dev
```

Create `backend/.env` — `.env.example` in the repo root is a template:

```
PORT=5001
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=any_long_random_string
JWT_EXPIRE=7d
GROQ_API_KEY=your_groq_key
CORS_ALLOWED_ORIGINS=https://your-frontend-domain
```

`CORS_ALLOWED_ORIGINS` is a comma-separated list of exact origins. `http://localhost:5173`
and `http://localhost:4173` are always allowed, so it can be left empty for local
development. It is matched exactly — a deployed frontend will not reach the API
without being listed.

Run the backend tests with `npm test` from `backend/`.

Most of the suite needs nothing but Node. The integration tests need a throwaway
MongoDB and **skip themselves loudly when one is not configured** — they never fail
for its absence, and the run prints what it skipped and why:

```bash
docker run -d --rm --name dsb-mongo -p 27017:27017 \
  mongo:7@sha256:9bdaeb6dac6e7e762e84e2f84103d1f9bb078fa1ba6bde8bb9d2274f655ad173
MONGO_TEST_URI=mongodb://127.0.0.1:27017/dsb_integration_test npm test
```

`MONGO_TEST_URI` is deliberately a different variable from `MONGO_URI`: these tests
drop collections, so they refuse any host that is not localhost, and there is no
override.

---

## API reference

All routes require `Authorization: Bearer <token>` except the two under `/api/auth`.

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create an account, returns a JWT |
| POST | `/api/auth/login` | Log in, returns a JWT |
| GET | `/api/notes` | All notes for the current user |
| POST | `/api/notes` | Create a note |
| GET | `/api/notes/:id` | One note. Related notes are **not** included — use `/links` below |
| PUT | `/api/notes/:id` | Update; re-extracts keywords and re-links |
| DELETE | `/api/notes/:id` | Delete and clean up inbound links |
| GET | `/api/notes/graph` | Global graph for the current user |
| GET | `/api/notes/:id/links` | Related notes: the ones this note ranked first, by its own score, then the ones that ranked it |
| DELETE | `/api/notes/:id/relations/:relatedId` | Remove one link, both directions |
| GET | `/api/notes/:id/versions` | Version list |
| GET | `/api/notes/:id/versions/:versionNumber` | One version |
| GET | `/api/graph/note/:noteId` | Cytoscape elements for one note |
| GET | `/api/graph/note/:noteId/expand/:keyword` | Sub-keywords for a keyword node |
| GET | `/api/graph/global` | Cytoscape elements for the whole collection |
| POST | `/api/llm/:noteId/:feature` | `summarize`, `flashcards`, `concepts`, `examQs`, `eli5` |
| GET | `/api/search?q=&mode=` | `mode` is `keyword` (MongoDB `$text`), `tags`, or `semantic` |
| POST | `/api/upload` | Upload a `.txt` / `.pdf`, creates a note |
| GET | `/api/export/:noteId?format=` | `pdf`, `markdown`, or `text` |

The graph endpoints return `{ elements: [...] }` in Cytoscape's own format, not
`{ nodes, links }`. `/api/graph/global` returns a sibling `meta` alongside it, naming the
keywords a document-frequency cutoff suppressed — so a missing edge can be told apart from
an absent relationship. Nothing renders `meta`; it exists to be read.

`mode=semantic` is a misnomer inherited from an earlier design: it extracts keywords
from the query and scores notes on keyword, title, and body matches. There are no
embeddings behind it. The `embedding` field on the note schema is likewise unused.

---

## Project status

**The retrieval layer is measured rather than assumed, and that work is done.** Six
scoring implementations — lexical overlap, Jaccard, TF-IDF cosine, BM25, dense embeddings,
and a hybrid of the last two — were each evaluated against external human relevance
judgments taken from Stack Exchange moderation data, so the answer key was written by
strangers for unrelated reasons rather than by me about my own notes. Metrics were
validated against `pytrec_eval`, the NIST reference implementation, and every comparison
between implementations carries a paired-bootstrap confidence interval.

Two results worth stating because they are not the flattering ones: dense embeddings won,
which contradicts the prediction written down before the run; and the hybrid **lost** to
embeddings alone, on both the tuning and the held-out split, despite being the standard
recommendation. The app ships **BM25** rather than the winner — the embedding model needs
a vector stored and kept in sync per note, a backfill, and a few hundred megabytes of
runtime, and it cannot explain why it matched.

Retrieval now reaches the LLM features: a study pack is generated from a note **and its
retrieved neighbours**, and every item it produces carries a citation to the source note
it came from, checked programmatically against the context that was actually sent. That
check runs over a committed per-call ledger, needs no API key, and now covers the
**whole** evaluation set rather than a slice of it. Completing it changed the conclusion:
the citation rates held, but the same run exposed the feature's largest defect. The
output ceiling is inherited from a single-note feature and was never derived for a study
pack, and it cuts off a meaningful share of them — and because a truncated pack parses to
nothing, that one cause accounts for every quality failure the feature has. So the rates
are over the packs that complete, and re-deriving the ceiling is an open question rather
than a fix already made.

Work continuing: an independent judge model for groundedness with a human agreement
score beside it, the same generation run repeated across retrievers to test whether
better retrieval measurably improves output, request tracing, and a failure-mode catalog
with measured frequencies.
