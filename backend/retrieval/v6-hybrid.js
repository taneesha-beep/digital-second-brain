'use strict';

/**
 * v6-hybrid.js — Phase 3.5. Reciprocal Rank Fusion of BM25 and dense.
 *
 *   v1:  |A ∩ B| / |A|            set intersection over 10 selected words
 *   v2:  |A ∩ B| / |A ∪ B|        the same sets, symmetric denominator
 *   v3:  cos(vA, vB)              w = tf·idf, every term, L2-normalised
 *   v4:  Σ idf·qw·saturate(tf)    tf saturation (k1) + pivoted length norm (b)
 *   v5:  cos(eA, eB)              e = mean-pooled MiniLM, 384 dims, exact search
 *   v6:  Σ_r 1/(rrfK + rank_r)    RRF over v4's and v5's rankings
 *
 *      score(q, d) = Σ            ─────── 1 ───────
 *                 r ∈ {bm25,dense}  rrfK + rank_r(q, d)
 *
 * rank_r is 1-BASED and comes from component r's own ranked list for this
 * query. A document ABSENT from r's candidate list contributes nothing from r —
 * the standard RRF convention (Cormack, Clarke & Buettcher 2009), and the one
 * that makes this identical to fusing the two components' full-depth run files.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT v6 IS ARCHITECTURALLY, AND WHY IT IS NOT TWO RUN FILES.
 *
 * RRF fuses ranked LISTS, and the obvious cheap implementation reads
 * results/runs/v4-bm25.dev.run and results/runs/v5-embeddings.dev.run and
 * merges them. That is not a retriever and it is rejected on four counts, only
 * the first of which is about purity:
 *
 *   1. It needs fs. tests/retrieval.interface.test.js walks the require graph
 *      of this directory and fails on any specifier resolving outside it.
 *   2. It would make the RUNG a function of two ARTIFACTS rather than of the
 *      documents — so "what produced this number" stops being the corpus plus a
 *      params digest and becomes two files that happen to be lying around.
 *   3. It could not run in the app at Phase 4.1, which is the entire reason
 *      §7.1 draws the boundary where it does.
 *   4. THE COMMITTED RUN FILES ARE TRUNCATED AT kMax = 10. Fusing them could
 *      only ever fuse depth-10 lists, which is a different retriever from the
 *      one the roadmap names.
 *
 * So buildIndex() constructs BOTH component indexes inside itself, by calling
 * v4's and v5's own buildIndex with param objects sliced out of its own. The
 * cost is the sum of theirs and is reported rather than hidden: ~982 ms + 36 ms
 * of index build (§16.12, §17.11), both components' memory live at once, and
 * three large sorts per query where v5 does one. v6 is the slowest rung on the
 * ladder and the environment block says so.
 *
 * WHAT THIS BUYS BACK: at full depth this computes exactly what fusing two
 * complete run files would produce, so option 4 above is not given up, only
 * paid for properly. tests/retrieval.v6-hybrid.test.js asserts that equivalence
 * against standalone search() calls rather than leaving it as a claim.
 *
 * THE SOURCE DIGEST NAMES THE DEPENDENCIES. eval/source-digest.js traverses the
 * relative requires below, so v6's file list is SIX files — v6-hybrid.js,
 * v5-embeddings.js, v4-bm25.js, v1-overlap.js (reached through v4, for
 * tokenise()), types.js and index.js — where v5's is three and v4's is four. An
 * edit to either component moves v6's digest, which is the property 3.2 built
 * that file for. A test asserts the list.
 * ─────────────────────────────────────────────────────────────────────────
 * RRF DISCARDS SCORE MAGNITUDE, AND THAT IS ADDRESSED IN THE DESIGN RATHER THAN
 * DISCOVERED IN THE RESULTS.
 *
 * §16.11 flagged this a rung in advance. v4's `qtfMode` ablation was worth
 * +0.0456 — larger than the whole v3→v4 rung — purely because the "queries"
 * here are DOCUMENTS with real term frequencies, so the query side carries
 * magnitude information a keyword query would not have. v5's `normalise`
 * ablation was worth +0.2007, the largest anywhere on the ladder, and it is
 * also a magnitude question. Fusing by RANK throws away exactly that class of
 * information, on BOTH sides: a cosine of 0.92 at rank 1 and a cosine of 0.31
 * at rank 1 become the same number.
 *
 * That is a real cost and it is not a reason to change the rung. RRF at
 * rrfK = 60 IS the rung, because that is what roadmap 3.5 and the literature
 * name, and §16.3's rule is that ladder rungs ship as the algorithm rather than
 * as a locally-improved variant of it. The score-normalising alternative is
 * measured BESIDE it as a one-variable ablation: `fusion: 'minmax-sum'`, which
 * is CombSUM over per-query min-max normalised component scores. If magnitude
 * matters here, that ablation is where it shows up.
 * ─────────────────────────────────────────────────────────────────────────
 * SYMMETRY: FALSE, AND THE REASON IS SHARPER THAN "BM25 IS ASYMMETRIC".
 *
 * §17.10 predicted the fused ranking would be asymmetric because v6 fuses an
 * asymmetric BM25 with a symmetric dense score. True, and it understates it.
 *
 *   RANK IS A PROPERTY OF A LIST, NOT OF A PAIR.
 *
 * score_v6(A→B) reads B's position in the two lists ranked against A;
 * score_v6(B→A) reads A's position in the two lists ranked against B. Those are
 * four different lists. So even the DENSE half is asymmetric once expressed as
 * a rank: cos(A,B) === cos(B,A) at exact float equality, and B can still be A's
 * nearest neighbour while A is not B's. A rank fusion of two perfectly
 * score-symmetric retrievers is still asymmetric.
 *
 * Making it symmetric would mean scoring f(A,B) + f(B,A), which requires
 * ranking the corpus from BOTH endpoints — n× the per-query cost, and a
 * different retriever. Declared false here, MEASURED by
 * tests/retrieval.symmetry.test.js, which fails a disagreement in either
 * direction. Phase 4.2 is the consumer: if v6 wins the ladder, a bidirectional
 * link graph built from it has to pick a direction again, exactly as it did
 * when v4 was the winner.
 * ─────────────────────────────────────────────────────────────────────────
 * NO CHAIN, AND FOR THE OPPOSITE REASON TO v5's — DECIDED BEFORE RUNNING.
 *
 * §15.5 and §16.7 built telescoping one-variable chains closing at exact float
 * equality; §17.5 declined one because v4 and v5 share no term space, so the
 * intermediate retrievers have no definition. v6 is a third case: its
 * components ARE runnable retrievers, so the intermediates exist. They are just
 * already on the ladder.
 *
 *   RRF over ONE list is that list. 1/(rrfK + rank) is strictly decreasing in
 *   rank, and ranks within one list are distinct, so the induced order IS the
 *   rank order. RRF(dense alone) === v5. RRF(bm25 alone) === v4.
 *
 * So a chain from v5 to v6 is one step that is identically zero by construction
 * followed by one step that is the entire registered margin. That is the
 * comparison with a tautology in front of it, not a decomposition — and
 * §16.7's rule is for comparisons moving SEVERAL behaviours, where adding a
 * component is one. The premise is tested rather than asserted: the single-
 * component identity above is a test, and if it fails the fusion is wrong and
 * nothing downstream means anything.
 * ─────────────────────────────────────────────────────────────────────────
 * NO `explain`, KEEPING THE LADDER AT THREE SHAPES.
 *
 * {sharedKeywords} for v1/v2, {shared: n} for v3/v4, none for v5 and none here.
 * v6 could emit {rankBm25, rankDense} and it would genuinely be informative —
 * it is the one rung where "why did this rank" has a short honest answer. It is
 * still not emitted: 7.4 is the only consumer, it does not exist, and a fourth
 * shape ships a contract nobody has designed against. The component ranks are
 * recoverable — scripts/analyse-hybrid.js rebuilds the index and reports them.
 * Emitting v4's {shared: n} would be worse than nothing, because the shared
 * term count is not what ranked the document.
 */

