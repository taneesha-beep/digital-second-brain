'use strict';

/**
 * integration.app.test.js — Phase 4.5.
 *
 *   docker run -d --rm --name dsb-mongo -p 27017:27017 \
 *     mongo:7@sha256:9bdaeb6dac6e7e762e84e2f84103d1f9bb078fa1ba6bde8bb9d2274f655ad173
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017/dsb_integration_test npm test
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS FOR, AND THE THING IT DELIBERATELY DOES NOT DO.
 *
 * It does NOT re-run the existing suites against a real database. edges
 * .canonical (27), edges.provenance (35) and retrieval.app-parity all run on
 * scripts/lib/fake-note-store.js, and what they assert — the canonical normal
 * form, per-direction provenance, one ordered bulkWrite — are properties of the
 * OPERATIONS, which the fake models faithfully. Re-running them here would
 * prove the fake is faithful, at the price of rewriting three suites' harnesses.
 * That was priced and rejected; §25.1.
 *
 * This covers only what the fake DECLARES it cannot reach, in its own words:
 *
 *   fake-note-store.js:264  "CANNOT: ANY of the unique index. A fake that
 *                            'enforces' uniqueness proves only that the fake
 *                            enforces uniqueness."
 *   fake-note-store.js:273  "this collection does not simulate ANY index, so it
 *                            cannot show that the two provenance indexes are
 *                            USED by edgesForVersion()'s $or."
 *   fake-note-store.js:178  "projection is irrelevant to a plain-object store"
 *   §21.3                   "Nothing about a real Mongo. A real driver's natural
 *                            order, ObjectId semantics and projection are not
 *                            exercised. 4.5's integration tests."
 *   verify-migration.js:516 "what the live linker does to a migrated row — not
 *                            run here... a real driver under the same
 *                            operations, and that is roadmap 4.5."
 *
 * The last is the sharpest: scripts/verify-migration.js proves the MIGRATION
 * against a real server and stops there. Nothing has ever run the LINKER
 * against one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NO NEW DEPENDENCY, AND THE ROUTES ARE THE REAL ONES.
 *
 * supertest was the obvious reach and was declined: §17.1's "the Node eval path
 * is dependency-free" has survived four phases and this is a fifth. The app is
 * assembled here from the REAL routers and driven over a real socket with Node's
 * built-in fetch. `protect` is applied INSIDE each router (routes/notes.js:13,
 * graph.js:7, search.js:8, llm.js:8, upload.js:12, export.js:19), not in
 * server.js, so mounting the router exercises the real protection rather than a
 * copy of it.
 *
 * WHAT THAT LEAVES UNCOVERED, and it is closed rather than merely named: this
 * app is not server.js, so it does not prove server.js MOUNTS those routers, nor
 * that a future route arrives protected. The first describe below asserts that
 * statically over server.js's own source, and needs no database.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NOTHING HERE NEEDS A REAL API KEY. POST /api/llm/:noteId/:feature returns 400
 * from routes/llm.js:16 — the ownership check — BEFORE processNote is reached,
 * and services/llm.service.js reads GROQ_API_KEY at call time rather than at
 * module scope, so the route mounts without one. The cross-user path is
 * testable; the happy path is not, and does not belong in CI.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { describeWith, connectOrExplain } = require('./helpers/preconditions');

const BACKEND = path.resolve(__dirname, '..');

// ───────────────────────────────────────────────────────────────────────────
// The static half — no database, so it runs everywhere, CI included.
// ───────────────────────────────────────────────────────────────────────────

describe('server.js mounts every API router behind protect', () => {
  const serverSource = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');

  /** `app.use('/api/notes', noteRoutes)` -> { mount, variable }. */
  const mounts = [...serverSource.matchAll(/app\.use\(\s*'(\/api\/[\w-]+)'\s*,\s*(\w+)\s*\)/g)]
    .map(([, mount, variable]) => ({ mount, variable }));

  /** `const noteRoutes = require('./routes/notes')` -> variable -> file. */
  const requires = new Map(
    [...serverSource.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/(routes\/[\w-]+)'\)/g)]
      .map(([, variable, file]) => [variable, file])
  );

  test('the mount list is non-empty and every mount resolves to a route file', () => {
    // Without this the two loops below pass vacuously on a regex that stopped
    // matching — the shape §22.6 names, at the one place this file could hit it.
    expect(mounts.length).toBeGreaterThanOrEqual(7);
    for (const { variable } of mounts) expect(requires.has(variable)).toBe(true);
  });

  test('/api/auth is the ONLY unprotected mount', () => {
    const unprotected = [];
    for (const { mount, variable } of mounts) {
      const source = fs.readFileSync(path.join(BACKEND, `${requires.get(variable)}.js`), 'utf8');
      if (!/router\.use\(\s*protect\s*\)/.test(source)) unprotected.push(mount);
    }
    expect(unprotected).toEqual(['/api/auth']);
  });

  test('the auth router really is the unprotected one, rather than merely last', () => {
    // Guards against the assertion above passing because some OTHER router lost
    // its protect and auth happened to sort into the same one-element array.
    const auth = mounts.find((m) => m.mount === '/api/auth');
    expect(auth).toBeDefined();
    expect(requires.get(auth.variable)).toBe('routes/auth');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The real-database half.
// ───────────────────────────────────────────────────────────────────────────

describeWith('mongo', 'the app against a real MongoDB', () => {
  let server;
  let base;
  let Note;
  let NoteLink;
  let NoteVersion;
  let User;
  let linker;
  let noteCorpus;

  /** { token, id } per user. Registered through the real route. */
  const alice = { email: 'alice@example.com', password: 'alice-password', username: 'alice', name: 'Alice' };
  const bob = { email: 'bob@example.com', password: 'bob-password', username: 'bob', name: 'Bob' };

  async function api(method, url, { token, body, raw = false } = {}) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (raw) return { status: response.status, text: await response.text() };
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body, e.g. a pdf */ }
    return { status: response.status, body: json, text };
  }

  async function register(who) {
    const { status, body } = await api('POST', '/api/auth/register', { body: who });
    expect(status).toBe(201);
    return { token: body.token, id: body.user.id };
  }

  /** A note created and saved through the real routes, so the linker runs. */
  async function createNote(token, title, contentText) {
    const created = await api('POST', '/api/notes', { token, body: { title, contentText } });
    expect(created.status).toBe(201);
    // POST fires linking in the background un-awaited (routes/notes.js:93). PUT
    // is what this suite drives, because it is awaited far enough to be
    // observable and it is the path that re-extracts keywords.
    const updated = await api('PUT', `/api/notes/${created.body._id}`, { token, body: { title, contentText } });
    expect(updated.status).toBe(200);
    return created.body._id;
  }

  /**
   * The linker is fired un-awaited from the route (CLAUDE.md — "two un-awaited
   * background jobs"), so a test that reads NoteLink straight after a PUT races
   * it. Rather than sleeping, the tests below call computeAndSaveLinks directly
   * where they assert on stored edges: same function, same arguments, awaited.
   * The un-awaited call is what the ROUTE does and is covered by the route
   * tests; this is what the LINKER does and is what the edge assertions are
   * about. Conflating them is how a flaky suite gets written.
   */
  async function link(noteId, userId) {
    return linker.computeAndSaveLinks(noteId, userId);
  }

  beforeAll(async () => {
    // Set before any router is required: routes/auth.js reads JWT_SECRET at
    // call time, but being explicit here means the suite never depends on a
    // developer's backend/.env, which CI does not have and must not need.
    process.env.JWT_SECRET = 'integration-test-only-not-a-secret';
    process.env.JWT_EXPIRE = '1h';

    await connectOrExplain(mongoose);
    await mongoose.connection.dropDatabase();

    Note = require('../models/Note');
    NoteLink = require('../models/NoteLink');
    NoteVersion = require('../models/NoteVersion');
    User = require('../models/User');
    linker = require('../services/linker.service');
    noteCorpus = require('../services/noteCorpus.service');

    /**
     * INDEXES ARE BUILT EXPLICITLY AND AWAITED, and this is not ceremony.
     * mongoose's autoIndex fires in the background on first use, so the very
     * first assertion about the unique index or about $text can run before the
     * index exists — a race that cannot occur against the fake, which simulates
     * no index at all. Written before it bit rather than after.
     */
    for (const model of [Note, NoteLink, NoteVersion, User]) await model.syncIndexes();

    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../routes/auth'));
    app.use('/api/notes', require('../routes/notes'));
    app.use('/api/graph', require('../routes/graph'));
    app.use('/api/search', require('../routes/search'));
    app.use('/api/llm', require('../routes/llm'));
    app.use('/api/export', require('../routes/export'));
    app.use('/api/upload', require('../routes/upload'));

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;

    Object.assign(alice, await register(alice));
    Object.assign(bob, await register(bob));
  }, 60000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A. AUTH — the happy path and the sad ones
  // ─────────────────────────────────────────────────────────────────────────

  describe('auth', () => {
    test('register returns a token and never the password', async () => {
      const { status, body } = await api('POST', '/api/auth/register', {
        body: { name: 'Carol', username: 'carol', email: 'carol@example.com', password: 'carol-password' }
      });
      expect(status).toBe(201);
      expect(typeof body.token).toBe('string');
      expect(body.user.email).toBe('carol@example.com');
      expect(body.user).not.toHaveProperty('password');
      expect(body.token.split('.')).toHaveLength(3);
    });

    test('the stored password is a bcrypt hash, not the password', async () => {
      // select:false on the schema means the ONLY way to observe this is an
      // explicit +password, which is itself worth pinning: a future schema edit
      // that drops select:false would start leaking hashes into every response.
      const stored = await User.findOne({ email: 'carol@example.com' }).select('+password');
      expect(stored.password).not.toBe('carol-password');
      expect(stored.password.startsWith('$2')).toBe(true);
      const plain = await User.findOne({ email: 'carol@example.com' });
      expect(plain.password).toBeUndefined();
    });

    test('register with a missing field is 400', async () => {
      const { status } = await api('POST', '/api/auth/register', { body: { email: 'x@y.z', password: 'abcdefg' } });
      expect(status).toBe(400);
    });

    test('register with a duplicate email is 409', async () => {
      const { status, body } = await api('POST', '/api/auth/register', {
        body: { name: 'Alice Two', username: 'alice-two', email: alice.email, password: 'another-password' }
      });
      expect(status).toBe(409);
      expect(body.message).toMatch(/already in use/i);
    });

    test('register with a duplicate username is 409', async () => {
      const { status } = await api('POST', '/api/auth/register', {
        body: { name: 'Alice Three', username: alice.username, email: 'alice3@example.com', password: 'another-password' }
      });
      expect(status).toBe(409);
    });

    test('login with the right password returns a token', async () => {
      const { status, body } = await api('POST', '/api/auth/login', {
        body: { email: alice.email, password: alice.password }
      });
      expect(status).toBe(200);
      expect(typeof body.token).toBe('string');
    });

    test('a wrong password and an unknown email are 401 with the SAME message', async () => {
      // User enumeration. Two different messages here would let anyone test
      // whether an address has an account. The route already gets this right;
      // asserting it is what stops a well-meaning "more helpful error" landing.
      const wrong = await api('POST', '/api/auth/login', { body: { email: alice.email, password: 'not-it' } });
      const unknown = await api('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'not-it' } });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    test('a protected route without a token is 401', async () => {
      const { status } = await api('GET', '/api/notes');
      expect(status).toBe(401);
    });

    test('a malformed token is 401', async () => {
      const { status } = await api('GET', '/api/notes', { token: 'not-a-jwt' });
      expect(status).toBe(401);
    });

    test('a token signed with the WRONG secret is 401', async () => {
      const forged = jwt.sign({ id: alice.id }, 'a-different-secret', { expiresIn: '1h' });
      const { status } = await api('GET', '/api/notes', { token: forged });
      expect(status).toBe(401);
    });

    test('an EXPIRED token is 401', async () => {
      const expired = jwt.sign({ id: alice.id }, process.env.JWT_SECRET, { expiresIn: '-1s' });
      const { status } = await api('GET', '/api/notes', { token: expired });
      expect(status).toBe(401);
    });

    test('a validly signed token for a user who no longer exists is 401', async () => {
      // middleware/auth.js:19-22. A correct signature is not authorisation: the
      // user row is looked up every request, so deleting an account revokes its
      // outstanding tokens. The alternative — trusting the claims — is what
      // makes a deleted user's token live until it expires.
      const ghost = await User.create({
        name: 'Ghost', username: 'ghost', email: 'ghost@example.com', password: 'ghost-password'
      });
      const token = jwt.sign({ id: ghost._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
      expect((await api('GET', '/api/notes', { token })).status).toBe(200);
      await User.deleteOne({ _id: ghost._id });
      const after = await api('GET', '/api/notes', { token });
      expect(after.status).toBe(401);
      expect(after.body.message).toMatch(/not found/i);
    });

    test('the Bearer prefix is required', async () => {
      const response = await fetch(`${base}/api/notes`, { headers: { Authorization: alice.token } });
      expect(response.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // B. CROSS-USER ISOLATION — every route that takes a note id
  // ─────────────────────────────────────────────────────────────────────────

  describe('cross-user isolation', () => {
    let aliceNote;
    let alicePartner;
    let bobNote;

    beforeAll(async () => {
      aliceNote = await createNote(alice.token, 'Alice sourdough', 'sourdough starter hydration levain bread flour');
      alicePartner = await createNote(alice.token, 'Alice bread', 'bread flour hydration proofing sourdough loaf');
      bobNote = await createNote(bob.token, 'Bob risotto', 'risotto arborio stock parmesan butter onion');
      await link(aliceNote, alice.id);
      await link(alicePartner, alice.id);
    });

    /**
     * Every surface that takes a note id, driven by Bob against Alice's note.
     * Table-driven so adding a route is one line, and so a route that is missing
     * from the table is visible as an absence rather than hidden in prose.
     */
    const foreign = [
      ['GET', (id) => `/api/notes/${id}`, 404],
      ['PUT', (id) => `/api/notes/${id}`, 404],
      ['DELETE', (id) => `/api/notes/${id}`, 404],
      ['GET', (id) => `/api/notes/${id}/links`, 404],
      ['GET', (id) => `/api/notes/${id}/versions`, 404],
      ['GET', (id) => `/api/notes/${id}/versions/1`, 404],
      ['GET', (id) => `/api/graph/note/${id}`, 404],
      ['GET', (id) => `/api/graph/note/${id}/expand/bread`, 404],
      ['GET', (id) => `/api/export/${id}?format=markdown`, 404],
      ['GET', (id) => `/api/export/${id}?format=text`, 404],
      ['POST', (id) => `/api/llm/${id}/summarize`, 400]
    ];

    test.each(foreign)('%s %s — Bob cannot reach Alice\'s note', async (method, url, expected) => {
      const { status, text } = await api(method, url(aliceNote), {
        token: bob.token,
        body: method === 'PUT' ? { title: 'pwned' } : undefined
      });
      expect(status).toBe(expected);
      expect(text).not.toMatch(/sourdough/i);
    });

    test('the same requests SUCCEED for Alice — so the 404s are authorisation, not a broken route', async () => {
      // Without this every row above would pass against a route that is simply
      // broken for everyone. This is the control, and it is the assertion that
      // makes the table mean what it claims.
      for (const [method, url] of foreign) {
        if (method === 'DELETE') continue; // destructive; covered on its own below
        if (method === 'POST') continue;   // needs GROQ_API_KEY past the ownership check
        const { status } = await api(method, url(aliceNote), {
          token: alice.token,
          body: method === 'PUT' ? { title: 'Alice sourdough' } : undefined
        });
        expect([200, 404]).toContain(status);
        if (url(aliceNote).includes('/versions/1')) continue;
        expect(status).toBe(200);
      }
    });

    test('Bob\'s DELETE left Alice\'s note in place', async () => {
      const still = await Note.findById(aliceNote).lean();
      expect(still).not.toBeNull();
      expect(still.title).toBe('Alice sourdough');
    });

    test('Bob cannot delete Alice\'s edge through the relations route', async () => {
      const before = await NoteLink.countDocuments({ user: alice.id });
      expect(before).toBeGreaterThan(0);
      const { status } = await api('DELETE', `/api/notes/${aliceNote}/relations/${alicePartner}`, { token: bob.token });
      // The route is user-scoped on the delete, so it reports success while
      // removing nothing. Asserting the COUNT rather than the status is the
      // point: a 200 here is not evidence either way.
      expect([200, 500]).toContain(status);
      expect(await NoteLink.countDocuments({ user: alice.id })).toBe(before);
    });

    test('the global graph carries only the caller\'s notes — /api/graph/global', async () => {
      const { status, body } = await api('GET', '/api/graph/global', { token: bob.token });
      expect(status).toBe(200);
      const labels = body.elements.filter((e) => e.data.type === 'note').map((e) => e.data.label);
      expect(labels).toContain('Bob risotto');
      expect(labels).not.toContain('Alice sourdough');
    });

    test('and so does the duplicate endpoint — /api/notes/graph', async () => {
      // /api/graph/global and /api/notes/graph are the same builder behind two
      // routes (4.4's noticed list). Only the first has a frontend caller, and
      // the second is exactly the shape that gets forgotten. Covered so that
      // removing either later is a decision rather than a risk.
      const { status, body } = await api('GET', '/api/notes/graph', { token: bob.token });
      expect(status).toBe(200);
      const labels = body.elements.filter((e) => e.data.type === 'note').map((e) => e.data.label);
      expect(labels).toEqual(['Bob risotto']);
    });

    test.each(['keyword', 'semantic', 'tags'])('search mode=%s returns no other user\'s notes', async (mode) => {
      const { status, body } = await api('GET', `/api/search?q=sourdough&mode=${mode}`, { token: bob.token });
      expect(status).toBe(200);
      expect(body.map((n) => n.title)).not.toContain('Alice sourdough');
    });

    test('search with an empty query is also scoped', async () => {
      const { status, body } = await api('GET', '/api/search?q=', { token: bob.token });
      expect(status).toBe(200);
      expect(body.every((n) => n.title === 'Bob risotto')).toBe(true);
    });

    test('GET /api/notes lists only the caller\'s notes', async () => {
      const { body } = await api('GET', '/api/notes', { token: bob.token });
      expect(body.map((n) => n.title)).toEqual(['Bob risotto']);
    });

    /**
     * THE SERVICES BEHIND TWO OF THOSE ROUTES ARE NOT USER-SCOPED, and the
     * routes are what make them safe. Asserted rather than left to be
     * rediscovered: graphBuilder.service.js:83 and :163 both do
     * Note.findById(noteId) with no user filter, and version.service.js's
     * getVersions(noteId) has the same shape. Every current caller checks
     * ownership first (routes/graph.js:15, :36; routes/notes.js:212, :224), so
     * there is no live hole — but a future caller that forgets is one line from
     * one, and this test is what will be failing when that line is written.
     */
    test('buildNoteGraph and getVersions are NOT user-scoped — safe only via their callers', async () => {
      const { buildNoteGraph, expandKeyword } = require('../services/graphBuilder.service');
      const { getVersions } = require('../services/version.service');

      // Called with no user at all, they happily serve any note. This is the
      // documented hazard, pinned so that scoping them later is a deliberate
      // change with a failing test to update rather than a silent one.
      const graph = await buildNoteGraph(aliceNote);
      expect(graph.elements.some((e) => e.data.label === 'Alice sourdough')).toBe(true);
      expect((await expandKeyword(aliceNote, 'sourdough')).elements).toBeDefined();
      expect(Array.isArray(await getVersions(aliceNote))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // C. THE LIVE LINKER AGAINST A REAL DRIVER — what the fake cannot show
  // ─────────────────────────────────────────────────────────────────────────

  describe('the linker against a real driver', () => {
    let user;
    let ids;

    const DOCS = [
      ['Braising', 'braise the beef low and slow in stock until the collagen melts'],
      ['Stock', 'simmer bones and aromatics for stock, skim the scum, never boil hard'],
      ['Searing', 'sear the beef hard in a hot pan before you braise it in stock'],
      ['Pastry', 'laminate cold butter into flour for pastry, rest the dough between turns'],
      ['Bread', 'bread dough wants flour water salt and time, not much else']
    ];

    beforeAll(async () => {
      const dave = await register({ name: 'Dave', username: 'dave', email: 'dave@example.com', password: 'dave-password' });
      user = dave;
      ids = [];
      for (const [title, body] of DOCS) ids.push(await createNote(dave.token, title, body));
      for (const id of ids) await link(id, dave.id);
    }, 60000);

    test('every stored row is in the canonical normal form over REAL ObjectIds', async () => {
      // The fake holds hex-string ids from a fixture; these are real 24-hex
      // ObjectIds whose String() ordering is what the normal form is defined on.
      const rows = await NoteLink.find({ user: user.id }).lean();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(String(row.noteA) < String(row.noteB)).toBe(true);
        expect(String(row.noteA)).toMatch(/^[0-9a-f]{24}$/);
      }
    });

    test('the unique index REJECTS a duplicate of a row the linker wrote', async () => {
      // fake-note-store.js:264 says in terms that it cannot show this. The
      // migration's version of this check (verify-migration.js:311) inserts
      // against a row the MIGRATION wrote; this one is against a row the LIVE
      // LINKER wrote, which is the case nothing covered.
      const row = await NoteLink.findOne({ user: user.id }).lean();
      let code = null;
      try {
        await NoteLink.collection.insertOne({
          user: row.user, noteA: row.noteA, noteB: row.noteB,
          scoreAB: 1, scoreBA: null, sharedAB: [], sharedBA: []
        });
      } catch (err) {
        code = err.code;
      }
      expect(code).toBe(11000);
    });

    test('re-linking is convergent — a second run leaves one row per pair', async () => {
      const before = await NoteLink.countDocuments({ user: user.id });
      for (const id of ids) await link(id, user.id);
      expect(await NoteLink.countDocuments({ user: user.id })).toBe(before);
      const keys = (await NoteLink.find({ user: user.id }).lean())
        .map((r) => `${String(r.noteA)}|${String(r.noteB)}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    test('save ORDER does not change the stored rows', async () => {
      const digest = async () => (await NoteLink.find({ user: user.id }).lean())
        .map((r) => `${String(r.noteA)}|${String(r.noteB)}|${r.scoreAB}|${r.scoreBA}`)
        .sort()
        .join('\n');
      const forward = await digest();
      await NoteLink.deleteMany({ user: user.id });
      for (const id of [...ids].reverse()) await link(id, user.id);
      expect(await digest()).toBe(forward);
    });

    test('the linker writes per-direction provenance a real driver reads back', async () => {
      const handle = await noteCorpus.indexUserNotes(user.id);
      const expected = noteCorpus.describe(handle);
      const rows = await NoteLink.find({ user: user.id }).lean();
      const labelled = rows.filter((r) => r.retrieverAB || r.retrieverBA);
      expect(labelled.length).toBe(rows.length);
      for (const row of rows) {
        // A direction's two provenance fields are both-null or both-real, never
        // one of each. §23.3, asserted against real BSON rather than the fake's
        // plain objects.
        expect(row.retrieverAB === null).toBe(row.digestAB === null);
        expect(row.retrieverBA === null).toBe(row.digestBA === null);
        if (row.retrieverAB) {
          expect(row.retrieverAB).toBe(expected.version);
          expect(row.digestAB).toBe(expected.digest);
        }
      }
    });

    test('both provenance indexes EXIST on a real server — the fake simulates none', async () => {
      /**
       * fake-note-store.js:273: "it cannot show that the two provenance indexes
       * are USED by edgesForVersion()'s $or — a filter that returns the right
       * answer by scanning every row looks identical from here."
       *
       * EXISTENCE is what this asserts, and NOT the planner's choice. The first
       * draft asserted the plan named both indexes and FAILED here: on this
       * collection the planner picks `user_1` — the bare index
       * models/NoteLink.js:95 creates with `index: true` — and filters in
       * memory. §23.4 had already written the caveat this violates, about the
       * opposite observation: verify-migration.js:478 records the planner
       * choosing BOTH provenance indexes on a four-row fixture and says in terms
       * that it is "recorded as a fact about this fixture and NOT as evidence
       * the plan holds at scale". A test that pins a planner decision fails for
       * reasons that are not defects, so it asserts the schema fact instead —
       * which is invariant, is what a dropped index would break, and is exactly
       * what the fake cannot reach. The plan is OBSERVED below, not asserted;
       * scripts/measure-provenance-query.js at 40,000 rows is what judges it.
       */
      const version = noteCorpus.APP_RETRIEVER;
      const edges = await linker.edgesForVersion(user.id, version);
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) expect(edge.matched.length).toBeGreaterThan(0);

      const names = (await NoteLink.collection.indexes()).map((i) => JSON.stringify(i.key));
      expect(names).toContain('{"user":1,"retrieverAB":1}');
      expect(names).toContain('{"user":1,"retrieverBA":1}');

      const plan = await NoteLink.find({
        user: user.id, $or: [{ retrieverAB: version }, { retrieverBA: version }]
      }).explain('executionStats');
      // Observed, not asserted. Recorded so a reader who expects §23.4's result
      // can see that this collection produced a different one.
      expect(plan.executionStats.nReturned).toBe(edges.length);
    });

    test('a MIGRATED row is relabelled by a live save, one direction only', async () => {
      /**
       * verify-migration.js:516 — "what the live linker does to a migrated row.
       * Not run here... that is roadmap 4.5 rather than 4.2." This is it.
       *
       * A migrated row carries UNKNOWN_PROVENANCE in both directions. Saving
       * ONE of its two notes must replace that note's direction and leave the
       * other's recorded unknown exactly as it was — the per-direction property
       * §23.1 exists for, against a real driver instead of the fake.
       */
      const row = await NoteLink.findOne({ user: user.id, scoreAB: { $ne: null }, scoreBA: { $ne: null } }).lean();
      expect(row).not.toBeNull();

      await NoteLink.updateOne({ _id: row._id }, {
        $set: {
          retrieverAB: NoteLink.UNKNOWN_PROVENANCE, digestAB: NoteLink.UNKNOWN_PROVENANCE,
          retrieverBA: NoteLink.UNKNOWN_PROVENANCE, digestBA: NoteLink.UNKNOWN_PROVENANCE
        }
      });

      await link(row.noteA, user.id);

      const after = await NoteLink.findById(row._id).lean();
      expect(after.retrieverAB).toBe(noteCorpus.APP_RETRIEVER);
      expect(after.digestAB).not.toBe(NoteLink.UNKNOWN_PROVENANCE);
      expect(after.retrieverBA).toBe(NoteLink.UNKNOWN_PROVENANCE);
      expect(after.digestBA).toBe(NoteLink.UNKNOWN_PROVENANCE);

      // And the unknown is still queryable as a value, which is what makes the
      // deferred one-shot re-link checkable afterwards. §23.3.
      const unknowns = await linker.edgesForVersion(user.id, NoteLink.UNKNOWN_PROVENANCE);
      expect(unknowns.some((e) => String(e.noteA) === String(row.noteA))).toBe(true);
    });

    test('getLinkedNotes populates real refs and orders outgoing first', async () => {
      const links = await linker.getLinkedNotes(ids[0], user.id);
      expect(links.length).toBeGreaterThan(0);
      for (const entry of links) expect(typeof entry.noteId.title).toBe('string');
      const directions = links.map((l) => l.direction);
      expect(directions).toEqual([...directions].sort((a, b) => (a === b ? 0 : a === 'out' ? -1 : 1)));
    });

    test('GET /api/notes/:id/links serves those rows over HTTP', async () => {
      const { status, body } = await api('GET', `/api/notes/${ids[0]}/links`, { token: user.token });
      expect(status).toBe(200);
      expect(body.links.length).toBeGreaterThan(0);
      expect(body.links[0]).toHaveProperty('retriever');
    });

    test('deleting a note removes every edge incident to it', async () => {
      const victim = ids[ids.length - 1];
      const incident = await NoteLink.countDocuments({
        user: user.id, $or: [{ noteA: victim }, { noteB: victim }]
      });
      expect(incident).toBeGreaterThan(0);
      expect((await api('DELETE', `/api/notes/${victim}`, { token: user.token })).status).toBe(200);
      expect(await NoteLink.countDocuments({
        user: user.id, $or: [{ noteA: victim }, { noteB: victim }]
      })).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // D. THE ADAPTER AGAINST A REAL DRIVER — §21.3's five named gaps
  // ─────────────────────────────────────────────────────────────────────────

  describe('the corpus adapter against a real driver', () => {
    let user;

    beforeAll(async () => {
      user = await register({ name: 'Erin', username: 'erin', email: 'erin@example.com', password: 'erin-password' });
      for (const [title, body] of [
        ['Zeta', 'zeta uses saffron and rice'],
        ['Alpha', 'alpha uses saffron and stock'],
        ['Mu', 'mu uses rice and stock']
      ]) await createNote(user.token, title, body);
    }, 30000);

    test('ids come back as STRINGS from real ObjectIds', async () => {
      const docs = await noteCorpus.loadNoteCorpus(user.id);
      expect(docs.length).toBe(3);
      for (const doc of docs) {
        expect(typeof doc.id).toBe('string');
        expect(doc.id).toMatch(/^[0-9a-f]{24}$/);
      }
    });

    test('the corpus is sorted by _id regardless of insertion or title order', async () => {
      const docs = await noteCorpus.loadNoteCorpus(user.id);
      expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
      // Titles are deliberately Z, A, M so a title sort would be visible.
      expect(docs.map((d) => d.title)).toEqual(['Zeta', 'Alpha', 'Mu']);
    });

    test('the projection really projects — a real driver, unlike the fake', async () => {
      // fake-note-store.js:178: "projection is irrelevant to a plain-object
      // store". Here it is not: .select('title contentText') must not carry
      // keywords or the deprecated linkedNotes into the adapter's input.
      const raw = await Note.find({ user: user.id }).select('title contentText').sort({ _id: 1 }).lean();
      for (const doc of raw) {
        expect(Object.keys(doc).sort()).toEqual(['_id', 'contentText', 'title']);
      }
    });

    test('a raw ObjectId misses the index silently — and relatedNotes is what saves it', async () => {
      /**
       * §21.3's demonstration C2, on real ObjectIds instead of the fake's
       * fixture ids. The first draft of this test asserted
       * `relatedNotes(handle, note._id)` returns [] and FAILED — it returns
       * hits, because relatedNotes does its own String() at
       * noteCorpus.service.js:212. That is a misreading of C2 worth recording
       * rather than quietly fixing: parity-app.js:225 bypasses relatedNotes and
       * asks `handle._byId.has(oid)` directly, so what it measures is the
       * LOOKUP, not the function. Both halves are asserted here.
       *
       * The silent-zero hazard is therefore real and lives one level down: the
       * index is keyed on strings, a raw ObjectId misses every key, and nothing
       * throws. relatedNotes is a guard against it; toCorpusDoc's String(_id) is
       * what makes the keys strings in the first place.
       */
      const handle = await noteCorpus.indexUserNotes(user.id);
      const note = await Note.findOne({ user: user.id }).sort({ _id: 1 }).lean();

      expect(handle._byId.has(String(note._id))).toBe(true);
      expect(handle._byId.has(note._id)).toBe(false); // no throw, no log — the silent miss

      expect(noteCorpus.relatedNotes(handle, String(note._id), 8).length).toBeGreaterThan(0);
      expect(noteCorpus.relatedNotes(handle, note._id, 8).length).toBeGreaterThan(0);
    });

    test('and an unstringified id in the CORPUS is the loud half', async () => {
      // The other direction of §21.3's C1: the index guard rejects a non-string
      // id outright, so the adapter's String(_id) failing is a crash rather than
      // a silence. Both failure modes exist and only one of them is loud.
      const retrieval = require('../retrieval');
      const note = await Note.findOne({ user: user.id }).lean();
      expect(() => retrieval.index(noteCorpus.APP_RETRIEVER, [{ id: note._id, title: 'x', body: 'y' }]))
        .toThrow(/must be a non-empty string/);
    });

    test('the corpus digest is stable across two reads of the same store', async () => {
      const a = noteCorpus.corpusDigest(await noteCorpus.loadNoteCorpus(user.id));
      const b = noteCorpus.corpusDigest(await noteCorpus.loadNoteCorpus(user.id));
      expect(a).toBe(b);
    });

    test('a note saved with no contentText reaches the adapter as an empty body', async () => {
      const { body } = await api('POST', '/api/notes', { token: user.token, body: { title: 'Empty' } });
      const docs = await noteCorpus.loadNoteCorpus(user.id);
      const found = docs.find((d) => d.id === String(body._id));
      expect(found.body).toBe('');
      await api('DELETE', `/api/notes/${body._id}`, { token: user.token });
    });
  });
});
