# 🧠 Digital Second Brain

> A full-stack note-taking app whose notes link themselves. Every note is scored
> against the rest of your collection on save, and the resulting relationships are
> rendered as an interactive knowledge graph.

**[🔗 Live demo](https://taneesha-digital-second-brain.vercel.app/login)** ·
[![CI](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml)

> **What the badge covers, so a green tick is not read as more than it is.**
> The backend test suite, including integration tests against a real MongoDB;
> both retrieval parity proofs *regenerated rather than read*; the two
> documentation checkers; and **both database migrations with their rollbacks
> against a real MongoDB 7**.
> **What it does not cover:** the frontend, which has no tests at all; the
> evaluation scripts — the eval runner, the three parameter sweeps, the analysis
> drivers and the graph characterization — which need a multi-hundred-megabyte
> Stack Exchange corpus that is not in the repository; metric validation against
> `pytrec_eval`, which needs a pinned Python environment; and the LLM features,
> which need an API key. Those are run by hand and are listed with their commands
> in `docs/EVALUATION.md`. A green tick means **the checked subset passed**, not
> that the project is fully tested.

---

## What it does

- **Auto-links notes.** On save, a note's keywords are extracted and compared against
  every other note you own. Notes sharing enough terms become connected — no manual
  tagging, no backlink syntax.
- **Visualises the result.** A per-note graph and a whole-collection graph, both
  rendered with Cytoscape.js, with keyword nodes you can expand to see why two notes
  are related.
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
the size of that corpus. The smoothing keeps the score finite when a term appears in
no other note, which is the common case for a small collection. The top 10 terms
become the note's keywords.

The length bonus is a heuristic, not a standard IR weighting — it biases toward
longer, more specific terms.

### 2. Scoring the links

Two notes are compared by the **overlap coefficient** over their keyword sets:

```
strength(A, B) = |keywords(A) ∩ keywords(B)| / max(|keywords(A)|, 1)
```

Pairs scoring above `0.15` are kept, sorted by strength, and capped at the **8**
strongest. The link is then written to both notes so the relationship is navigable
from either end.

### 3. Known limitations of the above

Stated plainly, because they are the reason this part of the codebase is being
reworked:

- **The threshold and the cap are unvalidated.** `0.15` and `8` were chosen by hand
  and have never been measured against any notion of a correct answer.
- **The overlap coefficient is asymmetric.** `strength(A, B) ≠ strength(B, A)`, so
  the weight stored on an edge depends on which note was saved last.
- **Keyword extraction degrades on short notes and on code-heavy text**, where
  identifiers and boilerplate dominate the term distribution.
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
│  /api/llm     Groq llama-3.3-70b-versatile, five features    │
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
│                     MongoDB Atlas                            │
│  users         { name, username, email, password }           │
│  notes         { title, content, contentText, tags,          │
│                  keywords, embedding, linkedNotes[],         │
│                  color, category, user }                     │
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
| LLM | Groq — `llama-3.3-70b-versatile` |
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

That one needs the raw dump in `data/raw/`, which is not in the repository — see
`docs/EVALUATION.md` for where it comes from.

### With Node directly

**Prerequisites:** Node 18+, a MongoDB connection string, a Groq API key
(free at `console.groq.com`).

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
docker run -d --rm --name dsb-mongo -p 27017:27017 mongo:7
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
| GET | `/api/notes/:id` | One note, with linked notes populated |
| PUT | `/api/notes/:id` | Update; re-extracts keywords and re-links |
| DELETE | `/api/notes/:id` | Delete and clean up inbound links |
| GET | `/api/notes/graph` | Global graph for the current user |
| GET | `/api/notes/:id/links` | Linked notes, strongest first |
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
`{ nodes, links }`.

`mode=semantic` is a misnomer inherited from an earlier design: it extracts keywords
from the query and scores notes on keyword, title, and body matches. There are no
embeddings behind it. The `embedding` field on the note schema is likewise unused.

---

## Project status

The retrieval layer described under **How the linking works** is being reworked into
a measured system: the same scoring code evaluated against external human relevance
judgments, with the threshold and cap tuned against a held-out set rather than
guessed. The limitations listed above are the starting point for that work.

---

## License

Not yet licensed.
