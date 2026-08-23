require('dotenv').config();

// Phase 6.1 — MUST come before express/http are required. The HTTP and Express
// instrumentations patch those modules as they load, so starting the SDK after
// `require('express')` silently yields no server spans: an install that looks
// correct and a Jaeger UI that stays empty. dotenv is allowed to run first
// because it loads only fs/path, and reading backend/.env is what lets
// DSB_TRACING be set there. OFF unless DSB_TRACING=1 — see observability/sdk.js.
require('./observability/sdk').startTracing();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const noteRoutes = require('./routes/notes');
const uploadRoutes = require('./routes/upload');
const llmRoutes = require('./routes/llm');
const studyPackRoutes = require('./routes/studyPack');
const graphRoutes = require('./routes/graph');
const searchRoutes = require('./routes/search');
const exportRoutes = require('./routes/export');

const app = express();

// The Origin header is attacker-controlled, so a substring test is not a
// check: `origin.includes('vercel.app')` accepted evil-vercel.app.attacker.com.
// Compare the full origin against an exact allowlist instead.
//
// The deployed frontend is baked in rather than required from the environment.
// A public hostname is not a secret, and the failure mode of a missing env var
// here is a totally broken production app, which is a bad thing to make
// configurable. CORS_ALLOWED_ORIGINS adds to this list; it never replaces it.
const DEFAULT_ORIGINS = [
  'https://taneesha-digital-second-brain.vercel.app',
  'http://localhost:5173',
  'http://localhost:4173'
];

const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .concat(DEFAULT_ORIGINS)
);

app.use(cors({
  origin: function(origin, callback) {
    // No Origin header — same-origin navigations, curl, health checks.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    const err = new Error('Not allowed by CORS');
    err.status = 403;
    return callback(err);
  },
  credentials: true,
  // So the export download can read the server-chosen filename.
  exposedHeaders: ['Content-Disposition']
}));
app.use(express.json());

app.use('/api/auth', authRoutes); // NO protect here
app.use('/api/notes', noteRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/llm', llmRoutes);
// Phase 5.1 — the retrieval-to-generation join. A SEPARATE mount from /api/llm,
// which is left byte-identical because its five features are 5.1's A/B control.
app.use('/api/study-pack', studyPackRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/export', exportRoutes);

app.get('/', (req, res) => res.json({ message: 'Digital Second Brain API v2 is running' }));

// A rejected Origin is a policy decision, not a server fault. Without this the
// error from the CORS callback falls through to Express's default handler and
// answers 500 with a stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('Unhandled error:', err);
  res.status(status).json({ message: status === 403 ? 'Origin not allowed' : 'Internal server error' });
});

const PORT      = process.env.PORT      || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/digital_second_brain';

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });
