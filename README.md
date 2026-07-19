# 🧠 Digital Second Brain

> A full-stack MERN app that turns disconnected notes into an interactive knowledge graph — using TF-IDF keyword extraction to automatically surface relationships you didn't know were there.

**[🔗 Live Demo](https://taneesha-digital-second-brain.vercel.app/register)**

---

## Demo

<!-- Drop your GIF/screenshot here. Recommended: a short GIF of creating a couple of notes
     and watching them auto-link in the graph — that single visual does more than any paragraph. -->

![Digital Second Brain — knowledge graph demo](ADD_YOUR_GIF_OR_SCREENSHOT_HERE)

---

## What It Does

- **Auto-extracts keywords** from every note using TF-IDF scoring, then links notes that share significant terms
- **Visualizes connections** as a color-coded, interactive knowledge graph (Cytoscape.js), with clusters grouped by topic
- **Ingests files** — drag-and-drop `.txt` or `.pdf`, and the text is extracted into a note automatically
- **Exports everything** to PDF or JSON for backup or reuse
- **Keeps notes private per user** with JWT authentication and hashed passwords

---

## How It Works

The interesting part of this project isn't the CRUD — it's how notes get connected without any manual tagging.

### Keyword extraction (TF-IDF)

When a note is created or edited, the backend scores its terms using **TF-IDF (Term Frequency–Inverse Document Frequency)** rather than raw word counts. This matters because raw frequency over-weights common words that appear everywhere and carry little meaning. TF-IDF balances two signals:

- **Term Frequency** — how often a term appears _in this note_
- **Inverse Document Frequency** — how _rare_ that term is across all of the user's notes

The result is that a word like "physics" appearing across many notes is down-weighted, while a distinctive term that defines a specific note is boosted. The top-scoring terms become that note's keywords. Common stopwords are filtered out before scoring.

### Linking related notes

Once notes have keywords, the system compares them and links notes that share significant terms, then recomputes the relationship map so the graph and the "Related Notes" panel stay in sync. Each note is assigned a color based on its dominant topic, so related subjects visually cluster together in the graph.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (React + Vite)                  │
│                                                              │
│  Login / Register                                            │
│       ↓                                                      │
│  AuthContext (stores JWT)                                    │
│       ↓                                                      │
│  axiosInstance.js  →  attaches JWT to every request          │
└──────────────────────┬──────────────────────────────────────┘
                       │  HTTP  (/api/...)
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                     BACKEND (Node + Express)                 │
│                                                              │
│  /api/auth     →  register / login, returns JWT              │
│  /api/notes    →  CRUD + TF-IDF keyword extraction           │
│                   + relationship recomputation               │
│                   + topic-cluster color assignment           │
│  /api/upload   →  multer + pdf-parse → auto-create note      │
│  /api/notes/graph → { nodes, links } for Cytoscape           │
│       ↑  middleware/auth.js verifies JWT on protected routes │
└──────────────────────┬──────────────────────────────────────┘
                       │  Mongoose
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                  MongoDB Atlas (Cloud)                       │
│  users  → { username, email, hashedPassword }                │
│  notes  → { title, content, keywords, color,                 │
│             category, relatedNotes, userId }                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer          | Technology        | Purpose                                    |
| -------------- | ----------------- | ------------------------------------------ |
| Frontend UI    | React 18          | Component-based user interface             |
| Styling        | Tailwind CSS      | Utility-first styling                      |
| Build Tool     | Vite              | Dev server and bundler                     |
| Graph          | Cytoscape.js      | Interactive knowledge-graph visualization  |
| Routing        | React Router v6   | Client-side navigation                     |
| HTTP Client    | Axios             | API calls with automatic JWT attachment    |
| PDF Export     | jsPDF             | Generate PDFs in the browser               |
| Backend        | Node.js + Express | REST API server                            |
| Database ORM   | Mongoose          | MongoDB object modeling                    |
| Database       | MongoDB Atlas     | Cloud NoSQL database                       |
| Auth           | JWT + bcryptjs    | Stateless auth + password hashing          |
| File Upload    | Multer            | Multipart form-data handling               |
| PDF Parsing    | pdf-parse         | Server-side text extraction from PDFs      |
| Keyword Engine | Custom TF-IDF     | Keyword extraction with stopword filtering |

---

## Features in Detail

- **Notes** — create with title, content, and optional category; keywords and links are generated automatically on save
- **File upload** — drag-and-drop or click to upload `.txt` / `.pdf`; the filename becomes the note title
- **Knowledge graph** — zoom, pan, click a node to select, hover to inspect a note's title, category, and keywords; same-color nodes belong to the same topic cluster
- **Related Notes panel** — shows notes connected to the selected one, with shared keywords highlighted; incorrect links can be removed manually
- **Search** — filter by title, content, keywords, or category, updating as you type
- **Export** — download all notes as a formatted PDF or as JSON

---

## Running Locally

### Prerequisites

- Node.js 18+
- A free MongoDB Atlas cluster (or a local MongoDB instance)

### Quick Start

```bash
# 1. Clone
git clone https://github.com/taneesha-beep/digital-second-brain.git
cd digital-second-brain

# 2. Backend
cd backend
npm install
cp .env.example .env      # then fill in your values (see below)
npm run dev               # starts on http://localhost:5001

# 3. Frontend (in a second terminal)
cd frontend
npm install
npm run dev               # starts on http://localhost:5173
```

Open **http://localhost:5173**, register an account, and start adding notes.

### Environment Variables

Create `backend/.env` with:

```
PORT=5001
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=any_long_random_string
JWT_EXPIRE=7d
```

> **Note:** `.env` is gitignored and must never be committed. A committed `.env.example` (with placeholder values, no real secrets) documents the required keys for anyone cloning the repo.

For detailed, step-by-step setup — including installing Node, creating an Atlas cluster, and getting a connection string — see **[SETUP_GUIDE.md](./SETUP_GUIDE.md)**.

---

## API Reference

| Method | Endpoint                              | Auth | Description                                |
| ------ | ------------------------------------- | ---- | ------------------------------------------ |
| POST   | `/api/auth/register`                  | No   | Create a new user account                  |
| POST   | `/api/auth/login`                     | No   | Log in, returns a JWT                      |
| GET    | `/api/notes`                          | Yes  | Get all notes for the logged-in user       |
| POST   | `/api/notes`                          | Yes  | Create a note (auto keywords + color)      |
| PUT    | `/api/notes/:id`                      | Yes  | Edit a note (re-extracts keywords)         |
| DELETE | `/api/notes/:id`                      | Yes  | Delete a note and clean up its links       |
| GET    | `/api/notes/:id`                      | Yes  | Get one specific note                      |
| GET    | `/api/notes/graph`                    | Yes  | Get `{ nodes, links }` for the graph       |
| DELETE | `/api/notes/:id/relations/:relatedId` | Yes  | Remove a specific link between two notes   |
| POST   | `/api/upload`                         | Yes  | Upload a `.txt` / `.pdf` and create a note |

---

## What I'd Improve Next

- **Semantic linking with embeddings** — TF-IDF matches on shared surface terms, so notes about the same idea in different words won't link. Sentence embeddings (e.g. sentence-transformers) would connect notes by _meaning_, not just vocabulary.
- **Tunable link threshold** — expose the strength required to form a link so users can control how densely the graph connects.
- **Incremental relationship updates** — recompute only the affected links on each change instead of the full map, to scale to large note sets.
- **Test coverage** — add unit tests around the keyword-extraction and linking logic, the parts most worth protecting from regressions.
