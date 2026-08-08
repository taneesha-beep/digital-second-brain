'use strict';

/**
 * v1-overlap.js — the shipped algorithm, re-expressed against the 2.1
 * interface. This is the baseline every later rung is compared against, so it
 * reproduces what is deployed rather than what the deployed code meant to do.
 *
 * WHAT IT RE-EXPRESSES. The shipped retriever is a composition of two files
 * that never call each other — they are joined only through Mongo:
 *
 *   routes/notes.js:118-119   corpus = loadUserCorpus(user, {excludeId, limit:500})
 *                             note.keywords = extractKeywords(title, text, corpus)
 *                                          |
 *                                     [persisted]
 *                                          |
 *   linker.service.js:24-36   reads note.keywords, scores, filters, caps
 *
 * The linker alone maps keywords to a ranked list; only the composition maps a
 * *document* to a ranked list of documents, so the composition is what a
 * retriever has to be.
 *
 * WHERE THE LINE IS DRAWN. This re-expresses linker.service.js lines 24-36 —
 * the computed `links` array, the payload of the $set on line 38. It
 * deliberately does NOT re-express lines 40-64, the bidirectional write. That
 * block is last-writer-wins storage: whichever note was saved most recently
 * overwrites the other direction, so the *stored* graph depends on save order.
 * A retriever returns a ranked list; the storage layer then mangles it. Lines
 * 40-64 are Phase 4.2's subject, not this one's.
 *
 * SHIPPED v1 IS NOT A DETERMINISTIC FUNCTION OF (query, corpus). It is a
 * function of (query, corpus, save history, database return order). Three
 * inputs the shipped code leaves unspecified, each frozen here as an explicit
 * param rather than as a silent assumption:
 *
 *   1. WHICH DOCUMENTS FEED THE IDF. utils/corpus.js:6 is
 *      `Note.find(filter).select(...).limit(500).lean()` with no .sort(), so
 *      above 500 notes *which* 500 form the document-frequency table follows
 *      Mongo's return order and is unspecified. Frozen: the whole corpus,
 *      leave-one-out. Param: idfCorpus.
 *
 *   2. WHEN EACH DOCUMENT'S KEYWORDS WERE COMPUTED. Keywords are extracted at
 *      save time and persisted, never recomputed. With a live IDF a note's
 *      keyword list is therefore a snapshot of whatever corpus existed at its
 *      own last save, and the live link graph is a mosaic of different corpus
 *      epochs. Frozen: every document's keywords are extracted at index time
 *      from one corpus state — what the app would converge to if every note
 *      were re-saved once after all notes existed.
 *
 *   3. TIE ORDER AT THE THRESHOLD AND CAP CUT. Array.prototype.sort is stable
 *      (ES2019), so equal strengths fall back to the order Mongo returned the
 *      documents in. Ties are the normal case, not an edge case: strength is
 *      shared/|keywords| with at most ten keywords, so it takes at most eleven
 *      distinct values and the slice(0,8) boundary lands inside a tie group
 *      routinely. Frozen in ./index.js: descending score, then lexicographic
 *      on the id string. That reproduces the shipped result exactly when the
 *      store returns documents in id order — which is what a one-line
 *      .sort({_id: 1}) at Phase 4.1 would make true, and is why that fix is
 *      worth doing there.
 *
 * The tokenizer, stopword list, scoring formula and cap below are copied from
 * backend/utils/keywords.js and backend/services/linker.service.js rather than
 * imported. Importing would make the retrieval layer depend on app code, which
 * inverts the direction Phase 4.1 needs (app -> retrieval, never the reverse)
 * and would make the parity test a tautology. The copy is what
 * tests/retrieval.v1-parity.test.js proves equivalent, against the real
 * unmodified modules.
 */

/** Verbatim from backend/utils/keywords.js:13-33. */
const STOPWORDS = new Set([
  'a','about','above','after','again','against','all','am','an','and','any',
  'are','arent','as','at','be','because','been','before','being','below',
  'between','both','but','by','cant','cannot','could','couldnt','did','didnt',
  'do','does','doesnt','doing','dont','down','during','each','few','for','from',
  'further','get','got','had','hadnt','has','hasnt','have','havent','having',
  'he','hed','hell','hes','her','here','heres','hers','herself','him','himself',
  'his','how','hows','i','id','ill','im','ive','if','in','into','is','isnt',
  'it','its','itself','lets','me','more','most','mustnt','my','myself','no',
  'nor','not','of','off','on','once','only','or','other','ought','our','ours',
  'ourselves','out','over','own','same','shant','she','shed','shell','shes',
  'should','shouldnt','so','some','such','than','that','thats','the','their',
  'theirs','them','themselves','then','there','theres','these','they','theyd',
  'theyll','theyre','theyve','this','those','through','to','too','under','until',
  'up','very','was','wasnt','we','wed','well','were','weve','werent','what',
  'whats','when','whens','where','wheres','which','while','who','whos','whom',
  'why','whys','will','with','wont','would','wouldnt','you','youd','youll',
  'youre','youve','your','yours','yourself','yourselves','also','just','like',
  'can','may','use','used','using','make','made','new','one','two','three',
  'first','second','last','many','much','now','then','way','time','say'
]);

