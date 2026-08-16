const Note = require('../models/Note');

// ─── utils ───────────────────────────────────────────────────────────────────

function normList(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

function tokenise(text) {
  const STOPWORDS = new Set([
    'a','about','above','after','again','against','all','am','an','and','any',
    'are','as','at','be','because','been','before','being','below','between',
    'both','but','by','can','cannot','could','did','do','does','doing','down',
    'during','each','few','for','from','further','get','got','had','has','have',
    'having','he','her','here','hers','herself','him','himself','his','how',
    'if','in','into','is','it','its','itself','just','like','me','more','most',
    'my','myself','no','nor','not','of','off','on','once','only','or','other',
    'our','ours','out','over','own','same','she','should','so','some','such',
    'than','that','the','their','them','themselves','then','there','these',
    'they','this','those','through','to','too','under','until','up','use',
    'used','using','very','was','we','were','what','when','where','which',
    'while','who','whom','why','will','with','would','you','your','yours',
    'also','make','made','new','one','two','three','first','second','last',
    'many','much','now','then','way','time','say'
  ]);
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

function scoreKeywords(keywords, contentText, title) {
  const text = `${title || ''} ${title || ''} ${contentText || ''}`.toLowerCase();
  const scores = {};
  let max = 1;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const count = (text.match(re) || []).length;
    scores[kw] = count;
    if (count > max) max = count;
  }
  const out = {};
  for (const kw of keywords) out[kw] = Number((scores[kw] / max).toFixed(3));
  return out;
}

function extractSubKeywords(keyword, contentText, topKeywords, limit = 5) {
  if (!contentText || !keyword) return [];
  const topSet = new Set(topKeywords.map((k) => k.toLowerCase()));
  const sentences = contentText
    .split(/[.!?\n]+/)
    .filter((s) => s.toLowerCase().includes(keyword.toLowerCase()));
  const freq = {};
  for (const s of sentences) {
    for (const t of tokenise(s)) {
      if (!topSet.has(t) && t !== keyword) freq[t] = (freq[t] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

const PALETTE = [
  '#6366f1','#f59e0b','#10b981','#ef4444',
  '#3b82f6','#8b5cf6','#f97316','#14b8a6',
  '#e879f9','#84cc16','#fb7185','#38bdf8',
];

// ─── per-note graph (Cytoscape elements) ─────────────────────────────────────

/**
 * Returns { elements: CytoscapeElement[], scores: {} }
 *
 * Level 0 : root  (the note title)
 * Level 1 : keywords  (sized by TF-IDF score, colored green→orange)
 * Level 2 : sub-keywords (only for keywords in expandedKeywords[])
 */
async function buildNoteGraph(noteId, expandedKeywords = []) {
  const note = await Note.findById(noteId).lean();
  if (!note) return { elements: [], scores: {} };

  const keywords = normList(note.keywords);
  const tags      = normList(note.tags);
  const content   = note.contentText || '';
  const title     = note.title || 'Untitled';
  const elements  = [];

  // Root
  elements.push({
    data: { id: 'root', label: title, type: 'note', level: 0 },
    classes: 'note-node'
  });

  if (keywords.length === 0) return { elements, scores: {} };

  const scores = scoreKeywords(keywords, content, title);

  // L1 keywords
  for (const kw of keywords) {
    const score = scores[kw] ?? 0.3;
    // Size: map score 0–1 → 44–68px diameter for Cytoscape
    const size = 44 + Math.round(score * 24);
    elements.push({
      data: {
        id: `kw_${kw}`,
        label: kw,
        type: 'keyword',
        level: 1,
        score,
        size,
        keyword: kw,
        expandable: true,
        expanded: expandedKeywords.includes(kw),
      },
      classes: 'keyword-node'
    });
    elements.push({
      data: { id: `e_root_${kw}`, source: 'root', target: `kw_${kw}`, type: 'keyword-edge' },
      classes: 'keyword-edge'
    });
  }

  // L1 tags
  for (const tag of tags) {
    elements.push({
      data: { id: `tag_${tag}`, label: `#${tag}`, type: 'tag', level: 1, size: 28 },
      classes: 'tag-node'
    });
    elements.push({
      data: { id: `e_root_tag_${tag}`, source: 'root', target: `tag_${tag}`, type: 'tag-edge' },
      classes: 'tag-edge'
    });
  }

  // L2 sub-keywords for pre-expanded keywords
  for (const kw of expandedKeywords) {
    if (!keywords.includes(kw)) continue;
    const subs = extractSubKeywords(kw, content, keywords);
    for (const sub of subs) {
      const subId = `sub_${kw}_${sub}`;
      elements.push({
        data: { id: subId, label: sub, type: 'subkeyword', level: 2, parentKeyword: kw, size: 22 },
        classes: 'sub-node'
      });
      elements.push({
        data: { id: `e_${kw}_${sub}`, source: `kw_${kw}`, target: subId, type: 'sub-edge' },
        classes: 'sub-edge'
      });
    }
  }

  return { elements, scores };
}

/**
 * Lazy expansion: returns Cytoscape elements for L2 sub-keywords of one keyword.
 */
async function expandKeyword(noteId, keyword) {
  const note = await Note.findById(noteId).lean();
  if (!note) return { elements: [] };

  const topKeywords = normList(note.keywords);
  const content     = note.contentText || '';
  const subs        = extractSubKeywords(keyword, content, topKeywords, 5);
  const elements    = [];

  for (const sub of subs) {
    const subId = `sub_${keyword}_${sub}`;
    elements.push({
      data: { id: subId, label: sub, type: 'subkeyword', level: 2, parentKeyword: keyword, size: 22 },
      classes: 'sub-node'
    });
    elements.push({
      data: { id: `e_${keyword}_${sub}`, source: `kw_${keyword}`, target: subId, type: 'sub-edge' },
      classes: 'sub-edge'
    });
  }

  return { elements };
}

// ─── global graph (Cytoscape elements) ───────────────────────────────────────

/**
 * THE DOCUMENT-FREQUENCY CUTOFF. Phase 4.4.
 *
 * A keyword carried by more than MAX_DF notes emits NO cross edges and counts
 * toward no note's degree. Its keyword nodes and its note-keyword edges are
 * untouched, because the term this bounds is EDGE EMISSION and a note's keyword
 * fan is not it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY 30, AND WHY AN ABSOLUTE COUNT RATHER THAN A PROPORTION.
 *
 * Chosen against measurement rather than picked. Max df sits in a 4.5-7.0% band
 * at every N measured (7 at N=100, 17 at 250, 28 at 500, 42 at 750, 50 at 1000,
 * 105 at 2000 — results/graph-characterization.txt and EVALUATION §24.3), which
 * makes any PROPORTIONAL cutoff scale-invariant: above ~7% it is inert at every
 * scale, below it removes a roughly constant fraction forever. Neither bounds
 * growth. Only an absolute cutoff bites harder as N rises, which is what §21.4's
 * "the penalty for dropping truncation gets worse as a collection grows"
 * requires.
 *
 * 30 = ceil(0.06 x CORPUS_LIMIT), CORPUS_LIMIT = 500. That is the top of the
 * measured band evaluated at the slice utils/corpus.js:3 and
 * noteCorpus.service.js:100 both cap at — so this is INERT at N <= 500 and the
 * graph no current user can see does not change. It becomes live from ~N=750,
 * and buildGlobalGraph is the only path here where N is unbounded: the query
 * below has no .limit() where the linker's adapter has one.
 *
 * IT IS FITTED TO A STACK EXCHANGE SLICE, NOT TO NOTES. §12.2's point. A real
 * notebook's df distribution is unmeasured because there are no real notes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT IS NOT A SILENT CONSTANT, AND §15.6 IS THE REASON THAT MATTERS.
 *
 * §15.6: "If [a document-frequency cutoff] becomes necessary it will be a
 * retriever PARAM landing in describe(handle).digest, never a silent constant."
 * That rule governs backend/retrieval/, which 4.4 does not touch — the graph
 * builder is not a retriever and has no handle to describe. The spirit is kept
 * the only way available here: the constant is exported, it is reported in the
 * response's `meta`, it is printed in results/graph-characterization.txt, and
 * EVALUATION §24.3 carries the argument. A cutoff nobody can see is the "run
 * that lies about itself" of §13.10 whether or not it lives in a digest.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A WRONG VALUE COSTS, IN EACH DIRECTION, BECAUSE THEY ARE NOT SYMMETRIC.
 *
 *   too high   116,425 cross edges and a 25.94 MiB response at N=2000. It
 *              degrades gradually and visibly.
 *   too low    the hub terms a user would call their recurring themes stop
 *              drawing edges. THIS IS THE WORSE FAILURE: a suppressed edge is
 *              indistinguishable from an absent relationship.
 *
 * The asymmetry is why `meta.suppressed` exists. It is a sibling of `elements`,
 * not an element, so nothing renders it — GlobalGraph.jsx:166 reads
 * `data?.elements` and nothing else — and the graph cannot quietly lie about
 * what it left out.
 */
const MAX_DF = 30;

/**
 * Build the global graph.
 *
 * COST, STATED THE WAY CLAUDE.md REQUIRES. "O(N^2) -> O(N*K)" is NOT what this
 * is and CLAUDE.md says so in terms.
 *
 *   before   O(N^2 * K^2). The pairwise loop at the old :206 compared every
 *            unordered note pair and re-normalised BOTH keyword lists inside
 *            the inner body, then scanned one for each member of the other.
 *            MEASURED at 3,578.8 ms of a 3,572.5 ms build at N=2000 — 99.5%.
 *   after    O(N*K) to build the postings, plus O(Sigma_{t: df_t <= c} df_t^2)
 *            to walk them. The second term is OUTPUT-SENSITIVE: it is the
 *            number of (pair, term) incidences the graph actually emits.
 *
 * THE SECOND TERM IS STILL QUADRATIC WITHOUT THE CUTOFF. One keyword appearing
 * in every note gives df = N and a single bucket costing N^2/2. The cutoff is
 * what bounds it, and with it the term is at most c * Sigma_t df_t = c*N*K —
 * linear in N for a fixed c. That is the honest statement and it is the whole
 * reason MAX_DF is not optional.
 *
 * Cross-edge emission was ALREADY doing the postings walk before 4.4 — the old
 * :261 grouped keyword nodes by keyword and emitted from the buckets, which is
 * an inverted index under another name, and it cost 8.8 ms at N=2000. What 4.4
 * removes is the OTHER loop. EVALUATION §24.2.
 *
 * @param {*} userId
 * @param {{maxDf?: number}} [options]  maxDf Infinity disables the cutoff, which
 *   is how the 4.4 comparison proves the rewrite byte-identical before it
 *   measures what the cutoff changes. Never passed by a route.
 */
async function buildGlobalGraph(userId, { maxDf = MAX_DF } = {}) {
  if (!(maxDf === Infinity || (Number.isInteger(maxDf) && maxDf >= 1))) {
    throw new TypeError('buildGlobalGraph: maxDf must be a positive integer or Infinity');
  }

  const notes    = await Note.find({ user: userId }).lean();
  const elements = [];

  const noteIds = new Array(notes.length);
  const noteColors = new Map();
  for (let i = 0; i < notes.length; i++) {
    noteIds[i] = notes[i]._id.toString();
    noteColors.set(noteIds[i], PALETTE[i % PALETTE.length]);
  }

  /**
   * THE INVERTED INDEX. keyword -> the indices of the notes carrying it.
   *
   * INSERTION ORDER IS LOAD-BEARING and is not an implementation detail. The
   * old builder derived its groups by scanning the finished `elements` array
   * for keyword nodes, so its group order was "first appearance of a keyword,
   * scanning notes in order" and its within-group order was note order. A Map
   * filled by the same scan reproduces both exactly, which is what lets the
   * rewrite be byte-identical rather than merely equivalent. The comparison in
   * scripts/lib/graph-diff.js checks ordering, because the output digest is
   * taken over the emitted array rather than over a set.
   *
   * KEYWORDS ARE NOT DEDUPED WITHIN A NOTE, deliberately. normList() does not,
   * so the old kwUsage counted OCCURRENCES rather than distinct notes, and a
   * note repeating a keyword would push two keyword nodes sharing one id. That
   * cannot happen through extractKeywords(), which builds from a term-frequency
   * Map — but reproducing the old behaviour is the point, and a Set here would
   * silently diverge on any note whose keywords array was written by hand.
   */
  const postings = new Map();
  const noteKeywords = new Array(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const kws = normList(notes[i].keywords);
    noteKeywords[i] = kws;
    for (const kw of kws) {
      let bucket = postings.get(kw);
      if (bucket === undefined) { bucket = []; postings.set(kw, bucket); }
      bucket.push(i);
    }
  }

  /** A term draws edges iff at least two notes carry it and it is under the cutoff. */
  const emits = (bucket) => bucket.length >= 2 && bucket.length <= maxDf;

  /**
   * DEGREE, FROM THE POSTINGS, AND THE DEDUPE IS THE WHOLE DIFFICULTY.
   *
   * The old loop asked "do these two notes share AT LEAST ONE keyword" and
   * counted the PAIR once however many keywords they shared. A postings walk
   * naturally counts once per shared TERM, so a Set per note is what makes the
   * two agree — without it every multi-term pair is counted twice or more and
   * every node inflates. This was written down as the prediction most likely to
   * fail on the first run, and it did.
   *
   * Cost: one Set insertion per (pair, admitted term) incidence, which is the
   * O(Sigma_{df_t <= c} df_t^2) term in the header. Sets are allocated lazily,
   * so a note sharing nothing with anything allocates none.
   */
  const partners = new Array(notes.length).fill(null);
  for (const bucket of postings.values()) {
    if (!emits(bucket)) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const x = bucket[a]; const y = bucket[b];
        if (partners[x] === null) partners[x] = new Set();
        if (partners[y] === null) partners[y] = new Set();
        partners[x].add(y);
        partners[y].add(x);
      }
    }
  }

  // Note nodes (level 1)
  for (let i = 0; i < notes.length; i++) {
    const noteId   = noteIds[i];
    const conns    = partners[i] === null ? 0 : partners[i].size;
    const noteSize = 64 + Math.min(conns * 6, 24);
    const color    = noteColors.get(noteId) || '#6366f1';

    elements.push({
      data: {
        id: noteId, label: notes[i].title || 'Untitled',
        type: 'note', level: 1, size: noteSize,
        keywords: noteKeywords[i], noteColor: color,
      },
      classes: 'global-note-node',
    });

    // Keyword nodes (level 2) — scoped per note so each branch is independent
    for (const kw of noteKeywords[i]) {
      const kwNodeId = `kw_${noteId}_${kw}`;
      const bucket   = postings.get(kw);
      const usage    = bucket.length || 1;
      const kwSize   = 38 + Math.min(usage * 4, 14);
      /**
       * `shared` NOW MEANS "this node has at least one cross edge", where it
       * used to mean "some other note carries this keyword". Identical whenever
       * the cutoff is inert; under it, a suppressed hub keyword reports false.
       *
       * That is deliberate rather than incidental. The flag drives the
       * `shared-kw` class and the tooltip at GlobalGraph.jsx:333, so a node
       * styled as shared while drawing no edge would be the graph asserting a
       * connection it declined to render — the silent-suppression failure
       * `meta` exists to prevent, reappearing one field over. `size` is left on
       * `usage` and does NOT move, because size reports how common a term is,
       * which the cutoff does not change.
       */
      const isShared = emits(bucket);

      elements.push({
        data: {
          id: kwNodeId, label: kw,
          type: 'keyword', level: 2,
          size: kwSize, keyword: kw,
          parentNote: noteId, noteColor: color,
          shared: isShared,
        },
        classes: `global-kw-node${isShared ? ' shared-kw' : ''}`,
      });

      elements.push({
        data: { id: `e_${noteId}_${kw}`, source: noteId, target: kwNodeId, type: 'note-keyword' },
        classes: 'global-kw-edge',
      });
    }
  }

  // Cross-edges: connect same-keyword nodes across different notes. Emitted
  // from the ONE index built above rather than by re-deriving groups from the
  // finished element array, which is what the old :260-267 did.
  const suppressed = [];
  let suppressedEdges = 0;
  for (const [kw, bucket] of postings.entries()) {
    if (bucket.length > maxDf) {
      suppressed.push({ keyword: kw, df: bucket.length });
      suppressedEdges += (bucket.length * (bucket.length - 1)) / 2;
      continue;
    }
    if (bucket.length < 2) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const idA = `kw_${noteIds[bucket[a]]}_${kw}`;
        const idB = `kw_${noteIds[bucket[b]]}_${kw}`;
        elements.push({
          data: {
            id: `cross_${idA}_${idB}`,
            source: idA, target: idB,
            type: 'cross-link', sharedKeyword: kw,
          },
          classes: 'cross-edge',
        });
      }
    }
  }

  suppressed.sort((a, b) => b.df - a.df || (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0));

  /**
   * `meta` IS A SIBLING OF `elements`, NEVER AN ELEMENT. Nothing renders it —
   * GlobalGraph.jsx:166 destructures `data?.elements` — so adding it changes no
   * pixel and no element, which is what lets the 4.4 comparison define its
   * permitted diff over `elements` alone. If a frontend ever reads it, that is
   * a new consumer and a new decision.
   *
   * `maxDf` is null rather than Infinity when the cutoff is disabled, because
   * JSON.stringify(Infinity) is `null` anyway and a field whose serialised form
   * differs from its in-process value is a trap for whoever reads the response.
   */
  return {
    elements,
    meta: {
      maxDf: Number.isFinite(maxDf) ? maxDf : null,
      notes: notes.length,
      vocabulary: postings.size,
      suppressedTerms: suppressed.length,
      suppressedEdges,
      suppressed,
    },
  };
}

module.exports = { buildNoteGraph, buildGlobalGraph, expandKeyword, MAX_DF };