const { compareHits } = require('./types');
const v4 = require('./v4-bm25');
const v5 = require('./v5-embeddings');

/**
 * The component param keys, sliced out of v6's flat params.
 *
 * FLAT RATHER THAN NESTED, and the reason is mechanical rather than aesthetic:
 * run-eval.js fires its vectors loader on `resolved.vectors !== undefined` at
 * TOP LEVEL. Keeping `vectors` flat means the runner needs no change at all —
 * resolvedParamsFor('v6-hybrid') hands it the slug, it loads the file,
 * re-hashes it against the manifest, checks corpusSha256 and idsSha256 against
 * the corpus actually loaded (§17.2's row-misalignment guard), and attaches
 * doc.vector. A nested {dense: {vectors}} would have needed run-eval.js to
 * learn about nesting, i.e. a second place that knows the shape of params.
 *
 * v4's five keys and v5's three do not collide, so the flattening is lossless.
 * Asserted below rather than eyeballed.
 */
const BM25_PARAM_KEYS = ['k1', 'b', 'idfVariant', 'qtfMode', 'titleWeight'];
const DENSE_PARAM_KEYS = ['vectors', 'dim', 'normalise'];

const FUSIONS = ['rrf', 'minmax-sum'];

const defaultParams = {
  /**
   * RRF's k, at the value Cormack et al. 2009 published and everyone since has
   * used. NAMED rrfK, NOT k: `k` already means retrieval depth throughout this
   * repo — search(handle, query, k), kMax, nDCG@k — and a param called `k`
   * sitting next to all of them is a defect waiting to be introduced.
   *
   * SHIPPED UNTUNED, per §16.3's rule, settled at 3.3 so 3.4 and 3.5 do not
   * re-litigate it: LADDER RUNGS SHIP UNTUNED; TUNING IS MEASURED BESIDE THEM.
   * scripts/sweep-v6.js sweeps it on dev and the selected point ships as a
   * separate EXPLORATORY label. registry.json is NOT edited — an eighth entry
   * would retroactively tighten Holm from α/7 to α/8 for every comparison
   * already run.
   *
   * Two endpoints worth knowing, both on the sweep grid:
   *   rrfK = 0    -> 1/rank. Maximally top-heavy; rank 1 is worth 2× rank 2.
   *   rrfK -> inf -> 1/rrfK · (1 − rank/rrfK + …), so the ordering tends to
   *                  SUM OF RANKS, i.e. Borda. Not reachable; 1000 approximates
   *                  it and is on the grid as the far endpoint.
   * The published 60 sits deliberately far from both: it damps the top few
   * ranks so a single system cannot dictate the fused order on its own.
   */
  rrfK: 60,
  /**
   * HOW THE TWO LISTS COMBINE. The §16.11 axis — see the header.
   *
   *   'rrf'         Σ 1/(rrfK + rank_r). Rank only; magnitude discarded.
   *   'minmax-sum'  Σ (s_r − min_r)/(max_r − min_r). CombSUM over per-query
   *                 min-max normalised scores. Magnitude preserved, at the cost
   *                 of being sensitive to each component's score distribution —
   *                 which is the thing RRF exists to avoid.
   *
   * Under 'minmax-sum' the `rrfK` param is INERT. It stays in the digest
   * anyway, because a param that silently disappears from a configuration is
   * §13.10's "run that lies about itself" in another costume; the writeup says
   * so in words instead.
   */
  fusion: 'rrf',
  /**
   * HOW MUCH OF EACH COMPONENT LIST ENTERS THE FUSION. null = all of it.
   *
   * The one arbitrary choice in this design, so it is a param and it gets
   * ablated rather than assumed. Real RRF deployments almost always fuse
   * truncated lists (top-1000 per system) because that is what a distributed
   * search tier returns. Here nothing forces a cut, so the default is the
   * assumption-free one — every candidate each component produces — and
   * `depth: 100` is run beside it to price what the tail is worth.
   *
   * Note the two pools are NOT the same size and that is correct, not a bug to
   * paper over: BM25 reaches only documents sharing at least one term, while
   * the dense component scores all n−1. A document BM25 cannot reach simply
   * gets no BM25 contribution, which is what "not retrieved" means in RRF.
   */
  depth: null,

  // ---- v4-bm25's five, verbatim. Same names, same defaults, same meanings. ----
  k1: 1.2,
  b: 0.75,
  idfVariant: 'lucene',
  qtfMode: 'linear',
  titleWeight: 2,

  // ---- v5-embeddings' three, verbatim. `vectors` must stay top-level. ----
  vectors: 'minilm-l6-v2-fp32-256',
  dim: 384,
  normalise: true
};

