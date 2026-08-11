'use strict';

/**
 * fake-note-store.js — the Note model's surface, without a database.
 *
 * WHY THIS EXISTS. The Phase 2.1 parity proof has to run the *real*
 * backend/utils/keywords.js, backend/utils/corpus.js and
 * backend/services/linker.service.js. Comparing a reimplementation against a
 * reimplementation proves nothing. Those last two files do
 * `require('../models/Note')` at module scope, so running them needs either a
 * database or a substitute for the model.
 *
 * The substitute is installed by priming require.cache (see install() below)
 * rather than by editing the shipped files, which stay untouched — the diff on
 * the 2.1 commit shows zero lines changed under backend/routes, backend/
 * services, backend/models and backend/utils, and that is the evidence the
 * harness did not drag app changes in early.
 *
 * It is not a shortcut. It is the instrument: the store's return order is
 * explicitly controllable, which is what makes it possible to *demonstrate*
 * that shipped v1's output depends on the order Mongo hands documents back,
 * rather than to assert it.
 *
 * Only the surface the shipped code actually uses is implemented:
 *
 *   corpus.js:6            Note.find(f).select(s).limit(n).lean()
 *   linker.service.js:17   Note.findOne(f).lean()
 *   linker.service.js:38   Note.findByIdAndUpdate(id, {$set: {...}})
 *   linker.service.js:43   Note.findById(id)  ->  doc.save()
 *   noteCorpus.service.js  Note.find(f).select(s).sort({_id:1}).limit(n).lean()
 *
 * Anything else throws, so a future shipped change that reaches for another
 * method fails loudly instead of being silently mocked away.
 *
 * ↳ 4.1 ADDED sort() AND IT HAD TO REALLY SORT. The adapter's whole claim
 * against §7.2's third unspecified input is that ITS corpus is order-specified
 * where utils/corpus.js's is not. A sort() that returned the builder unchanged
 * would make that claim untestable and every demonstration of it vacuous — the
 * adapter would look order-independent because the fixture never reordered.
 * Only {_id: 1} and {_id: -1} are implemented; anything else throws, for the
 * same reason as every other method here.
 *
 * ↳ 4.1 also REMOVED a line from this list rather than adding one.
 * linker.service.js:20's `Note.find({user, _id:{$ne}}).lean()` — every other
 * note, so the old linker could intersect keyword lists — has no caller now
 * that the linker goes through the adapter. find() still supports the filter,
 * because parity-v1.js still drives the pre-4.1 code path through it.
 *
 * ↳ 4.2 MADE THE STORE COUNT ITS OWN OPERATIONS, and that is a change of
 * instrument rather than a convenience. scripts/measure-writes.js first tried
 * to count from OUTSIDE, by putting a proxy in require.cache in front of this
 * module. It does not work, for two reasons worth recording because both are
 * invisible until they bite:
 *
 *   1. parity-v1.js calls install() at ITS module scope and requires the
 *      preserved linker there, so by the time an outside caller can install
 *      anything, the module under measurement is already holding a reference to
 *      the uncounted fake. The script reported ZERO operations while reporting
 *      exactly the right LINK COUNTS — a bug wearing a working script's face.
 *   2. doc.save is defined below with Object.defineProperty and is neither
 *      writable nor configurable, so a Proxy cannot substitute a counting
 *      version of it: the invariant check throws.
 *
 * Counting here instead means there is ONE instrument, it is the same object
 * the code under measurement already talks to, and it cannot be got in front
 * of. The counter is off until resetOps() is called, so every existing caller
 * is unaffected.
 */

const path = require('path');

let currentStore = null;

// ── operation counting (4.2) ────────────────────────────────────────────────
//
// ONE OPERATION = ONE CALL THAT WOULD REACH A SERVER. A builder chain
// (.select().sort().limit().lean()) is client-side and counts once, at the
// model method that starts it; doc.save() and bulkWrite() count once each.
// bulkWrite counting ONE is the whole point of the 4.2 measurement and is also
// its sharpest caveat — one command, N server-side writes. measure-writes.js
// says so where the number is quoted.
let ops = null;

function bump(name) {
  if (ops) ops.set(name, (ops.get(name) || 0) + 1);
}

/** Start counting, discarding anything counted before. */
function resetOps() {
  ops = new Map();
}

/** Total operations since resetOps(), or 0 if counting was never started. */
function totalOps() {
  if (!ops) return 0;
  let n = 0;
  for (const v of ops.values()) n += v;
  return n;
}

/** Per-method counts since resetOps(), sorted by name. */
function opBreakdown() {
  return ops ? [...ops.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)) : [];
}

/** `{user}`, `{user, _id: {$ne}}`, `{_id, user}` — the three filters in use. */
function matches(doc, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_id') {
      if (value && typeof value === 'object' && '$ne' in value) {
        if (String(doc._id) === String(value.$ne)) return false;
      } else if (String(doc._id) !== String(value)) {
        return false;
      }
    } else if (key === 'user') {
      if (String(doc.user) !== String(value)) return false;
    } else {
      throw new Error(`fake-note-store: unsupported filter key ${key}`);
    }
  }
  return true;
}

