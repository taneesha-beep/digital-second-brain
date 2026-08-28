# 🧠 Digital Second Brain

> **A note-taking app whose notes link themselves.** Save a note and it is scored against
> the rest of your collection; its strongest matches become its related notes, with no
> tagging and no backlink syntax. The engine underneath is a **retrieval system, and it is
> measured like one** — six implementations benchmarked against external human relevance
> judgments from Stack Exchange rather than against labels I wrote about my own notes.

[![CI](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/taneesha-beep/digital-second-brain/actions/workflows/ci.yml)

<details>
<summary><strong>What the badge covers, so a green tick is not read as more than it is.</strong></summary>

The backend test suite, including integration tests against a real MongoDB; both retrieval
parity proofs *regenerated rather than read*; the two documentation checkers; and **both
database migrations with their rollbacks against a real MongoDB 7**.

**One of those checkers runs partially there, deliberately.** It verifies that every command
and path the published documentation names is real, but it cannot check the reverse — that
every file is *described* somewhere — because the design documents it would read are not
published. It says so on every run rather than passing quietly, and that half is checked
before every commit instead.

**What it does not cover:** the frontend, which has no tests at all; the evaluation scripts —
the eval runner, the three parameter sweeps, the analysis drivers and the graph
characterization — which need a multi-hundred-megabyte Stack Exchange corpus that is not in
the repository; metric validation against `pytrec_eval`, which needs a pinned Python
environment; and the LLM features, which need an API key. Those are run by hand, from the
drivers in `backend/scripts/`. A green tick means **the checked subset passed**, not that the
project is fully tested.

</details>

> **▶ Try it — [taneesha-digital-second-brain.vercel.app](https://taneesha-digital-second-brain.vercel.app)** ·
> sign up, write two notes on the same subject, and the second one links itself.
>
> **The AI features are budgeted; nothing else is.** Each account gets 10 AI requests and 6 study
> packs per 15 minutes, and *all visitors together* share one budget of **18 AI requests per 24
> hours** — a free Groq tier whose quota also feeds this project's evaluation runs. That counter
> lives in process memory, so any deploy resets it and what is left when you arrive is not
> predictable. New accounts are capped at 20 per hour across all visitors; signing in is not
> capped. Notes, auto-linking, the graph, search, import, export and version history have **no
> limit at all** — which is the half of the app this README is about.
> `backend/middleware/rateLimit.js`
>
> **This file describes the code on `main`, at the commit you are reading — which is also what CI
> runs**, and not the instance above: that is a deployment of *some* commit, holding real data this
> repository knows nothing about. Keeping those two apart is the single thing here that has been
> wrong three separate times, so it is stated rather than assumed — no checker in this repo can
> see a false sentence.

---

## What the linking is worth, measured

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
([`results/metric-validation.txt`](results/metric-validation.txt)). Two results worth stating
because they are not the flattering ones: **dense embeddings won, which contradicts the
prediction written down before the run**, and **the hybrid lost to embeddings alone on both
splits**, despite being the standard recommendation.

**The app ships `v4-bm25` rather than the winner, and not for speed.** At a notebook's scale
both are sub-millisecond. The embedding model needs a vector stored and kept in sync per note,
a backfill for every existing one, and a few hundred megabytes resident — and it cannot explain
why it matched, where BM25 can.

- **How the retrieval was evaluated** → [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — where the
  answer key came from, how the scoring was checked against the NIST reference, what was tuned on
  which split, and what the key cannot tell you. Every rung's raw numbers are in
  [`results/test-ladder.txt`](results/test-ladder.txt).
- **A silent failure made visible** → [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) — a
  background job that had been failing into silence since the app was written, and the trace
  that shows it.
- **Documented failure modes** → [`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md) — fifteen
  measured ways this system breaks, each with a frequency, its denominator, and the artifact it
  was read from.

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
- **Generates study material with an LLM.** Six features. Five work from the note you have
  open — summaries, flashcards, key concepts, exam-style questions and ELI5 explanations.
  The sixth, **Study Pack, is the one that joins the two halves of this project**: it pulls
  the note *and its retrieved neighbours*, assembles them under a token budget, and returns
  flashcards and concepts that each cite the source note they came from. Every citation is
  checked against the context that was actually sent.
- **Keeps full version history.** Every edit snapshots the previous content; any
  snapshot can be loaded back into the editor.
- **Searches three ways** — full-text, tag, and a keyword-expansion mode.
- **Imports files.** Drop in `.txt`, `.md`, `.pdf`, or `.docx` and the text becomes a note.
  `.docx` and `.md` are parsed in the browser; `.txt` and `.pdf` go through the server.
- **Exports single notes** to PDF, Markdown, or plain text, and LLM output to HTML.
- **Scopes everything per user** behind JWT auth with bcrypt-hashed passwords.
- **Rate-limits the two routes that spend money.** `/api/llm` and `/api/study-pack` carry a
  per-user limit each plus one budget shared by every user, because per-user limits alone bound
  nothing while registration is open. `/api/auth/register` carries a global limit of its own;
  `/api/auth/login` deliberately carries none, since a shared budget on login is an outage for
  every existing user where on registration it is a wait for a new visitor.

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
byte-for-byte parity proof — so the "before" it defines cannot quietly rot. It is the
`v1-overlap` row in the table above.

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
  remedies are to stop storing it or to recompute everything. Recomputing at read time
  was priced and declined — it costs three orders of magnitude more than the graph build
  it would sit beside. Measured on Stack Exchange questions shaped as notes, not on a
  real notebook.
- **Keyword extraction is believed to degrade on short notes and on code-heavy text**,
  where identifiers and boilerplate dominate the term distribution. **This one is
  unmeasured** — it is stated as the expectation it is, and the error analysis that
  looked hardest at short documents found the opposite failure (dilution by long quoted
  material) for a different component. See [`results/error-analysis.md`](results/error-analysis.md).
- **A note created through `POST /api/notes` is neither normalised nor keyword-extracted
  until its first edit**, because both run on `PUT` only — yet link computation fires on
  create regardless. So a brand-new note's first link computation runs against text that
  never passed the normaliser. Found by watching which trace spans fired, not by reading
  the route. Unmeasured and unfixed: changing what create stores would move stored
  keywords for every later save.
- **The whole-collection graph used to compare every pair of notes.** It is now built
  from a single inverted index, and the cost is `O(N·K)` to build the index plus
  `O(Σ df²)` to emit edges from it — output-sensitive, and still quadratic if one
  keyword appears in every note, which is why a document-frequency cutoff bounds it.
  The payload is the remaining problem: it is still tens of thousands of elements on
  a large collection, and browser-side layout is now the dominant cost and is
  unmeasured.

---

## Architecture

> The diagram below is the shape. **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** is how the
> pieces actually fit — the retrieval path in detail, the boundary that makes the numbers above
> claims about shipped code, and the things in here that will surprise you.
>
> **[`docs/adr/`](docs/adr/README.md) — eight architecture decision records, four of which document
> a decision *not* to build something**, each with the price of the thing declined and the
> conditions that would change the answer. No job queue, no load test, no response cache, no
> persisted document-frequency table — and the retriever that won the ladder is not the one that
> ships.

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
│  middleware/auth.js verifies the Bearer token on all of the  │
│  above except /api/auth. middleware/rateLimit.js holds four  │
│  limiters: per user on the two routes that spend Groq quota, │
│  one budget shared by every user across both, and one on     │
│  register shared by every visitor                            │
└───────────────────────────┬──────────────────────────────────┘
                            │  Mongoose 8
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                          MongoDB                             │
│  users         { name, username, email, password }           │
│  notes         { title, content, contentText, tags,          │
│                  keywords, color, category, user,            │
│                  linkedNotes[] — DEPRECATED, see below,      │
│                  embedding — unused }                        │
│  notelinks     { user, noteA, noteB,                         │
│                  scoreAB / scoreBA, and per direction the    │
│                  retriever version + params digest }         │
│                  one row per unordered pair, unique index    │
│  noteversions  { noteId, versionNumber, content, ... }       │
└──────────────────────────────────────────────────────────────┘
```

**`notes.linkedNotes` is deprecated but not inert.** No link is written to it any more and no
route serves it; it is kept on disk as the canonical-edge migration's rollback target, which is
why the delete paths still `$pull` from it — a rollback target that drifts out of step is not
one.

**Note on the two background jobs.** `saveVersion` and `computeAndSaveLinks` are deliberately
not awaited, so a save returns immediately. That is still the decision. What it used to cost was
silence: a failure reached one line of `console.error`, and a user whose links failed to compute
saw an empty related-notes panel — indistinguishable from a note that genuinely has none. Each
job now runs inside its own **detached, linked trace span**, so a failure is a red span carrying
the exception and a reference back to the save that started it. A child span was refused
deliberately: a child that outlives its parent is what *un-awaited* means, and it would inflate
the note-save trace's reported duration. Tracing is **off unless `DSB_TRACING=1`** — including
under `npm test`, where a test asserts it. [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).

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

Jaeger is behind a Compose profile, so a plain `up` does not start it:

```bash
docker compose --profile tracing up -d jaeger
```

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

`CORS_ALLOWED_ORIGINS` is a comma-separated list of exact origins. It **adds to** a built-in
allowlist rather than replacing it: `http://localhost:5173`, `http://localhost:4173` and the
deployed frontend are always allowed, so it can be left empty for local development. Origins are
matched exactly — a substring test is not a check, because the `Origin` header is
attacker-controlled.

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
| POST | `/api/auth/register` | Create an account, returns a JWT. **Rate limited across all visitors** |
| POST | `/api/auth/login` | Log in, returns a JWT. Deliberately not rate limited |
| GET | `/api/notes` | All notes for the current user |
| POST | `/api/notes` | Create a note. Does **not** normalise or extract keywords — see the fourth limitation above |
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

The graph endpoints return `{ elements: [...] }` in Cytoscape's own format, not
`{ nodes, links }`. The global one returns a sibling `meta` alongside it, naming the
keywords a document-frequency cutoff suppressed — so a missing edge can be told apart from
an absent relationship. Nothing renders `meta`; it exists to be read.

`/api/study-pack` returns considerably more than the panel renders: which notes went into the
prompt, which were dropped to fit the token budget, the retriever version and parameter digest
that chose them, the finish reason, and the citation counts. That is so a call can be audited
after the fact rather than only watched.

`mode=semantic` is a misnomer inherited from an earlier design: it extracts keywords
from the query and scores notes on keyword, title, and body matches. There are no
embeddings behind it. The `embedding` field on the note schema is likewise unused.

---

## Project status

**The retrieval layer is measured rather than assumed, and that work is done.** The table at
the top of this file is the result. Metrics were validated against `pytrec_eval`, the NIST
reference implementation, and every comparison between implementations carries a
paired-bootstrap confidence interval.

**Retrieval now reaches the LLM features.** A study pack is generated from a note **and its
retrieved neighbours**, and every item it produces carries a citation to the source note it came
from, checked programmatically against the context that was actually sent. That check runs over
a committed per-call ledger, needs no API key, and covers the whole evaluation set. Citation
validity held at every item in the set; what the same run exposed was the feature's largest
defect, and the two facts are separate. A study pack inherited its output ceiling from a
single-note feature, and it cut off close to a quarter of them — and because a truncated pack
parses to nothing, that one cause accounted for every quality failure the feature had. **The
ceiling has since been raised for study packs specifically, and the post-change truncation rate
is unmeasured**: knowing it needs a fresh run at the new ceiling, and every rate quoted from
that evaluation is from the run at the old one.

**An independent judge model scored groundedness, and its headline does not travel alone.** A
second model graded every item against the note it cited and against a note it did not, and the
result that carries is the contrast rather than the level: items were judged fully supported
against a cited note and never once against a distractor. The level itself is low, and a
blind human rater agreeing with the judge only moderately is reported beside it — a rubric this
strict meeting a generator that paraphrases is not the same thing as a hallucination rate, and
it must not be quoted as one.

**The result the project was building toward is a null, and it was pre-registered.** The same
generation run was repeated across two retrievers whose nDCG@8 differs by more than half again,
with everything else held fixed. Every downstream difference landed inside a minimum detectable
effect that was computed and published *before* the run. "Inside the MDE" means the design could
not have seen an effect, not that there is none — but almost every RAG writeup asserts that
better retrieval improves output, and this one measured it and reported that it could not tell.

**Request tracing and a failure-mode catalog are both shipped** —
[`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) and
[`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md).

**Work continuing:** a trimmed architecture document and a set of architecture decision records,
including the three that document things deliberately *not* built — a job queue, response
caching, and read-time keyword recomputation — each with the measured price that decided it and
the conditions that would flip the answer.
