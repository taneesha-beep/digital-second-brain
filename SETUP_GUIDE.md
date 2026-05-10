# Digital Second Brain — Complete Setup & Integration Guide

## Project Structure

```
digital-second-brain/
├── backend/
│   ├── middleware/
│   │   └── auth.js          ← JWT verification for protected routes
│   ├── models/
│   │   ├── User.js          ← Mongoose schema for users
│   │   └── Note.js          ← Mongoose schema for notes + keywords + relations
│   ├── routes/
│   │   ├── auth.js          ← POST /api/auth/register & /api/auth/login
│   │   └── notes.js         ← Full CRUD + /api/notes/graph
│   ├── utils/
│   │   └── keywords.js      ← Keyword extraction + relation scoring (pure JS, no ML deps)
│   ├── .env                 ← Environment variables (DO NOT commit to Git)
│   ├── package.json
│   └── server.js            ← Express app entry point
│
└── frontend/
    ├── src/
    │   ├── api/
    │   │   ├── axiosInstance.js  ← Axios with JWT interceptor + 401 handler
    │   │   └── notes.js          ← All API call functions
    │   ├── components/
    │   │   ├── KnowledgeGraph.jsx ← react-force-graph-2d interactive graph
    │   │   ├── Navbar.jsx
    │   │   ├── NoteCard.jsx       ← Note preview card with edit/delete
    │   │   ├── NoteForm.jsx       ← Create and edit form
    │   │   └── RelatedNotes.jsx   ← Shows notes linked by shared keywords
    │   ├── context/
    │   │   └── AuthContext.jsx    ← Global auth state (login/register/logout)
    │   ├── pages/
    │   │   ├── Dashboard.jsx      ← Main app page
    │   │   ├── LoginPage.jsx
    │   │   └── RegisterPage.jsx
    │   ├── App.jsx                ← Routes + PrivateRoute guard
    │   ├── index.css              ← Tailwind directives
    │   └── main.jsx               ← React entry point
    ├── index.html
    ├── package.json
    ├── postcss.config.js
    ├── tailwind.config.js
    └── vite.config.js
```

---

## Prerequisites

Before you begin, make sure the following are installed:

1. **Node.js** v18 or higher — https://nodejs.org
   - Verify: `node -v`
2. **npm** v9 or higher — comes with Node.js
   - Verify: `npm -v`
3. **MongoDB Community Server** — https://www.mongodb.com/try/download/community
   - OR use **MongoDB Atlas** (free cloud database) — https://cloud.mongodb.com
   - Verify local MongoDB is running: `mongod --version`

---

## Step 1 — Place the files in the correct folders

Your final folder layout must look exactly like the structure shown above.

- All files inside `backend/` go into one folder.
- All files inside `frontend/` go into a separate folder.
- Both folders should be siblings (next to each other), not nested.

---

## Step 2 — Configure the backend environment variables

Open `backend/.env` and update the values:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/digital_second_brain
JWT_SECRET=replace_this_with_any_long_random_string_like_abc123xyz789
JWT_EXPIRE=7d
```

**If using MongoDB Atlas instead of local MongoDB:**
1. Create a free cluster on https://cloud.mongodb.com
2. Click "Connect" → "Connect your application"
3. Copy the connection string and replace `MONGO_URI`:
   ```
   MONGO_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/digital_second_brain?retryWrites=true&w=majority
   ```
   Replace `<username>` and `<password>` with your Atlas credentials.

---

## Step 3 — Install backend dependencies

Open a terminal, navigate into the backend folder, and run:

```bash
cd backend
npm install
```

This installs: express, mongoose, bcryptjs, jsonwebtoken, cors, dotenv, nodemon.

---

## Step 4 — Install frontend dependencies

Open a NEW terminal window/tab, navigate into the frontend folder, and run:

```bash
cd frontend
npm install
```

This installs: react, react-dom, react-router-dom, react-force-graph, axios, vite, tailwindcss, etc.

---

## Step 5 — Start MongoDB (local only — skip if using Atlas)

Open another terminal and start the MongoDB service:

**On Windows:**
```bash
net start MongoDB
```

**On macOS (with Homebrew):**
```bash
brew services start mongodb-community
```

**On Linux:**
```bash
sudo systemctl start mongod
```

---

## Step 6 — Start the backend server

In the terminal that is inside the `backend/` folder:

```bash
npm run dev
```

You should see:
```
✅ Connected to MongoDB
🚀 Server running on http://localhost:5000
```

If you see a MongoDB connection error, ensure MongoDB is running (Step 5) or double-check your Atlas URI.

---

## Step 7 — Start the frontend development server

In the terminal that is inside the `frontend/` folder:

```bash
npm run dev
```

You should see:
```
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
```

---

## Step 8 — Open the application

Open your browser and go to: **http://localhost:5173**

You will see the Register / Login screen. Create an account and start adding notes.

---

## How the Full Stack Integration Works

### Authentication Flow
1. User submits register/login form on the frontend.
2. `AuthContext.jsx` calls `loginUser()` / `registerUser()` from `api/notes.js`.
3. These call `axiosInstance.js` which POSTs to `http://localhost:5000/api/auth/...`.
4. Backend `routes/auth.js` hashes the password (bcryptjs), creates the user in MongoDB, and returns a JWT token.
5. The token is stored in `localStorage` by `AuthContext`.
6. Every subsequent API call attaches the token via the Axios request interceptor in `axiosInstance.js`.

