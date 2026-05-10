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

module.exports = { buildNoteGraph, buildGlobalGraph, expandKeyword };