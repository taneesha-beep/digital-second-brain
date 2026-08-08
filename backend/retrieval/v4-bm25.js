'use strict';

/**
 * v4-bm25.js — Phase 3.3. Okapi BM25, the standard non-neural baseline.
 *
 *   v1:  |A ∩ B| / |A|            set intersection over 10 selected words
 *   v2:  |A ∩ B| / |A ∪ B|        the same sets, symmetric denominator
 *   v3:  cos(vA, vB)              w = tf·idf, every term, L2-normalised
 *   v4:  Σ idf·qw·saturate(tf)    tf saturation (k1) + pivoted length norm (b)
 *
 *      score(q, D) = Σ            idf(t) · qw(t) · ─────── tf(t,D)·(k1+1) ───────
 *                  t ∈ q ∩ D                       tf(t,D) + k1·(1 − b + b·|D|/avgdl)
 *
 * WHY THIS RUNG IS DIFFERENT FROM THE THREE BELOW IT. v1, v2 and v3 all sit
 * downstream of one decade-old product constant — the top-10 keyword list, or
 * the threshold that was calibrated against it. Every comparison so far has
 * therefore been partly a measurement of that constant. BM25 is not downstream
 * of anything in this repo: it is 1994, it is what every new retrieval system
 * is still measured against, and its two knobs were chosen on TREC collections
 * that are not this one. That is what makes it the first honest opponent, and
 * it is also why it is NOT tuned before the registered comparison runs (below).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TUNING DECISION, WRITTEN BEFORE ANY GRID POINT EXISTS.
 *
 * Roadmap 3.3 says "start at k1 = 1.2, b = 0.75; tune on dev only". Two rulings
 * already on the books decide what that can mean for the REGISTERED comparison:
 *
 *   §14.2  "a swept v2 measured against an unswept v1 is not the registered
 *          experiment."
 *   §11.5  sweep-tuned-vs-shipped is registered on TEST, because "sweeps
 *          select; they do not test."
 *
 * v3 was never swept. So:
 *
 *   ladder-v3-v4 IS DEFAULT BM25 (k1 = 1.2, b = 0.75) AGAINST UNTUNED v3.
 *
 * Both sides carry zero cooking-dev selection, and the p-value means what it
 * says. The alternative — tuned BM25 against unswept v3 — would price "BM25
 * plus a 99-point search over the same 2,304 queries the bootstrap resamples"
 * against "v3 with no search at all", which is the circularity §11.5 named in
 * advance.
 *
 * The defaults are not a handicap. k1 = 1.2 / b = 0.75 carry a decade of
 * selection — on other corpora. That is exactly what makes BM25 a fair opponent
 * here rather than a weak one.
 *
 * CONSEQUENCES, DECLARED NOW SO THEY CANNOT LOOK LIKE LATER DECISIONS:
 *   - The swept optimum ships as a SEPARATE label, v4-bm25-tuned, EXPLORATORY.
 *     It does not become v4-bm25 whatever it scores. sweep-v4.js declares the
 *     selection rule in the same commit, before the grid runs.
 *   - registry.json's ladder-v4-v5 therefore compares v5 against DEFAULT v4 at
 *     3.4, and 3.5's RRF constant hits the identical question. The general rule,
 *     stated once: LADDER RUNGS SHIP UNTUNED; tuning is measured beside them.
 *     That keeps every ladder comparison a comparison of algorithms rather than
 *     of search budgets.
 *   - No registry entry is added for tuned-vs-default. An eighth entry would
 *     retroactively tighten Holm from α/7 = 0.00714 to α/8 = 0.00625 for every
 *     comparison already run. If 3.6 wants that number on test, 3.6 registers it.
 * ─────────────────────────────────────────────────────────────────────────
 * k1 AND b DO NOT TOUCH THE INDEX, AND THE ROADMAP SAYS THEY DO.
 *
 * Roadmap 3.3 inherits from 2.7 the claim that "k1 and b both change the index,
 * so unlike 2.7's threshold and cap they cannot reuse a cached one". Checked
 * rather than inherited: it is FALSE for a standard BM25. The index holds
 * postings of (docIndex, tf), per-document lengths, df, N and avgdl. None of
 * those mention k1 or b. Both act at scoring time.
 *
 * It WOULD have been true of a v3-style implementation, and that is the real
 * content of the correction. v3 bakes the finished weight tf·idf into its
 * postings (v3-tfidf.js:303, postingsWeights). Precomputing the BM25 term
 * weight the same way makes the postings a function of k1 and b. So this file
 * STORES RAW tf AND DEFERS SATURATION TO rank(), which costs one divide per
 * postings visit and buys the property.
 *
 * The property is enforced, not documented: buildIndex() never reads
 * params.k1 or params.b, the per-document normalisation factor is memoised
 * LAZILY on first rank(), and a test indexes at (1.2, 0.75) and (2.5, 0.1) and
 * asserts every persistent structure is identical.
 *
 * The consequence for the sweep is smaller than 2.7 expected, and is reported
 * rather than optimised away: §13.10 measured a per-point re-index at 1.65 s of
 * each 2.89 s point (57%). Here index() is ~1.5 s against a ~15-20 s search, so
 * a re-index per point is ~8%. The ~30-line runner mode 3.3 budgets for is
 * therefore NOT written — the cost that motivated it does not exist, and the
 * property it wanted is better established by the test above.
 * ─────────────────────────────────────────────────────────────────────────
 * NEGATIVE IDF: WHY THE VARIANT IS A PARAM, AND WHAT WOULD BREAK.
 *
 * Robertson/Sparck-Jones is  ln((N − df + 0.5) / (df + 0.5)),  which is
 * NEGATIVE for df > N/2. On cooking the maximum df is 5,150 ("recipe", 18.8% of
 * the corpus), so it never fires — which is precisely why it is easy to ship
 * unnoticed. It would fire on a corpus with a term in most documents, and a
 * note-taking app's own corpus is exactly the kind that could have one.
 *
 * What a negative idf would do here, specifically:
 *
 *   - assertHits WOULD NOT CATCH IT. types.js checks Number.isFinite(score) and
 *     descending order. A negative score is finite and sorts perfectly. So a
 *     document that is EVIDENCE AGAINST the query is returned as a hit and
 *     written to the run file as a retrieval — an anti-match presented as a
 *     result, invisible to every guard the interface has.
 *   - v3's [0,1] INVARIANT CANNOT BE INHERITED. v3 asserts 0 <= score <= 1+1e-9
 *     inside rank() because a cosine of non-negative vectors is bounded. BM25 is
 *     an unbounded sum and has no such bound at either end.
 *
 * DECISION: default idfVariant 'lucene' — ln(1 + (N − df + 0.5)/(df + 0.5)) —
 * which is strictly positive for every df <= N by construction, so the
 * invariant v4 CAN assert is score > 0 for any candidate (candidates come from
 * the query's postings, so every one shares at least one term). 'robertson' is
 * the ablation arm; under it only finiteness is assertable, because there
 * negativity is the formula working as designed rather than a defect.
 *
 * And it is RECORDED rather than assumed away: buildIndex counts terms whose
 * idf <= 0 and the count reaches the sidecar. On cooking it is 0 under both
 * variants, and that zero being in the provenance is the difference between
 * "it does not happen here" and "nobody checked".
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT |D| IS, AND WHAT v4 INHERITS FROM v3.
 *
 * BM25's length normalisation reads TOTAL TOKENS. v3's vectors read DISTINCT
 * terms (mean 36.5). Those are different quantities and substituting the second
 * would be a different retriever wearing BM25's name. So:
 *
 *     |D| = titleWeight · |tokenise(title)| + |tokenise(body)|
 *
 * counted with repetition, after the same stopword/length-3 filter.
 *
 *   tokenise + STOPWORDS  INHERITED from v1, imported, unchanged. The tokenizer
 *              decides what the corpus IS; changing it makes every rung on the
 *              ladder incomparable at once. So v4 does import v1 — for
 *              tokenise() and nothing else, exactly as v3 does — and
 *              eval/source-digest.js records that rather than leaving it to be
 *              read off the source.
 *
 *   df table   IDENTICAL TO v3'S, asserted by a test. Both count one document
 *              per term from new Set(tokenise(title + ' ' + body)), so the title
 *              doubling cannot reach a Set. Only the FORMULA mapping df to idf
 *              changes, not the counts.
 *
 *   titleWeight  INHERITED BEHAVIOUR, NEWLY A PARAM. keywords.js:59 doubles the
 *              title and v1, v2 and v3 all hard-code it. Kept at 2 per §15.1's
 *              principle — a rung changes how a PAIR is scored, not how a
 *              DOCUMENT is read — but it is newly interesting, because under
 *              BM25 the doubling feeds |D| as well as tf, which it never did
 *              before (v3's L2 norm absorbed it differently). Made a param so
 *              the ablation is a flip and the choice lands in the digest.
 *
 *   idfCorpus  DROPPED, AND THIS IS THE ONE PARAM HELD CONSTANT v1 -> v2 -> v3.
 *              Not dropped for convenience — it has NO REFERENT here. v3's
 *              leave-one-out was exact for a stated reason (§15.1): a document's
 *              vector holds only terms it contains, so df_loo = df − 1 for every
 *              such document, giving one global table. BM25's idf multiplies a
 *              (query, document) pair where BOTH contain t, so "leave one out"
 *              is ambiguous between df − 1 (exclude the query) and df − 2
 *              (exclude both), with no principled tiebreak. v4 uses full-corpus
 *              N and df. The cost is measured rather than waved at: see
 *              idfDelta() below, which reports max |idf(df) − idf(df−1)| over
 *              the vocabulary. It is NOT uniformly negligible — at df = 1 it is
 *              ~1.1 nats — and saying so is the point of measuring it.
 *
 *   lengthBonus  DROPPED. It only ordered terms for slice(0, topN) and there is
 *              no topN. §15.4b already proved it inert at full vocabulary by a
 *              byte-identical run.
 *   topN       DROPPED. Full vocabulary by construction; §15.4a priced the
 *              truncation at +0.0289 on v3.
 *   minShared  DROPPED. §15.4c priced it on v3 (+0.0023, CI straddling zero) and
 *              v3 declined it. Same structure here — candidates come from the
 *              query's postings — so carrying the handle re-asks a settled
 *              question.
 *   threshold / scorePrecision / cap  ABSENT. §15.2's reasoning transfers
 *              unchanged, and `cap` was pre-registered absent FOR v4
 *              SPECIFICALLY at 3.1 (types.js, §14.3).
 * ─────────────────────────────────────────────────────────────────────────
 * v4 IS NOT SYMMETRIC, AND THAT IS A PROPERTY THE LADDER HAD.
 *
 * score(A -> B) != score(B -> A). BM25 is a query-document function: the
 * document side is length-normalised and saturated, the query side is neither.
 * v2 ESTABLISHED symmetry as a property of the algorithm (§14.5, exact float
 * equality, with v1 put through the same test and failing it) and v3 preserved
 * it at real cost (§15.8: sorted term ids, so the two directions accumulate
 * bit-identically). v4 gives it back.
 *
 * That is stated here and MEASURED by a test — the same shape §14.5 used to
 * measure v1's asymmetry — rather than left as an omission, because it hands
 * Phase 4 a genuine tension: bidirectional note links are what v2 was built for,
 * so a winning v4 re-introduces the direction-dependence v2 removed.
 * ─────────────────────────────────────────────────────────────────────────
 * COST. Postings are (Int32 docIndex, Int32 tf) pairs — 8 bytes per posting
 * against v3's 12 (Int32 + Float64) — over the same Σ_t df_t = 997,749 postings
 * v3 measured, plus one Float64 length ratio per document. The per-query walk is
 * the same Σ_{t∈q} df_t ≈ 31,000 visits (§15.6); what changes is one divide per
 * visit where v3 had a multiply. Measured at 3.3 rather than predicted here.
 *
 * rank() collects every candidate rather than pre-truncating with ctx.k, for
 * §15.6's reason unchanged: collecting everything is the version whose
 * equivalence to the interface contract needs no argument, because it IS the
 * contract.
 */

