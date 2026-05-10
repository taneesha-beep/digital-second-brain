/**
 * keywords.js
 * Lightweight NLP keyword extractor — no heavy external ML dependencies.
 *
 * Strategy:
 *  1. Combine title (weighted 2x) + content text.
 *  2. Tokenise, lowercase, strip punctuation.
 *  3. Remove common English stopwords.
 *  4. Score terms using TF-IDF with a small length bonus.
 *  5. Return top-N keywords.
 */

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

/**
 * Tokenise a string into cleaned lowercase words.
 * @param {string} text
 * @returns {string[]}
 */
function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip punctuation
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Extract top keywords from a note's title and content.
 * @param {string} title
 * @param {string} content
 * @param {number} topN   - how many keywords to return (default 10)
 * @returns {string[]}    - array of keyword strings
 */
function extractKeywords(title, content, documents = [], topN = 10) {
  // Weight title terms more heavily for TF.
  const titleTokens = tokenise(title || '');
  const contentTokens = tokenise(content || '');
  const allTokens = [...titleTokens, ...titleTokens, ...contentTokens];

  if (allTokens.length === 0) return [];

  // Term frequency in target note.
  const tf = {};
  for (const word of allTokens) {
    tf[word] = (tf[word] || 0) + 1;
  }

  // Document frequency from user corpus.
  const corpus = Array.isArray(documents) ? documents : [];
  const docSets = corpus.map(doc => {
    const docTitle = doc?.title || '';
    const docContent = doc?.content || '';
    return new Set(tokenise(`${docTitle} ${docContent}`));
  });
  const docCount = docSets.length || 1;

  const scored = Object.entries(tf).map(([word, count]) => {
    let df = 0;
    for (const tokens of docSets) {
      if (tokens.has(word)) df += 1;
    }

    // Smoothed IDF prevents divide-by-zero and keeps stable scores on small corpora.
    const idf = Math.log((docCount + 1) / (df + 1)) + 1;
    const lengthBonus = 1 + Math.log(word.length);

    return {
      word,
      score: count * idf * lengthBonus
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map(s => s.word);
}

/**
 * Find how many keywords two notes share.
 * @param {string[]} kw1
 * @param {string[]} kw2
 * @returns {number}
 */
function sharedKeywordCount(kw1, kw2) {
  const set1 = new Set(kw1);
  return kw2.filter(k => set1.has(k)).length;
}

module.exports = { extractKeywords, sharedKeywordCount };