/** Verbatim from backend/utils/keywords.js:40-46. */
function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const defaultParams = {
  /**
   * Which documents supply the document frequencies.
   *   'leave-one-out' — every other document in the corpus. Reproduces the
   *       shipped `excludeId` (notes.js:118) and upload.js:56, where the
   *       corpus is loaded before Note.create so the new note is absent from
   *       its own table either way.
   *   'all'  — the whole corpus including the document itself.
   *   'none' — no corpus, so idf is the constant ln(2)+1. This is the
   *       brand-new-account path, and the state three of the four cases in
   *       tests/keywords.test.js exercise.
   * Roadmap 2.6 has to choose deliberately between these when measuring the
   * shipped algorithm against Stack Exchange; this makes the choice a
   * parameter that lands in the run file rather than a buried constant.
   */
  idfCorpus: 'leave-one-out',
  /** keywords.js:55 default. */
  topN: 10,
  /** linker.service.js:34 — strictly greater than. */
  threshold: 0.15,
  /** linker.service.js:36 — slice(0, 8). */
  cap: 8,
  /** linker.service.js:30 — Number(strength.toFixed(4)), applied before the filter. */
  scorePrecision: 4,
  /**
   * keywords.js:86 — (1 + ln(word.length)). Word length is not evidence of
   * importance, and roadmap 3.2 schedules removing it as a one-variable
   * ablation. Present here so that ablation is a param flip recorded in the
   * run rather than an edit to the baseline.
   */
  lengthBonus: true
};

/**
 * Score one document's terms exactly as keywords.js:55-95 does.
 *
 * TWO THINGS HERE LOOK LIKE THEY COULD BE TIDIED AND CANNOT BE.
 *
 * The title is tokenised and concatenated twice (keywords.js:59), so title
 * terms enter the term-frequency count at double weight.
 *
 * `tf` is a plain object and the ranking is read out with Object.entries, not
 * a Map. That is load-bearing. JavaScript objects enumerate integer-like keys
 * first, in ascending numeric order, before string keys in insertion order —
 * so a numeric token such as "350" is hoisted to the front. `scored.sort` is
 * stable, so that enumeration order is what breaks ties between terms of equal
 * score, and equal scores are common (in a short document most surviving terms
 * appear exactly once). A Map would preserve pure insertion order and quietly
 * produce a different keyword list.
 */