const v1 = require('./v1-overlap');

/** k1 large enough that saturation is off to within float noise — the chain's linear-tf arm. */
const K1_LINEAR = 1e6;

const defaultParams = {
  /**
   * TF SATURATION. The textbook default, and deliberately NOT selected on this
   * corpus — see the tuning block above.
   *
   * Two endpoints worth knowing, because both are on the sweep grid:
   *   k1 = 0    -> tf·1/(tf + 0) = 1. Binary tf; term frequency is discarded.
   *   k1 -> inf -> tf/(1 − b + b·|D|/avgdl). Linear tf, saturation off.
   *
   * At tf = 1 and |D| = avgdl the factor is exactly 1 for EVERY k1, so k1 can
   * only act on repeated terms. On questions averaging 36.5 distinct terms most
   * tf are small, so a nearly-flat k1 axis is the expected shape rather than a
   * defect — and if the axis is flat to the last bit, that is the check that tf
   * is not reaching the scorer at all.
   */
  k1: 1.2,
  /**
   * LENGTH NORMALISATION, pivoted between none and full.
   *   b = 0 -> (1 − 0 + 0) = 1, no length normalisation whatsoever.
   *   b = 1 -> full: divide by |D|/avgdl.
   * v3 already normalises by the L2 norm, so this axis is NOT the usual
   * "BM25 versus unnormalised tf-idf" gap. It is one normaliser against another.
   */
  b: 0.75,
  /**
   * WHICH IDF. 'lucene' is strictly positive by construction; 'robertson' is
   * the classical form and goes negative for df > N/2. See the header.
   */
  idfVariant: 'lucene',
  /**
   * THE QUERY SIDE. Robertson's BM25 carries a query-term saturation
   * (k3+1)·qtf/(k3+qtf); k3 is universally taken to a limit and the two limits
   * are the two settings here:
   *
   *   'linear'  k3 -> inf, qw = qtf. Robertson's default, and what Lucene does
   *             for a bag-of-terms query (one clause per occurrence).
   *   'binary'  k3 = 0, qw = 1. The query is a set of terms.
   *
   * This is not a formality here and that is worth stating: elsewhere BM25's
   * queries are a handful of words where qtf is 1 by default. Ours ARE
   * DOCUMENTS, with real term frequencies reaching the hundreds — so 'linear'
   * means the query side has NO saturation while the document side has k1,
   * which is an asymmetry BM25 was never asked to justify. Default is 'linear'
   * because it is the standard; 'binary' is the ablation.
   */
  qtfMode: 'linear',
  /**
   * THE INHERITED TITLE DOUBLING, made explicit. keywords.js:59. See the header.
   * Affects tf AND |D|; does not affect df, which is counted over a Set.
   */
  titleWeight: 2
};