/** Slice a component's params out of the flat set, in a fixed key order. */
function subParams(params, keys) {
  const out = {};
  for (const key of keys) out[key] = params[key];
  return Object.freeze(out);
}

/**
 * A ctx that collects into an array instead of into the caller's results.
 *
 * v6 CANNOT hand the real ctx to both components: index.js's collect() throws
 * on a second collection of the same docId, and every document BM25 reaches is
 * also scored by the dense component. So each component gets its own collector,
 * and the collector mirrors collect()'s contract exactly — drop the query id,
 * reject duplicates — so a component behaves here precisely as it does under a
 * standalone search().
 */
function componentCtx(into, excludeId, k) {
  const seen = new Set();
  return {
    k,
    excludeId,
    collect(docId, score) {
      if (docId === excludeId) return;
      if (seen.has(docId)) throw new Error(`v6-hybrid: component collected ${docId} twice`);
      seen.add(docId);
      into.push({ docId, score });
    }
  };
}

function buildIndex(docs, params) {
  if (!(typeof params.rrfK === 'number' && Number.isFinite(params.rrfK) && params.rrfK >= 0)) {
    throw new Error(`v6-hybrid: rrfK must be a finite number >= 0 (got ${JSON.stringify(params.rrfK)})`);
  }
  if (!FUSIONS.includes(params.fusion)) {
    throw new Error(`v6-hybrid: fusion must be one of ${FUSIONS.join(', ')} (got ${JSON.stringify(params.fusion)})`);
  }
  if (params.depth !== null && !(Number.isInteger(params.depth) && params.depth >= 1)) {
    // Same shape as assertCapParam's reasoning (§13.10): a depth the fusion
    // cannot read produces a run at a depth its digest does not describe.
    throw new Error(`v6-hybrid: depth must be null or a positive integer (got ${JSON.stringify(params.depth)})`);
  }

  // The flattening is lossless only while the two key sets stay disjoint. A
  // future component sharing a name with an existing one would silently make
  // one param mean two things, which is the kind of defect that shows up as an
  // unexplainable ablation three sessions later.
  for (const key of BM25_PARAM_KEYS) {
    if (DENSE_PARAM_KEYS.includes(key)) {
      throw new Error(`v6-hybrid: param name ${key} is claimed by both components`);
    }
  }

  // Both components validate their own params, so a bad k1 or a missing vector
  // fails here at handle construction rather than after 2,304 queries.
  const bm25State = v4.buildIndex(docs, subParams(params, BM25_PARAM_KEYS));
  const denseState = v5.buildIndex(docs, subParams(params, DENSE_PARAM_KEYS));

  return {
    params,
    n: docs.length,
    bm25State,
    denseState
  };
}