/** JSON round-trip, matching .lean()'s "plain object, detached from the store". */
function lean(doc) {
  return JSON.parse(JSON.stringify(doc));
}

class FakeNoteStore {
  /**
   * @param {Array<{_id: string, user: string, title: string, contentText: string}>} notes
   * @param {string[]} [order] ids in the order find() returns them. Mongo's
   *   natural order is unspecified; making it an explicit input is the point.
   */
  constructor(notes, order) {
    this.docs = new Map();
    for (const note of notes) {
      const doc = { linkedNotes: [], keywords: [], ...note };
      Object.defineProperty(doc, 'save', {
        enumerable: false,
        value: async () => { bump('save'); return doc; } // already live in the map; nothing to flush
      });
      this.docs.set(String(note._id), doc);
    }
    this.order = order ? [...order] : [...this.docs.keys()];
    const known = new Set(this.docs.keys());
    if (this.order.length !== known.size || this.order.some((id) => !known.has(id))) {
      throw new Error('fake-note-store: order must be a permutation of the note ids');
    }
  }

  /** The live record, for setting keywords the way routes/notes.js:119 does. */
  raw(id) {
    const doc = this.docs.get(String(id));
    if (!doc) throw new Error(`fake-note-store: no note ${id}`);
    return doc;
  }

  _inOrder() {
    return this.order.map((id) => this.docs.get(id));
  }
}

/**
 * A stand-in for the Mongoose model. Every method delegates to the store set
 * by setStore(), so one primed require.cache entry serves many runs with
 * different document orders.
 */
const FakeNote = {
  find(filter = {}) {
    bump('find');
    const store = requireStore();
    let rows = store._inOrder().filter((doc) => matches(doc, filter));
    let limited = rows;
    const builder = {
      select() { return builder; }, // projection is irrelevant to a plain-object store
      /**
       * Really sorts — see the header. Mongo applies sort BEFORE limit, so this
       * reorders `rows` and any later limit() slices the sorted list. Getting
       * that order backwards would silently change WHICH 500 documents a
       * >500-note user's corpus holds, which is the exact defect the adapter's
       * sort exists to remove.
       */
      sort(spec) {
        const keys = Object.keys(spec || {});
        if (keys.length !== 1 || keys[0] !== '_id' || ![1, -1].includes(spec._id)) {
          throw new Error(`fake-note-store: unsupported sort ${JSON.stringify(spec)} — only {_id: 1} and {_id: -1}`);
        }
        const dir = spec._id;
        rows = [...rows].sort((a, b) => {
          const x = String(a._id);
          const y = String(b._id);
          return (x < y ? -1 : x > y ? 1 : 0) * dir;
        });
        limited = rows;
        return builder;
      },
      limit(n) { limited = rows.slice(0, n); return builder; },
      lean: async () => limited.map(lean),
      then: (resolve, reject) => Promise.resolve(limited.map(lean)).then(resolve, reject)
    };
    return builder;
  },

  findOne(filter = {}) {
    bump('findOne');
    const store = requireStore();
    const found = store._inOrder().find((doc) => matches(doc, filter)) || null;
    const builder = {
      lean: async () => (found ? lean(found) : null),
      then: (resolve, reject) => Promise.resolve(found ? lean(found) : null).then(resolve, reject)
    };
    return builder;
  },

  async findById(id) {
    bump('findById');
    const store = requireStore();
    return store.docs.get(String(id)) || null;
  },

  async findByIdAndUpdate(id, update) {
    bump('findByIdAndUpdate');
    const store = requireStore();
    const doc = store.docs.get(String(id));
    if (!doc) return null;
    const set = update && update.$set ? update.$set : update;
    Object.assign(doc, JSON.parse(JSON.stringify(set)));
    return doc;
  },

  create() { throw new Error('fake-note-store: create() is not implemented'); },
  updateMany() { throw new Error('fake-note-store: updateMany() is not implemented'); }
};

function requireStore() {
  if (!currentStore) throw new Error('fake-note-store: setStore() has not been called');
  return currentStore;
}

function setStore(store) {
  currentStore = store;
  return store;
}

/**
 * Put FakeNote in require.cache under the resolved path of backend/models/
 * Note.js, so any later `require('../models/Note')` receives it.
 *
 * Must run before the first require of corpus.js or linker.service.js. A side
 * effect worth having: models/Note.js never executes, so mongoose is never
 * loaded — which independently demonstrates that the parity run touches no
 * database driver at all.
 *
 * This covers plain `node` only. Jest keeps its own module registry and
 * ignores require.cache, so the parity test additionally calls
 * jest.mock('../models/Note') with this same FakeNote. Two installers, one
 * substitute, and neither of them edits a shipped file.
 */
function install() {
  const notePath = path.resolve(__dirname, '..', '..', 'models', 'Note.js');
  require.cache[notePath] = {
    id: notePath,
    filename: notePath,
    path: path.dirname(notePath),
    loaded: true,
    children: [],
    paths: [],
    exports: FakeNote
  };
  return notePath;
}

module.exports = { FakeNoteStore, FakeNote, setStore, install, resetOps, totalOps, opBreakdown };