/**
 * max |idf(df) − idf(df−1)| over the vocabulary — the price of dropping
 * leave-one-out, measured rather than asserted. Reported by analyse-bm25.js and
 * recorded in the writeup; not used in scoring.
 */
function idfDelta(state) {
  let max = 0;
  let atDf = null;
  let atTerm = null;
  for (const [term, df] of state.df) {
    if (df < 2) {
      // df − 1 = 0 means "the query is the only document holding this term", in
      // which case there is no candidate to score and the question is moot. The
      // comparable pair is df=1 read as df vs df-1 -> 0, which is the extreme
      // and is reported separately by the caller rather than folded into a max
      // over cases that cannot arise.
      continue;
    }
    const d = Math.abs(idfFor(state.idfVariant, state.n, df) - idfFor(state.idfVariant, state.n, df - 1));
    if (d > max) { max = d; atDf = df; atTerm = term; }
  }
  return { max, atDf, atTerm };
}

function idfFor(variant, n, df) {
  const ratio = (n - df + 0.5) / (df + 0.5);
  // 'lucene' adds 1 inside the log, which keeps the argument above 1 for every
  // df <= n and therefore the idf strictly positive. 'robertson' does not, and
  // goes negative once df > n/2.
  return variant === 'lucene' ? Math.log(1 + ratio) : Math.log(ratio);
}

