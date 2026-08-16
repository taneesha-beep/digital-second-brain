'use strict';

/**
 * graph-builder-v1-shipped.js — Phase 4.4. THE PRE-4.4 GLOBAL GRAPH BUILDER,
 * PRESERVED.
 *
 * NOT SHIPPED CODE. Nothing under backend/routes/, backend/services/ or
 * backend/models/ requires this file. Its only caller is
 * scripts/characterize-graph.js, and through it
 * tests/graph.characterization.test.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS, AND IT IS 4.2's REASON RATHER THAN 4.1's.
 *
 * CLAUDE.md: "Baselines are unrecoverable. In several phases the 'before'
 * number is destroyed by the change itself. Capture it as a separate, earlier
 * step." 4.2 did exactly this for the write cost (results/write-cost.txt,
 * committed at 4a38def, one commit BEFORE the change that destroyed it). This
 * is the same move for the graph build.
 *
 * But the graph needs more than a number. Roadmap 4.4's second Done clause is
 * "output identical to the characterization fixture, or the diff fully
 * explained by the DF cutoff" — so the baseline is an OUTPUT, and comparing
 * outputs needs both sides runnable at once. There are two ways to have that:
 *
 *   commit the output   ~2.1 MiB of JSON at N=500 and 19.09 MiB at N=2000, and
 *                       §8.5's rule sends it to .gitignore anyway, because it
 *                       regenerates from committed inputs
 *   freeze the code     one hashed file, both sides regenerate, and the diff is
 *                       computed live rather than read out of a blob
 *
 * The second is what §7.6 and results/parity/ already do, and it is the same
 * pattern as lib/linker-v1-shipped.js next door. A committed fixture would also
 * have gone stale silently; a frozen implementation cannot, because the hash
 * check and the output check both fail loudly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT "PRESERVED" MEANS HERE, AND HOW IT IS CHECKED.
 *
 *   source        backend/services/graphBuilder.service.js
 *   at            commit 83689c6 (origin/main, the merge of Phase 4.3)
 *   whole file    sha256 cad9e6236b7791e18ea0d9be3883da23f7012aaf4bc6fccf1fdbaebc0ae21c71
 *
 * ONE LINE DIFFERS AND IT IS THE FIRST ONE: `require('../models/Note')` becomes
 * `require('../../models/Note')`, because this file sits two directories
 * deeper. Both resolve to the same path, which is the path fake-note-store's
 * install() primes. Everything after it is byte-for-byte the file above,
 * delimited below and hashed by tests/graph.characterization.test.js against
 * sha256 711b6588dc6a72101d557000157e9df4dd3cbf112c0cdf475c5a79160d2f3fb2
 * — reproducible with:
 *
 *   git show 83689c6:backend/services/graphBuilder.service.js \
 *     | tail -n +2 | shasum -a 256
 *
 * THE WHOLE FILE IS COPIED, NOT ONLY buildGlobalGraph. 4.4 rewrites one of the
 * three exports; copying only that one would mean the hash above could not name
 * a file in git history, and "byte-identical to the shipped file below line 1"
 * is a stronger claim than "byte-identical to a function I extracted from it".
 * buildNoteGraph and expandKeyword are carried along unused — they call
 * Note.findById().lean(), which the fake store does not implement, so calling
 * either through this copy throws rather than silently returning something
 * wrong.
 *
 * A behavioural check sits behind the byte check and is the stronger of the
 * two: if this copy diverged, results/graph-characterization.txt would stop
 * reproducing its CONTROL digests.
 */

const Note = require('../../models/Note');

// ─── BEGIN VERBATIM — do not edit below this line ──────────────────────────

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

async function buildGlobalGraph(userId) {
  const notes    = await Note.find({ user: userId }).lean();
  const elements = [];

  const noteColors = new Map();
  for (let i = 0; i < notes.length; i++) {
    noteColors.set(notes[i]._id.toString(), PALETTE[i % PALETTE.length]);
  }

  const kwUsage = new Map();
  for (const note of notes) {
    for (const kw of normList(note.keywords)) {
      kwUsage.set(kw, (kwUsage.get(kw) || 0) + 1);
    }
  }

  const connCount = new Map();
  for (const note of notes) connCount.set(note._id.toString(), 0);
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const shared = normList(notes[i].keywords).filter(
        (k) => normList(notes[j].keywords).includes(k)
      );
      if (shared.length) {
        const aId = notes[i]._id.toString(), bId = notes[j]._id.toString();
        connCount.set(aId, (connCount.get(aId) || 0) + 1);
        connCount.set(bId, (connCount.get(bId) || 0) + 1);
      }
    }
  }

  // Note nodes (level 1)
  for (const note of notes) {
    const noteId   = note._id.toString();
    const conns    = connCount.get(noteId) || 0;
    const noteSize = 64 + Math.min(conns * 6, 24);
    const color    = noteColors.get(noteId) || '#6366f1';

    elements.push({
      data: {
        id: noteId, label: note.title || 'Untitled',
        type: 'note', level: 1, size: noteSize,
        keywords: normList(note.keywords), noteColor: color,
      },
      classes: 'global-note-node',
    });

    // Keyword nodes (level 2) — scoped per note so each branch is independent
    for (const kw of normList(note.keywords)) {
      const kwNodeId = `kw_${noteId}_${kw}`;
      const usage    = kwUsage.get(kw) || 1;
      const kwSize   = 38 + Math.min(usage * 4, 14);
      const isShared = usage > 1;

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

  // Cross-edges: connect same-keyword nodes across different notes
  const kwGroups = new Map();
  for (const el of elements) {
    if (el.data.type !== 'keyword') continue;
    const kw = el.data.keyword;
    if (!kwGroups.has(kw)) kwGroups.set(kw, []);
    kwGroups.get(kw).push(el.data.id);
  }
  for (const [kw, nodeIds] of kwGroups.entries()) {
    if (nodeIds.length < 2) continue;
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        elements.push({
          data: {
            id: `cross_${nodeIds[i]}_${nodeIds[j]}`,
            source: nodeIds[i], target: nodeIds[j],
            type: 'cross-link', sharedKeyword: kw,
          },
          classes: 'cross-edge',
        });
      }
    }
  }

  return { elements };
}

module.exports = { buildNoteGraph, buildGlobalGraph, expandKeyword };// ─── END VERBATIM ──────────────────────────────────────────────────────────