/**
 * One component's contribution, added into `fused`.
 *
 * The list arrives already ordered by compareHits — the SAME comparator
 * index.js applies, which is what makes these ranks the ranks a standalone
 * search() over that component would report.
 */
function accumulate(fused, hits, params) {
  const limit = params.depth === null ? hits.length : Math.min(params.depth, hits.length);
  if (limit === 0) return;

  if (params.fusion === 'rrf') {
    for (let i = 0; i < limit; i += 1) {
      const rank = i + 1; // 1-BASED. rank 0 would make rrfK=0 divide by zero and
      // would silently double the top document's weight at every other rrfK.
      const contribution = 1 / (params.rrfK + rank);
      const docId = hits[i].docId;
      fused.set(docId, (fused.get(docId) || 0) + contribution);
    }
    return;
  }

  // 'minmax-sum'. Normalised per query and per component, over the TRUNCATED
  // list — normalising over the full list and then truncating would be a third
  // behaviour hiding inside the depth param.
  const max = hits[0].score;
  const min = hits[limit - 1].score;
  const spread = max - min;
  for (let i = 0; i < limit; i += 1) {
    // spread === 0 means every score in this list is equal, so every document
    // is jointly the best of it. 1 rather than 0: 0 would say the component
    // returned no information, and "all equally top" is not that. It also makes
    // the single-hit case (min === max === that hit) score 1, which is right.
    const normalised = spread > 0 ? (hits[i].score - min) / spread : 1;
    const docId = hits[i].docId;
    fused.set(docId, (fused.get(docId) || 0) + normalised);
  }
}