function buildIndex(docs, params) {
  // NOTE FOR THE READER AND FOR THE TEST: params.k1 and params.b are NOT read
  // anywhere in this function. That is the property, and
  // tests/retrieval.v4-bm25.test.js asserts it by indexing twice.
  if (!['lucene', 'robertson'].includes(params.idfVariant)) {
    throw new Error(`v4-bm25: idfVariant must be lucene or robertson (got ${JSON.stringify(params.idfVariant)})`);
  }
  if (!['linear', 'binary'].includes(params.qtfMode)) {
    throw new Error(`v4-bm25: qtfMode must be linear or binary (got ${JSON.stringify(params.qtfMode)})`);
  }
  if (!Number.isInteger(params.titleWeight) || params.titleWeight < 0) {
    throw new Error(`v4-bm25: titleWeight must be a non-negative integer (got ${JSON.stringify(params.titleWeight)})`);
  }
  // k1 and b are validated here even though they are not USED here: a bad value
  // should fail at handle construction rather than after 2,304 queries, which
  // is §14.8's rule for cap. Negative k1 inverts the saturation curve; b outside
  // [0,1] makes the pivot factor non-monotone or negative in |D|.
  if (!(typeof params.k1 === 'number' && Number.isFinite(params.k1) && params.k1 >= 0)) {
    throw new Error(`v4-bm25: k1 must be a finite number >= 0 (got ${JSON.stringify(params.k1)})`);
  }
  if (!(typeof params.b === 'number' && params.b >= 0 && params.b <= 1)) {
    throw new Error(`v4-bm25: b must be a number in [0, 1] (got ${JSON.stringify(params.b)})`);
  }

  const n = docs.length;

  // Document frequency: one document per term, from a Set — v3-tfidf.js:194 and
  // v1-overlap.js:203 verbatim. The title doubling cannot reach a Set, so v4's
  // df counts are IDENTICAL to v3's and a test asserts it. Only the formula
  // turning df into idf differs.
  const dfSets = docs.map((doc) => new Set(v1.tokenise(`${doc.title || ''} ${doc.body || ''}`)));
  const df = new Map();
  for (const set of dfSets) {
    for (const word of set) df.set(word, (df.get(word) || 0) + 1);
  }

  // Sorted vocabulary for term ids, as v3 does. v4 does not need it for
  // bit-symmetry — it is not symmetric — but it keeps the postings order a
  // function of the vocabulary rather than of corpus order, so a reversed corpus
  // produces byte-identical output. A test asserts that.
  const vocabulary = [...df.keys()].sort();
  const termIds = new Map();
  for (let t = 0; t < vocabulary.length; t += 1) termIds.set(vocabulary[t], t);

  const idf = new Float64Array(vocabulary.length);
  let nonPositiveIdfTerms = 0;
  let minIdf = Infinity;
  let maxIdf = -Infinity;
  for (let t = 0; t < vocabulary.length; t += 1) {
    const value = idfFor(params.idfVariant, n, df.get(vocabulary[t]));
    idf[t] = value;
    if (value <= 0) nonPositiveIdfTerms += 1;
    if (value < minIdf) minIdf = value;
    if (value > maxIdf) maxIdf = value;
  }
  if (params.idfVariant === 'lucene' && nonPositiveIdfTerms > 0) {
    // Impossible by construction — ln(1 + x) > 0 for x > 0, and the argument is
    // positive for every df <= n. Reaching here means the df table or n is
    // wrong, so it stops rather than emitting anti-matches that assertHits
    // cannot see.
    throw new Error(
      `v4-bm25: ${nonPositiveIdfTerms} terms have idf <= 0 under the lucene variant, ` +
        'which is impossible for df <= N. The df table or the document count is wrong.'
    );
  }

  const indexById = new Map();
  const idByIndex = new Array(n);
  const docTerms = new Array(n);   // Int32Array of term ids, ascending
  const docTfs = new Array(n);     // Int32Array, aligned with docTerms
  const lengths = new Float64Array(n);
  const rawPostings = vocabulary.map(() => []);

  let totalLength = 0;
  for (let i = 0; i < n; i += 1) {
    const doc = docs[i];
    indexById.set(doc.id, i);
    idByIndex[i] = doc.id;

    // keywords.js:59 — the title is tokenised and concatenated titleWeight
    // times, so title terms enter tf at that weight AND |D| with them. The
    // second half is new at this rung: v1/v2/v3 never had a length in the
    // denominator for the doubling to inflate.
    const titleTokens = v1.tokenise(doc.title || '');
    const allTokens = [];
    for (let w = 0; w < params.titleWeight; w += 1) allTokens.push(...titleTokens);
    allTokens.push(...v1.tokenise(doc.body || ''));

    const tf = new Map();
    for (const word of allTokens) tf.set(word, (tf.get(word) || 0) + 1);

    // |D| is TOTAL TOKENS WITH REPETITION, not distinct terms. That is what
    // BM25's normalisation reads and it is a different quantity from the one
    // v3's vectors carry (mean 36.5 distinct). See the header.
    lengths[i] = allTokens.length;
    totalLength += allTokens.length;

    const entries = [...tf.entries()].sort((x, y) => termIds.get(x[0]) - termIds.get(y[0]));
    const ids = new Int32Array(entries.length);
    const counts = new Int32Array(entries.length);
    for (let j = 0; j < entries.length; j += 1) {
      const termId = termIds.get(entries[j][0]);
      ids[j] = termId;
      counts[j] = entries[j][1];
      // RAW tf in the postings, not a finished weight. This is what makes k1
      // and b scoring-time params — see the header block.
      rawPostings[termId].push(i, entries[j][1]);
    }
    docTerms[i] = ids;
    docTfs[i] = counts;
  }

  // A corpus of zero-length documents would divide by zero here. Every document
  // that reaches a postings list has at least one token, so avgdl > 0 whenever
  // there is anything to retrieve; the guard covers the empty-corpus case rather
  // than letting NaN propagate into every score.
  const avgdl = n > 0 && totalLength > 0 ? totalLength / n : 1;

  // Precomputed per document, and b-INDEPENDENT: (|D|/avgdl − 1). The pivot
  // factor is then 1 + b·that, which rank() forms from params. Keeping the
  // b-dependent part out of here is what makes b a scoring-time param.
  const lengthRatioMinus1 = new Float64Array(n);
  for (let i = 0; i < n; i += 1) lengthRatioMinus1[i] = lengths[i] / avgdl - 1;

  const postingsDocs = [];
  const postingsTfs = [];
  for (let t = 0; t < rawPostings.length; t += 1) {
    const flat = rawPostings[t];
    const docsArr = new Int32Array(flat.length / 2);
    const tfArr = new Int32Array(flat.length / 2);
    for (let j = 0, m = 0; j < flat.length; j += 2, m += 1) {
      docsArr[m] = flat[j];
      tfArr[m] = flat[j + 1];
    }
    postingsDocs.push(docsArr);
    postingsTfs.push(tfArr);
  }

  return {
    params,
    n,
    df,
    idfVariant: params.idfVariant,
    indexById,
    idByIndex,
    termIds,
    idf,
    docTerms,
    docTfs,
    lengths,
    avgdl,
    lengthRatioMinus1,
    postingsDocs,
    postingsTfs,
    vocabularySize: vocabulary.length,
    idfRange: [minIdf, maxIdf],
    nonPositiveIdfTerms,
    // LAZY, and lazy on purpose: k1·(1 + b·lengthRatioMinus1[i]) depends on both
    // scoring params, so computing it in buildIndex would make buildIndex a
    // function of k1 and b — the exact property this rung set out to disprove.
    // Params are frozen for a handle's life, so one pass on first rank() is
    // correct and costs 27,325 ops once.
    _k1Norm: null,
    _acc: new Float64Array(n),
    _shared: new Int32Array(n),
    _touched: new Int32Array(n)
  };
}

