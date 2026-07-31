# CLAUDE.md

Context for Claude Code sessions in this repo. Read this first, every session.

## What this project is

A MERN note-taking app whose notes auto-link to each other. It is deployed and
working. **The product identity stays a note-taking app** — that is a settled
decision, do not propose rebranding it.

The work in progress is a reorientation: the note-linking engine is a retrieval
and ranking system that was never treated as one, and it is being turned into a
*measured* one — evaluated against external human relevance judgments from Stack
Exchange rather than self-labelled data.

- **The plan:** `docs/ROADMAP.md` — nine phases, checkboxes are the progress tracker.
- **The target:** `docs/END-STATE.md` — what "finished" looks like, concretely.
  At any point you can diff reality against it to see what is left.
- **How to start:** `docs/GETTING-STARTED.md` — session cadence, checkpoints, review depth.
- **Do not work on:** `docs/FROZEN.md` — areas under maintenance freeze.

> **Most of `docs/` is gitignored on purpose.** `ROADMAP.md`, `END-STATE.md`,
> `GETTING-STARTED.md`, `HANDOFF.md`, `HANDOFF-2.md`, and `LEARNING.md` are present
> in the working tree and should be read freely — they are simply never published,
> because several contain personal career material. Untracked is not the same as
> absent: read them, edit them, keep `ROADMAP.md` updated. Just never `git add` them.
> `FROZEN.md` and this file are the only tracked documents in `docs/`.

## Working agreement

Follow this unless told otherwise in the session:

- **Explain the approach and wait for approval before writing implementation code.**
- **One task per session** for structural work. Two or three for mechanical work.
- **Update `docs/ROADMAP.md` at the end** — tick what is done, note what is not.
- **List anything noticed but out of scope rather than fixing it.**

Two additions from practice:

- **Consult before anything that risks a leaked secret or a bad-practice smell in
  git history.** This repo is being read by recruiters. Verify a leak by actually
  reading history before claiming one exists.
- **Never claim a number without the file it came from.** See "Claim discipline".

## Architecture in one screen

```
frontend/src/
  pages/          LoginPage, RegisterPage, Dashboard, GraphPage
  components/     editor/ (NoteEditor, LinkedNotesPanel)
                  graph/  (NoteGraph, GlobalGraph)
                  llm/    (AIPanel)
                  search/ (SearchBar, SearchResults)
  api/            axiosInstance.js is the only HTTP entry point
  context/        AuthContext, NoteContext

backend/
  routes/         auth, notes, graph, llm, search, upload, export
  services/       linker (link scoring), graphBuilder, llm, version
  utils/          keywords.js (TF-IDF extraction), corpus.js
  models/         Note, NoteVersion, User, NoteLink (unused)
```

**The core mechanic:** on note save → normalize content → `extractKeywords()`
(TF-IDF, top 10) → persist → fire two **un-awaited** background jobs
(`saveVersion`, `computeAndSaveLinks`). Links are scored by overlap coefficient
`|shared| / max(|sourceKeywords|, 1)`, kept above `0.15`, capped at 8, written
bidirectionally, rendered with Cytoscape.

## Things that will bite you

- **Quill, pdf.js, and mammoth are injected from CDNs at runtime** by
  `NoteEditor.jsx` and `Dashboard.jsx`. They appear in no `package.json`. Do not
  conclude they are unused because they are absent from a manifest.
- **`normalizeContent()` handles three historical content shapes** and there is
  real data in all three. Breaking it loses user notes.
- **The two background link/version jobs are not awaited**, so their failures
  currently only reach `console.error`.
- **`mode=semantic` in search uses no embeddings**, and the `embedding` field on
  the Note schema is unused. Both names are misnomers inherited from an earlier
  design.
- **The graph endpoints return `{ elements: [...] }`** in Cytoscape's format, not
  `{ nodes, links }`.
- **`data/raw/` holds multi-hundred-MB XML dumps.** Gitignored, and must stay so —
  GitHub rejects files over 100 MB and history rewrites on this repo are expensive.

## Claim discipline

Three classes of number, and they are not interchangeable:

- **Countable from code** — round trips, endpoint counts, cap values. Free to state.
- **Asymptotic** — free *if the analysis survives worst-case questioning*.
- **Measured** — requires a documented harness and a stated environment. **No
  environment, no claim.**

**Do not write anywhere:** a commit count as an achievement; lines of code as an
achievement; "no external NLP library" while any remains in a manifest; any latency
or throughput figure without its environment; a groundedness score without the
judge–human agreement reported next to it.

On the complexity of the graph builder specifically: "O(N²) → O(N·K)" is **not**
defensible. Index construction is O(N·K), but edge emission from a postings bucket
of size *m* costs *m²*, so the total is O(Σ_t df_t²) — output-sensitive, and still
quadratic if one keyword appears in every note. The document-frequency cutoff is
what bounds it. State it that way.

## Traps specific to the evaluation work

- **Self-retrieval.** The query document sitting in its own candidate pool matches
  itself perfectly and silently inflates every metric. Exclude the query id from
  its own results. This is the most common way IR evaluations go quietly wrong.
- **Plausibility band.** For lexical retrieval on Stack Exchange duplicate/related
  judgments, nDCG@8 of 0.1–0.4 is unremarkable and probably real. **Above ~0.7,
  assume a bug before assuming success.** Below ~0.05, suspect a tokenizer mismatch,
  undecoded HTML entities, or qrels ids not matching corpus ids.
- **Never change two variables at once.** Not a prompt and a parameter, not a metric
  and a retriever. An unattributable result is worthless.
- **Baselines are unrecoverable.** In several phases the "before" number is destroyed
  by the change itself. Capture it as a separate, earlier step.

## Commands

```bash
cd backend  && npm run dev     # http://localhost:5001
cd frontend && npm run dev     # http://localhost:5173
cd backend  && npm test        # jest
```

`backend/.env` needs `PORT`, `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRE`, `GROQ_API_KEY`.
`CORS_ALLOWED_ORIGINS` is optional — it adds to a built-in allowlist, it does not
replace it.
