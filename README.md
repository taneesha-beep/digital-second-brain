# Digital Second Brain

A full-stack AI-powered knowledge management app that connects your notes into an
intelligent graph. Built solo using React, Node.js, Express, MongoDB, and Groq LLM
integration — with a custom TF-IDF keyword extraction algorithm and automatic
smart linking between related notes.

🔗 Live Demo: [https://taneesha-digital-second-brain.vercel.app/dashboard](https://taneesha-digital-second-brain.vercel.app/dashboard)
📁 Built by: Taneesha Badhe (sole developer)

## Key Technical Highlights

- Custom TF-IDF NLP algorithm for keyword extraction (no external NLP library)
- Smart linking engine that automatically computes semantic relationships between notes
- Interactive knowledge graph using Cytoscape.js with color-coded topic clusters
- LLM integration via Groq API for AI-powered note insights
- JWT authentication with bcryptjs password hashing
- PDF and .txt file upload with automatic text extraction
- Export to PDF and JSON
- Full REST API with 10 endpoints

## Tech Stack

Frontend: React 18, Tailwind CSS, Vite, Cytoscape.js, Axios
Backend: Node.js, Express.js, Mongoose
Database: MongoDB Atlas
Auth: JWT + bcryptjs
AI: Groq LLM API
File handling: Multer, pdf-parse, jsPDF
Deployment: Vercel (frontend), Render (backend)

## Screenshots
<img width="1440" height="900" alt="Screenshot 2026-05-12 at 1 42 36 PM" src="https://github.com/user-attachments/assets/8aab3a14-f8d7-4f9d-b889-17da762a24b0" />
<img width="1440" height="900" alt="Screenshot 2026-05-12 at 1 40 26 PM" src="https://github.com/user-attachments/assets/5714329c-2df3-404d-9e47-68c0508226cf" />
<img width="1440" height="900" alt="Screenshot 2026-05-12 at 1 41 16 PM" src="https://github.com/user-attachments/assets/95087952-8761-414c-a40c-16c0b35a7c79" />
<img width="1440" height="900" alt="Screenshot 2026-05-12 at 1 41 27 PM" src="https://github.com/user-attachments/assets/528e7c93-65c1-4f3d-b0ec-ae115acc9661" />
<img width="1440" height="900" alt="Screenshot 2026-05-12 at 1 42 22 PM" src="https://github.com/user-attachments/assets/1a3f082b-9a96-4af6-8aad-6e9cdeceb634" />


## 📋 Table of Contents

1. [What This App Does](#what-this-app-does)
2. [What You Need Before Starting](#what-you-need-before-starting)
3. [Understanding the Project Structure](#understanding-the-project-structure)
4. [Step-by-Step Setup](#step-by-step-setup)
5. [Running the App Every Time](#running-the-app-every-time)
6. [How to Use Each Feature](#how-to-use-each-feature)
7. [How Everything Is Connected](#how-everything-is-connected)
8. [Common Errors and Fixes](#common-errors-and-fixes)
9. [API Endpoints Reference](#api-endpoints-reference)

---

## What This App Does

- **Create notes** with a title, content, and optional subject category
- **Auto-extract keywords** from every note using a built-in NLP algorithm
- **Auto-link related notes** that share keywords
- **Color-code notes and graph nodes** by topic cluster so related subjects appear in the same color
- **Interactive knowledge graph** (Cytoscape.js) showing all connections visually
- **Upload notes** from `.txt` or `.pdf` files — text is extracted automatically
- **Export all notes** as a PDF document or JSON file
- **Remove wrong links** manually from the Related Notes panel
- **Search notes** by title, content, keywords, or category
- **User authentication** — each user has their own private notes

---

## What You Need Before Starting

You need to install three things on your computer before the app will work. Do these one at a time.

### 1. Node.js (the JavaScript runtime)

Node.js lets your computer run JavaScript outside a browser — this is what powers the backend server.

**How to install:**

1. Go to https://nodejs.org
2. Download the version that says **"LTS"** (Long Term Support) — this is the stable version
3. Open the downloaded file and follow the installer steps (just keep clicking Next/Continue)
4. When done, open your **Terminal** (Mac) or **Command Prompt** (Windows) and type:

   ```
   node -v
   ```

   You should see something like `v20.x.x`. If you do, Node.js is installed correctly.

5. Also check npm (Node Package Manager, installed automatically with Node.js):
   ```
   npm -v
   ```
   You should see something like `10.x.x`.

> **What is Terminal / Command Prompt?**
>
> - On **Mac**: Press `Command + Space`, type "Terminal", press Enter
> - On **Windows**: Press `Windows key`, type "cmd", press Enter

---

### 2. MongoDB Atlas Account (the cloud database)

MongoDB Atlas is where all your notes and user data are stored in the cloud — for free.

**How to set it up:**

1. Go to https://cloud.mongodb.com and click **"Try Free"**
2. Create an account (you can sign up with Google)
3. After logging in, click **"Build a Database"**
4. Choose **"FREE"** (M0 tier) → Select a cloud region close to you → Click **"Create"**
5. It will ask you to create a database user:
   - Set a **Username** (e.g., `admin`)
   - Set a **Password** (write this down — you'll need it soon)
   - Click **"Create User"**
6. Under **"Where would you like to connect from?"**, click **"Add My Current IP Address"**
   - This tells MongoDB Atlas to allow your computer to connect
   - Click **"Finish and Close"**

**Getting your connection string:**

1. On your Atlas dashboard, click **"Connect"** (next to your cluster name)
2. Choose **"Drivers"**
3. Select **"Node.js"** from the Driver dropdown
4. Copy the connection string. It looks like:
   ```
   mongodb+srv://admin:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. Replace `<password>` with the actual password you set in step 5 above
6. Keep this string — you will paste it into the `.env` file in the next section

> **Important:** If you change your internet connection (e.g., switch from home WiFi to mobile hotspot), Atlas may block the new IP. Go to Atlas → Network Access → Add IP Address → Add Current IP Address to fix this.

---

### 3. A Code Editor (optional but helpful)

We recommend **Visual Studio Code** — it's free and makes reading code much easier.
Download from: https://code.visualstudio.com

---

## Understanding the Project Structure

When you unzip the downloaded file, you'll see this structure:

```
digital-second-brain/
│
├── backend/                  ← The server (Node.js + Express)
│   ├── middleware/
│   │   └── auth.js           ← Checks if user is logged in before allowing access
│   ├── models/
│   │   ├── User.js           ← Defines what a User looks like in the database
│   │   └── Note.js           ← Defines what a Note looks like in the database
│   ├── routes/
│   │   ├── auth.js           ← Handles login and registration
│   │   ├── notes.js          ← Handles creating, editing, deleting, linking notes
│   │   └── upload.js         ← Handles file uploads (.txt and .pdf)
│   ├── utils/
│   │   ├── keywords.js       ← The NLP keyword extraction algorithm
│   │   └── colors.js         ← Assigns colors to notes by topic cluster
│   ├── .env                  ← Your secret configuration (database URL, JWT secret)
│   ├── package.json          ← List of backend packages/dependencies
│   └── server.js             ← The main entry point of the backend
│
├── frontend/                 ← The user interface (React.js)
│   ├── src/
│   │   ├── api/
│   │   │   ├── axiosInstance.js  ← HTTP client with auto-JWT and error handling
│   │   │   └── notes.js          ← All API call functions used by components
│   │   ├── components/
│   │   │   ├── ExportButtons.jsx ← PDF and JSON export buttons
│   │   │   ├── KnowledgeGraph.jsx← Cytoscape.js graph visualization
│   │   │   ├── Navbar.jsx        ← Top navigation bar
│   │   │   ├── NoteCard.jsx      ← Individual note display card (color-coded)
│   │   │   ├── NoteForm.jsx      ← Form to create or edit a note
│   │   │   ├── RelatedNotes.jsx  ← Panel showing connected notes + remove link
│   │   │   └── UploadNote.jsx    ← Drag-and-drop file upload component
│   │   ├── context/
│   │   │   └── AuthContext.jsx   ← Global login state accessible by all components
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx     ← Main page after login
│   │   │   ├── LoginPage.jsx     ← Login screen
│   │   │   └── RegisterPage.jsx  ← Registration screen
│   │   ├── App.jsx               ← Route definitions (which URL shows which page)
│   │   ├── index.css             ← Global styles (Tailwind CSS)
│   │   └── main.jsx              ← React entry point
│   ├── index.html                ← The HTML file React loads into
│   ├── package.json              ← List of frontend packages/dependencies
│   ├── tailwind.config.js        ← Tailwind CSS configuration
│   ├── postcss.config.js         ← PostCSS configuration (required by Tailwind)
│   └── vite.config.js            ← Vite bundler configuration + API proxy setup
│
└── README.md                 ← This file
```

---

## Step-by-Step Setup

Follow these steps exactly, in order.

### Step 1 — Unzip the project

Unzip the downloaded `digital-second-brain.zip` file. You'll get a folder called `digital-second-brain`. Put it somewhere easy to find, like your Desktop.

---

### Step 2 — Configure the backend environment file

1. Open the `digital-second-brain/backend/` folder
2. Find the file called `.env`

   > **Note:** Files starting with a dot (`.env`) may be hidden on Mac. In Finder, press `Command + Shift + .` to show hidden files. On Windows, go to View → check "Hidden items".

3. Open `.env` in a text editor (Notepad on Windows, TextEdit on Mac, or VS Code)
4. It currently looks like this:
   ```
   PORT=5001
   MONGO_URI=mongodb://localhost:27017/digital_second_brain
   JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
   JWT_EXPIRE=7d
   ```
5. Replace the `MONGO_URI` line with the Atlas connection string you copied earlier:

   ```
   PORT=5001
   MONGO_URI=mongodb+srv://admin:YourActualPassword@cluster0.xxxxx.mongodb.net/digital_second_brain?retryWrites=true&w=majority
   JWT_SECRET=any_long_random_text_you_make_up_like_abc123xyz789
   JWT_EXPIRE=7d
   ```

   > **Important:**
   >
   > - Replace `YourActualPassword` with your Atlas database password
   > - Notice we added `/digital_second_brain` before the `?` — this is the database name
   > - Change the `JWT_SECRET` to any random text you like (it's used to sign login tokens)

6. Save the file

---

### Step 3 — Install backend packages

1. Open Terminal (Mac) or Command Prompt (Windows)
2. Navigate to the backend folder. Type the following and press Enter:

   **On Mac:**

   ```bash
   cd ~/Desktop/digital-second-brain/backend
   ```

   **On Windows:**

   ```bash
   cd C:\Users\YourName\Desktop\digital-second-brain\backend
   ```

   > Replace `YourName` with your actual Windows username

3. Now install all the required packages:

   ```bash
   npm install
   ```

   This will download and install: express, mongoose, bcryptjs, jsonwebtoken, cors, dotenv, multer, pdf-parse, and nodemon.

   You'll see a lot of text scrolling — this is normal. Wait until you see the command prompt again (usually takes 30–60 seconds).

---

### Step 4 — Install frontend packages

1. Open a **second Terminal/Command Prompt window** (keep the first one open)
2. Navigate to the frontend folder:

   **On Mac:**

   ```bash
   cd ~/Desktop/digital-second-brain/frontend
   ```

   **On Windows:**

   ```bash
   cd C:\Users\YourName\Desktop\digital-second-brain\frontend
   ```

3. Install frontend packages:

   ```bash
   npm install
   ```

   This installs: react, react-dom, react-router-dom, cytoscape, jspdf, axios, vite, tailwindcss, and more.

   Again, wait for the command prompt to return. This may take 1–2 minutes.

---

### Step 5 — Verify the vite.config.js proxy

Open `frontend/vite.config.js` and make sure it says port `5001`:

```js
proxy: {
  '/api': {
    target: 'http://localhost:5001',
    changeOrigin: true
  }
}
```

If it says `5000`, change it to `5001` and save.

---

## Running the App Every Time

Every time you want to use the app, you need to start both servers. You need **two Terminal windows open at the same time**.

### Terminal Window 1 — Start the Backend

```bash
cd path/to/digital-second-brain/backend
npm run dev
```

**What you should see:**

```
[nodemon] starting `node server.js`
✅ Connected to MongoDB
🚀 Server running on http://localhost:5001
```

If you see this, the backend is running correctly. **Do not close this terminal.**

If you see an error, check the [Common Errors](#common-errors-and-fixes) section below.

---

### Terminal Window 2 — Start the Frontend

```bash
cd path/to/digital-second-brain/frontend
npm run dev
```

**What you should see:**

```
  VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
```

**Do not close this terminal either.**

---

### Open the App in Your Browser

Go to: **http://localhost:5173**

You will see the login screen. Click "Register" to create an account, then log in.

---

## How to Use Each Feature

### Creating a Note

1. Type a title in the "Note title" field
2. Write your note content in the text area
3. Optionally select a subject category from the dropdown
4. Click **"Add Note"**
5. The backend automatically extracts keywords and finds related notes

### Uploading a Note from a File

1. In the "Upload Note" panel, either:
   - **Drag and drop** a `.txt` or `.pdf` file onto the dashed area, OR
   - **Click** the dashed area to browse your files
2. The app will extract the text and create a note automatically
3. The filename becomes the note's title

### Exporting Notes

- Click **"Export as PDF"** to download a formatted PDF with all your notes
- Click **"Export as JSON"** to download a JSON file (useful for backup or importing elsewhere)

### Viewing Related Notes

- Click any note card to select it
- The **Related Notes** panel on the right shows all notes that share keywords with it
- Shared keywords are highlighted in green

### Removing a Wrong Link

- Select a note by clicking it
- In the Related Notes panel, hover over any related note
- A small **✕** button appears in the top-right corner of that note
- Click **✕** to permanently remove the incorrect connection between the two notes
- The graph updates automatically

### Using the Knowledge Graph

- **Zoom**: Scroll up/down with your mouse wheel
- **Pan**: Click and drag on the background
- **Select a note**: Click on any node (circle)
- **Hover**: Hover over a node to see its title, category, and keywords
- **Color coding**: Nodes of the same color belong to the same topic cluster (they share a top keyword)
- The legend below the graph title shows which color corresponds to which topic

### Searching Notes

- Use the search bar above the notes grid
- Search by title, content, keywords, or category
- Results update instantly as you type

---

## How Everything Is Connected

Here is the complete picture of how the frontend, backend, and database talk to each other:

```
┌─────────────────────────────────────────────────────────────┐
│                     FRONTEND (React)                         │
│                   localhost:5173                             │
│                                                              │
│  LoginPage / RegisterPage                                    │
│       ↓ calls api/notes.js functions                        │
│  AuthContext (stores JWT token in localStorage)             │
│       ↓                                                      │
│  axiosInstance.js (adds JWT to every request automatically) │
└──────────────────────┬──────────────────────────────────────┘
                       │  HTTP Request to /api/...
                       │  (Vite proxy forwards to port 5001)
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                     BACKEND (Express)                        │
│                   localhost:5001                             │
│                                                              │
│  /api/auth/register → routes/auth.js → creates User in DB   │
│  /api/auth/login    → routes/auth.js → returns JWT token    │
│                                                              │
│  /api/notes         → routes/notes.js                       │
│       → middleware/auth.js verifies JWT first               │
│       → extractKeywords() from utils/keywords.js            │
│       → refreshAllRelations() recomputes all links          │
│       → buildColorMap() assigns colors by topic cluster     │
│                                                              │
│  /api/upload        → routes/upload.js                      │
│       → multer handles file upload                          │
│       → pdf-parse extracts text from PDF                    │
│       → creates a note automatically                        │
│                                                              │
│  /api/notes/graph   → returns {nodes, links} for graph      │
│  /api/notes/:id/relations/:rid → removes a specific link    │
└──────────────────────┬──────────────────────────────────────┘
                       │  Mongoose ODM
                       ↓
┌─────────────────────────────────────────────────────────────┐
│                  MongoDB Atlas (Cloud)                       │
│                                                              │
│  Collection: users  → { username, email, hashedPassword }   │
│  Collection: notes  → { title, content, keywords, color,    │
│                          category, relatedNotes, userId }   │
└─────────────────────────────────────────────────────────────┘
```

---

## Common Errors and Fixes

| Error Message                                       | What It Means                                       | How to Fix                                                                                     |
| --------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `✅ Connected to MongoDB` then `EADDRINUSE :::5001` | Port 5001 is taken by another program               | Change `PORT=5001` to `PORT=5002` in `.env`, and update `vite.config.js` target to `5002`      |
| `MongoServerError: bad auth`                        | Wrong Atlas password in `.env`                      | Double-check the password in your MONGO_URI in `.env`                                          |
| `connect ECONNREFUSED`                              | Atlas IP not whitelisted                            | Go to Atlas → Network Access → Add Current IP Address                                          |
| `Cannot find module 'express'`                      | Backend packages not installed                      | Run `npm install` inside the `backend/` folder                                                 |
| `Cannot find module 'react'`                        | Frontend packages not installed                     | Run `npm install` inside the `frontend/` folder                                                |
| `Login failed. Please try again.`                   | Backend not running, or wrong credentials           | Make sure backend terminal shows `🚀 Server running`, then try registering first               |
| White screen / blank page                           | JavaScript error in React                           | Press F12 → Console tab → Read the red error message                                           |
| Graph not showing                                   | Less than 2 notes, or notes have no shared keywords | Add at least 2 notes that share topic words (e.g., both about "physics" or "machine learning") |
| Upload says "Could not extract text"                | PDF is a scanned image, not text-based              | Only text-based PDFs work. Scanned/image PDFs cannot have text extracted without OCR           |
| `Registration failed`                               | Email or username already taken                     | Try a different email/username, or log in if you already have an account                       |

---

## API Endpoints Reference

| Method | Endpoint                            | Auth Required | What It Does                                           |
| ------ | ----------------------------------- | ------------- | ------------------------------------------------------ |
| POST   | /api/auth/register                  | No            | Create a new user account                              |
| POST   | /api/auth/login                     | No            | Login, returns JWT token                               |
| GET    | /api/notes                          | Yes           | Get all notes for logged-in user                       |
| POST   | /api/notes                          | Yes           | Create a note (auto-extracts keywords + assigns color) |
| PUT    | /api/notes/:id                      | Yes           | Edit a note (re-extracts keywords)                     |
| DELETE | /api/notes/:id                      | Yes           | Delete a note + clean up all links                     |
| GET    | /api/notes/graph                    | Yes           | Get graph data `{nodes, links}` for Cytoscape          |
| GET    | /api/notes/:id                      | Yes           | Get one specific note                                  |
| DELETE | /api/notes/:id/relations/:relatedId | Yes           | Remove a specific link between two notes               |
| POST   | /api/upload                         | Yes           | Upload a .txt or .pdf and create a note from it        |

---

## Tech Stack Summary

| Layer        | Technology           | Purpose                                     |
| ------------ | -------------------- | ------------------------------------------- |
| Frontend UI  | React.js 18          | Component-based user interface              |
| Styling      | Tailwind CSS         | Utility-first CSS framework                 |
| Build Tool   | Vite                 | Fast development server and bundler         |
| Graph        | Cytoscape.js         | Interactive knowledge graph visualization   |
| PDF Export   | jsPDF                | Generate PDF files in the browser           |
| HTTP Client  | Axios                | API calls with auto JWT attachment          |
| Routing      | React Router v6      | Client-side page navigation                 |
| Backend      | Node.js + Express.js | REST API server                             |
| Database ORM | Mongoose             | MongoDB object modeling for Node.js         |
| Database     | MongoDB Atlas        | Cloud NoSQL database                        |
| Auth         | JWT + bcryptjs       | Stateless authentication + password hashing |
| File Upload  | Multer               | Multipart form data handling                |
| PDF Parsing  | pdf-parse            | Extract text from PDF files server-side     |
| NLP          | Custom (keywords.js) | Keyword extraction with stopword filtering  |