function rank(state, queryDoc, ctx) {
  const {
    params, indexById, idByIndex, docTerms, docTfs, idf,
    postingsDocs, postingsTfs, lengthRatioMinus1
  } = state;

  if (state._k1Norm === null) {
    const cache = new Float64Array(state.n);
    for (let i = 0; i < state.n; i += 1) {
      cache[i] = params.k1 * (1 + params.b * lengthRatioMinus1[i]);
    }
    state._k1Norm = cache;
  }
  const k1Norm = state._k1Norm;
  const k1Plus1 = params.k1 + 1;
  const linearQtf = params.qtfMode === 'linear';

  const acc = state._acc;
  const shared = state._shared;
  const touched = state._touched;

  const qi = indexById.get(queryDoc.id);
  const qTerms = docTerms[qi];
  const qTfs = docTfs[qi];

  let nTouched = 0;
  try {
    for (let j = 0; j < qTerms.length; j += 1) {
      const termId = qTerms[j];
      // idf · qw folded into one constant per query term, so the inner loop is
      // one multiply, one add and one divide.
      const qw = (linearQtf ? qTfs[j] : 1) * idf[termId];
      const bucket = postingsDocs[termId];
      const bucketTf = postingsTfs[termId];
      for (let p = 0; p < bucket.length; p += 1) {
        const di = bucket[p];
        if (shared[di] === 0) {
          touched[nTouched] = di;
          nTouched += 1;
          acc[di] = 0;
        }
        const tf = bucketTf[p];
        acc[di] += qw * (tf * k1Plus1) / (tf + k1Norm[di]);
        shared[di] += 1;
      }
    }

    for (let z = 0; z < nTouched; z += 1) {
      const di = touched[z];
      if (di === qi) continue;
      const score = acc[di];
      if (!Number.isFinite(score)) {
        throw new Error(`v4-bm25: non-finite score ${score} for ${queryDoc.id} -> ${idByIndex[di]}`);
      }
      if (params.idfVariant === 'lucene' && !(score > 0)) {
        // Under 'lucene' every idf is strictly positive and every candidate
        // shares at least one term, so a non-positive score is a defect rather
        // than an edge case. There is deliberately NO equivalent assertion
        // under 'robertson': a negative score there is the formula working as
        // designed, and asserting it away would hide the behaviour the variant
        // exists to expose. v3's [0,1] bound has no analogue at all — BM25 is
        // an unbounded sum.
        throw new Error(
          `v4-bm25: score ${score} is not positive for ${queryDoc.id} -> ${idByIndex[di]} ` +
            'under the lucene idf, where every term contribution is positive.'
        );
      }
      // Same shape as v3's explain, deliberately: the ladder already carries
      // three shapes ({sharedKeywords} for v1/v2, {shared} for v3, none for v5)
      // and Phase 7.4 is the consumer. v4 adds no fourth.
      ctx.collect(idByIndex[di], score, { shared: shared[di] });
    }
  } finally {
    for (let z = 0; z < nTouched; z += 1) {
      const di = touched[z];
      acc[di] = 0;
      shared[di] = 0;
    }
  }
}