### Note Creation Flow
1. User types a note in `NoteForm.jsx` and clicks "Add Note".
2. `Dashboard.jsx` calls `createNote()` from `api/notes.js`.
3. The request hits `POST /api/notes` in `routes/notes.js`.
4. The route is protected by `middleware/auth.js` — it verifies the JWT and attaches `req.user`.
5. `utils/keywords.js` extracts the top 10 keywords from the note's title and content.
6. The note is saved to MongoDB with its keywords.
7. `refreshAllRelations()` runs — it compares all of the user's notes pairwise to find keyword overlaps and updates the `relatedNotes` array in each note document.
8. The response is sent back to the frontend with the populated `relatedNotes`.
9. `Dashboard.jsx` updates the notes state and triggers a graph refresh.

### Knowledge Graph Flow
1. `KnowledgeGraph.jsx` calls `GET /api/notes/graph`.
2. The backend fetches all notes for the logged-in user.
3. It builds a `{ nodes, links }` object where nodes are notes and links are edges between notes that share keywords.
4. `react-force-graph` renders this as an interactive force-directed graph.
5. Clicking a graph node selects that note in the dashboard, showing its related notes.

---

## API Endpoints Reference

| Method | Endpoint               | Auth? | Description                              |
|--------|------------------------|-------|------------------------------------------|
| POST   | /api/auth/register     | No    | Register a new user                      |
| POST   | /api/auth/login        | No    | Login, returns JWT token                 |
| GET    | /api/notes             | Yes   | Get all notes for logged-in user         |
| POST   | /api/notes             | Yes   | Create a note (auto-extracts keywords)   |
| PUT    | /api/notes/:id         | Yes   | Update a note (re-extracts keywords)     |
| DELETE | /api/notes/:id         | Yes   | Delete a note + clean up relations       |
| GET    | /api/notes/graph       | Yes   | Get graph data {nodes, links}            |
| GET    | /api/notes/:id         | Yes   | Get a single note with related notes     |

---

## Common Errors and Fixes

| Error | Fix |
|-------|-----|
| `MongoServerError: connect ECONNREFUSED` | MongoDB is not running. Start it (Step 5). |
| `Error: Cannot find module 'express'` | You forgot to run `npm install` in backend/. |
| `404 /api/notes not found` | The Vite proxy is not set up. Ensure `vite.config.js` is in the frontend root. |
| `JWT malformed` or `401 Unauthorized` | Your token expired or localStorage was cleared. Log in again. |
| White screen / React error | Open browser console (F12), look for the error. Usually a missing import or typo. |
| `react-force-graph` not rendering | Ensure `npm install` completed without errors. Try deleting `node_modules` and reinstalling. |

---

## Running Both Servers Simultaneously (Recommended)

You need **two terminal windows open at the same time**:
- Terminal 1: `cd backend && npm run dev`
- Terminal 2: `cd frontend && npm run dev`

Both must be running for the app to work.

---

## Building for Production (Optional)

```bash
# Build frontend
cd frontend
npm run build
# This creates a `dist/` folder with static files

# Serve the dist/ folder from Express (add to server.js):
# const path = require('path');
# app.use(express.static(path.join(__dirname, '../frontend/dist')));
# app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/dist/index.html')));
```