function extractKeywords(title, body, dfLookup, docCount, params) {
  const titleTokens = tokenise(title || '');
  const contentTokens = tokenise(body || '');
  const allTokens = [...titleTokens, ...titleTokens, ...contentTokens];
  if (allTokens.length === 0) return [];

  const tf = {};
  for (const word of allTokens) {
    tf[word] = (tf[word] || 0) + 1;
  }

  const scored = Object.entries(tf).map(([word, count]) => {
    const df = dfLookup(word);
    const idf = Math.log((docCount + 1) / (df + 1)) + 1;
    const lengthBonus = params.lengthBonus ? 1 + Math.log(word.length) : 1;
    return { word, score: count * idf * lengthBonus };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, params.topN).map((s) => s.word);
}

/**
 * One pass for document frequencies, then one pass for keywords.
 *
 * The shipped extractor rebuilds the entire document-frequency table from
 * scratch on every call (keywords.js:71-75), which is O(N) full-corpus
 * tokenisation per document and O(N^2) over a corpus — roughly 7.5e8 document
 * tokenisations at N=27,325, which does not finish. Building the table once is
 * therefore a genuinely different implementation of the same function, and the
 * only reason the equivalence can be claimed is that the parity test measures
 * it against the real module rather than asserting it.
 *
 * Leave-one-out survives the single table exactly, at no asymptotic cost:
 * df_loo(w, X) = df(w) - (X contains w ? 1 : 0), and docCount = N - 1. So the
 * shipped semantics are matched, not approximated.
 */
function buildIndex(docs, params) {
  if (!['leave-one-out', 'all', 'none'].includes(params.idfCorpus)) {
    throw new Error(`v1-overlap: idfCorpus must be leave-one-out, all or none (got ${params.idfCorpus})`);
  }
  if (!(params.threshold >= 0)) {
    // Candidates are gathered from the query's postings, so documents sharing
    // no keyword are never scored. The shipped code scores them at 0 and drops
    // them at `> 0.15`, which is identical for any threshold >= 0 and would
    // diverge for a negative one.
    throw new Error(`v1-overlap: threshold must be >= 0 (got ${params.threshold})`);
  }

  // Document frequency counts a document once per term, so the corpus side is
  // a Set. keywords.js:74 tokenises `${title} ${content}` as one string, with
  // the title NOT doubled — the doubling applies only to the extraction target.
  const dfSets = docs.map((doc) => new Set(tokenise(`${doc.title || ''} ${doc.body || ''}`)));
  const globalDf = new Map();
  for (const set of dfSets) {
    for (const word of set) globalDf.set(word, (globalDf.get(word) || 0) + 1);
  }

  const n = docs.length;
  const keywordsById = new Map();
  const postings = new Map();

  for (let i = 0; i < n; i += 1) {
    const doc = docs[i];
    let docCount;
    let dfLookup;
    if (params.idfCorpus === 'none') {
      docCount = 1; // keywords.js:76 — `docSets.length || 1` on an empty corpus
      dfLookup = () => 0;
    } else if (params.idfCorpus === 'all') {
      docCount = n || 1;
      dfLookup = (word) => globalDf.get(word) || 0;
    } else {
      docCount = (n - 1) || 1;
      const self = dfSets[i];
      dfLookup = (word) => (globalDf.get(word) || 0) - (self.has(word) ? 1 : 0);
    }

    const keywords = extractKeywords(doc.title, doc.body, dfLookup, docCount, params);
    keywordsById.set(doc.id, keywords);
    for (const word of keywords) {
      let bucket = postings.get(word);
      if (!bucket) { bucket = []; postings.set(word, bucket); }
      bucket.push(doc.id);
    }
  }

  return { keywordsById, postings, params };
}

/**
 * linker.service.js:21-36, minus the database.
 *
 * `sharedKeywords` is built by filtering the TARGET's keyword list against the
 * source's set (linker.service.js:13), so the shared terms come out in target
 * order, not query order. That is not cosmetic here — it is part of what the
 * byte-identical comparison checks, and computing it the other way round is
 * the natural thing to do from a postings list.
 */
function rank(state, queryDoc, ctx) {
  const { keywordsById, postings, params } = state;
  const queryKeywords = keywordsById.get(queryDoc.id);
  const querySet = new Set(queryKeywords);
  const denominator = Math.max(queryKeywords.length, 1);

  const candidates = new Set();
  for (const word of querySet) {
    const bucket = postings.get(word);
    if (bucket) for (const id of bucket) candidates.add(id);
  }

  for (const docId of candidates) {
    const sharedKeywords = keywordsById.get(docId).filter((k) => querySet.has(k));
    const strength = Number((sharedKeywords.length / denominator).toFixed(params.scorePrecision));
    if (!(strength > params.threshold)) continue;
    ctx.collect(docId, strength, { sharedKeywords });
  }
}

/** Read a document's extracted keywords. Used by the parity evidence dump. */
function keywordsFor(state, docId) {
  return state.keywordsById.get(docId);
}

module.exports = {
  version: 'v1-overlap',
  defaultParams,
  buildIndex,
  rank,
  keywordsFor,
  tokenise,
  /**
   * score(A→B) = |A ∩ B| / |A| divides by the SOURCE's keyword count, so the two
   * directions disagree whenever the two lists differ in length. §14.5 measured
   * it by putting v1 through v2's symmetry test and watching it fail.
   *
   * ADDED AT 3.4, AND IT IS THE ONLY LINE THIS FILE HAS GAINED SINCE 2.1.
   * It declares behaviour rather than changing any: `symmetric` is not a param,
   * so no params digest moves, and the freeze on this file is the PARITY hash —
   * `results/parity/` must still be 83f9e35e…, which is re-run and checked
   * rather than assumed. See §17 and tests/retrieval.symmetry.test.js, which
   * measures this declaration instead of trusting it.
   */
  symmetric: false
};