/**
 * Distinct terms in this document — the quantity analyse-rungs.js stratifies by.
 * Comparable to v3's (both are distinct-term counts at full vocabulary) and NOT
 * to v1's or v2's, which are top-10 selection lengths capped at 10. types.js
 * records that the caller must say which it is reporting.
 *
 * Note this is NOT |D|: the BM25 length is total tokens with repetition and the
 * title counted titleWeight times, which is a larger number. state.lengths holds
 * that one.
 */
function termCount(state, docId) {
  return state.docTerms[state.indexById.get(docId)].length;
}

module.exports = {
  version: 'v4-bm25',
  defaultParams,
  buildIndex,
  rank,
  termCount,
  /**
   * BM25 is a QUERY-document function: the document side is length-normalised
   * and tf-saturated, the query side is neither. §14.5's amendment measured
   * 190 of 197 reachable fixture pairs disagreeing between the two directions,
   * with every symmetric exception at |A| = |B|. The winning rung is the
   * asymmetric one, which is the tension Phase 4.2 inherits — and from 3.4 it
   * inherits it as a field in the sidecar rather than as a paragraph.
   */
  symmetric: false,
  // Not part of the interface — read by scripts/analyse-bm25.js, which is
  // read-only and reports the corpus statistics 3.3's Done criterion names.
  idfFor,
  idfDelta,
  K1_LINEAR
};