function rank(state, queryDoc, ctx) {
  const { params, bm25State, denseState } = state;

  // Full component lists, then ordered by the ladder's one comparator. Not
  // pre-truncated with ctx.k: a document outside a component's top-k can still
  // land in the fused top-k when the other component ranks it highly, which is
  // the entire mechanism this rung exists to exploit.
  const bm25Hits = [];
  v4.rank(bm25State, queryDoc, componentCtx(bm25Hits, queryDoc.id, ctx.k));
  bm25Hits.sort(compareHits);

  const denseHits = [];
  v5.rank(denseState, queryDoc, componentCtx(denseHits, queryDoc.id, ctx.k));
  denseHits.sort(compareHits);

  const fused = new Map();
  accumulate(fused, bm25Hits, params);
  accumulate(fused, denseHits, params);

  for (const [docId, score] of fused) {
    if (!Number.isFinite(score)) {
      throw new Error(`v6-hybrid: non-finite score ${score} for ${queryDoc.id} -> ${docId}`);
    }
    // No `explain`. See the header — the absence is a decision, not a gap.
    ctx.collect(docId, score, undefined);
  }
}

module.exports = {
  version: 'v6-hybrid',
  defaultParams,
  buildIndex,
  rank,
  /**
   * FALSE. Not merely because BM25 is asymmetric — because RANK IS A PROPERTY
   * OF A LIST, NOT OF A PAIR, so a rank fusion of two score-symmetric
   * retrievers would be asymmetric too. Full argument in the header.
   *
   * NOT a param: it describes the algorithm rather than configuring it, so it
   * stays out of the digest. MEASURED by tests/retrieval.symmetry.test.js,
   * which fails a disagreement in either direction.
   */
  symmetric: false,
  // No termCount(). v6 has a term space in one of its two halves, which is
  // worse than having none — reporting v4's distinct-term count as "v6's" would
  // describe half the retriever. analyse-rungs.js has stratified on a CORPUS
  // axis since 3.4 precisely so this question stops being the retriever's.
  //
  // Exported for scripts/analyse-hybrid.js, which is read-only and needs the
  // key sets to rebuild the component indexes without re-deriving them.
  BM25_PARAM_KEYS,
  DENSE_PARAM_KEYS,
  subParams,
  componentCtx
};
