'use strict';

/**
 * v5-embeddings.js — Phase 3.4. Dense retrieval, cosine over sentence embeddings.
 *
 *   v1:  |A ∩ B| / |A|            set intersection over 10 selected words
 *   v2:  |A ∩ B| / |A ∪ B|        the same sets, symmetric denominator
 *   v3:  cos(vA, vB)              w = tf·idf, every term, L2-normalised
 *   v4:  Σ idf·qw·saturate(tf)    tf saturation (k1) + pivoted length norm (b)
 *   v5:  cos(eA, eB)              e = mean-pooled MiniLM, 384 dims, exact search
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE VECTORS ARRIVE AS DATA. THIS FILE CONTAINS NO MODEL.
 *
 * EVALUATION.md §7.1: corpus preparation is anything needing I/O or a model;
 * the retriever is everything that is a pure function of the documents.
 * scripts/embed-corpus.js writes data/vectors/<site>.<slug>.f32 and
 * run-eval.js attaches each row to its document as `doc.vector` — a Float32Array
 * view, the same channel through which `title` and `body` arrive.
 *
 * So this file requires NOTHING. Not even v1-overlap: v5 is the first rung that
 * does not import the shared tokeniser, because it does not have a term space
 * for a tokeniser to define. §16.1 argued that inheriting tokenise() keeps the
 * rungs comparable — that argument does not extend here, and the source digest
 * is what says so: v5's file list is this file, types.js and index.js, where
 * v3's and v4's carry v1-overlap.js as well. Read it off the digest rather than
 * off this comment.
 *
 * THE ONE LINK THIS FILE CANNOT VERIFY, stated rather than glossed: it can
 * check that every document carries a vector of the right width, but it cannot
 * check that `params.vectors` names the bytes it was handed. That binding is
 * run-eval.js's — it re-hashes the vectors file against its manifest and checks
 * the manifest's corpusSha256 and idsSha256 against the corpus actually loaded.
 * A pure function of the documents cannot hash a file, which is the cost of the
 * §7.1 boundary and is paid here.
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EXACT SEARCH AND NOT AN ANN INDEX.
 *
 * Roadmap 3.4 says "the corpus is small enough that an ANN index is premature",
 * which is right and is worth stating as arithmetic rather than as a feeling.
 * A query is one dot product against every document: 27,325 × 384 = 10.5 MFLOP,
 * once, with no index to build and no recall to lose. Measured cost is in
 * §17's environment block.
 *
 * An approximate index would buy sublinear search and cost three things, and
 * the third is the one that matters here:
 *   1. a dependency, inside the step whose reproducibility this phase is about;
 *   2. build-time hyperparameters (HNSW's M, efConstruction) that would need
 *      their own sweep and their own selection-bias accounting — §13.7's
 *      estimator put 44% of v4's tuning margin down to optimism, so that is not
 *      a formality;
 *   3. APPROXIMATE RECALL — a new source of error placed INSIDE the thing being
 *      measured. An nDCG difference between v4 and v5 would then confound the
 *      retriever with the index's recall, and CLAUDE.md's rule about never
 *      changing two variables at once would be broken by the data structure.
 * ANN starts paying when N·dim per query stops fitting the latency budget,
 * around N > 10⁶. This corpus is 27,325.
 * ─────────────────────────────────────────────────────────────────────────
 * SYMMETRY COMES BACK, AND IT IS DECLARED RATHER THAN LEFT IN PROSE.
 *
 * v2 made score(A→B) === score(B→A) a property of the algorithm, v3 kept it at
 * real cost, and v4 broke it — 190 of 197 reachable fixture pairs disagree
 * (§14.5's amendment) — and won anyway. A dot product is symmetric in its two
 * arguments, so v5 gives it back, under BOTH settings of `normalise`: cosine
 * divides by ‖a‖‖b‖, which is itself symmetric.
 *
 * 3.3's noticed-list asked for this to land in describe(handle) instead of in a
 * paragraph, and it now does — `symmetric` is a module-level declaration, not a
 * param, so no params digest moves. It is VERIFIED, not asserted:
 * tests/retrieval.symmetry.test.js measures every registered rung over the
 * 34-document fixture and fails if a declaration disagrees with the measurement
 * IN EITHER DIRECTION, so a stale `false` cannot hide either.
 * ─────────────────────────────────────────────────────────────────────────
 * NO `explain`, AND THAT IS THE ANSWER RATHER THAN A GAP.
 *
 * The ladder carries three shapes: {sharedKeywords} for v1/v2, {shared: n} for
 * v3/v4, and none here. There is no lexical explanation to emit — {cosine: n}
 * would only restate the score. What Phase 7.4 inherits is therefore a finding
 * rather than a fourth shape: `explain` cannot be a uniform contract, because
 * explaining a dense retrieval needs a SEPARATE MECHANISM MAKING A DIFFERENT
 * CLAIM. A lexical overlap displayed beside a dense hit is a post-hoc
 * rationalisation, not the reason the document ranked. Still nothing reads it.
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS RUNG'S NUMBER IS CONDITIONAL ON, since it belongs next to the code.
 *
 * all-MiniLM-L6-v2 is a 384-dimension, ~86 MiB local model that accepts 256
 * wordpieces. BM25 reads every token of a 2,185-token document; this model
 * reads the first 256, and 9.4% of the corpus is truncated. Whatever this rung
 * scores, the defensible sentence is about THIS model — not about dense
 * retrieval. PRIMER.md §13 fixed that wording before the model was chosen.
 */

const defaultParams = {
  /**
   * PROVENANCE PARAM: which vectors file produced this run.
   *
   * v5 reads it only to fail loudly when it is empty; the bytes arrive through
   * doc.vector. It is a param rather than a bare runner flag because the params
   * digest is what §11.4's report diffs when it says how many variables changed.
   * Without it a 256-token run and a 128-token run would carry the SAME digest
   * and differ only in an input hash — two ablations that look like one
   * configuration, which is exactly the "run that lies about itself" of §13.10.
   */
  vectors: 'minilm-l6-v2-fp32-256',
  /**
   * Asserted against the vectors actually handed in, never trusted. A model
   * emitting a different width would otherwise be read as a shorter document.
   */
  dim: 384,
  /**
   * COSINE (true) OR RAW DOT PRODUCT (false).
   *
   * The one free ablation on this rung, and the reason embed-corpus.js stores
   * vectors UNNORMALISED. It is the dense analogue of BM25's `b`: whether
   * document magnitude is divided out or left to act. Under a mean-pooled
   * encoder ‖e‖ is not document length — it grows with how confidently the
   * pooled token cloud points one way — so this is a genuinely different
   * question from v4's, asked with the same shape.
   */
  normalise: true
};

/**
 * Cosine is bounded by ±1; float error in a 384-term dot product over unit
 * vectors is a few ULPs. 1e-6 is generous by ~10 orders and still catches the
 * failures worth catching (unnormalised rows read as normalised, a stale
 * `dim`).
 */
const COSINE_TOLERANCE = 1e-6;

function buildIndex(docs, params) {
  if (typeof params.vectors !== 'string' || params.vectors === '') {
    throw new Error('v5-embeddings: `vectors` must be a non-empty slug naming the vectors file the run was built from');
  }
  if (!Number.isInteger(params.dim) || params.dim < 1) {
    throw new Error(`v5-embeddings: dim must be a positive integer (got ${JSON.stringify(params.dim)})`);
  }
  if (typeof params.normalise !== 'boolean') {
    throw new Error(`v5-embeddings: normalise must be a boolean (got ${JSON.stringify(params.normalise)})`);
  }

  const n = docs.length;
  const dim = params.dim;
  const indexById = new Map();
  const idByIndex = new Array(n);

  // One contiguous matrix rather than n separate arrays: the per-query cost is
  // a single linear scan, and a scan over one buffer is what makes exact search
  // affordable at this N.
  const matrix = new Float32Array(n * dim);
  const norms = new Float64Array(n);
  let minNorm = Infinity;
  let maxNorm = 0;

  for (let i = 0; i < n; i += 1) {
    const doc = docs[i];
    const vector = doc.vector;
    if (!vector || typeof vector.length !== 'number') {
      throw new Error(
        `v5-embeddings: document ${doc.id} carries no \`vector\`. Vectors are corpus ` +
        'preparation (§7.1) — run `npm run embed:corpus` and pass the run through ' +
        'run-eval.js, which attaches them.'
      );
    }
    if (vector.length !== dim) {
      throw new Error(`v5-embeddings: document ${doc.id} has a ${vector.length}-dim vector, expected ${dim}`);
    }

    indexById.set(doc.id, i);
    idByIndex[i] = doc.id;

    let sum = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d += 1) {
      const value = vector[d];
      if (!Number.isFinite(value)) {
        throw new Error(`v5-embeddings: document ${doc.id} has a non-finite component at dim ${d}`);
      }
      matrix[base + d] = value;
      sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (!(norm > 0)) {
      // A zero vector has no direction, so its cosine against everything is 0/0.
      // Silently scoring it 0 would bury a broken row inside a plausible run.
      throw new Error(`v5-embeddings: document ${doc.id} has a zero-norm vector`);
    }
    norms[i] = norm;
    if (norm < minNorm) minNorm = norm;
    if (norm > maxNorm) maxNorm = norm;

    // Normalising HERE rather than in rank() turns the per-query cost back into
    // a plain dot product: 27,325 × 384 multiply-adds and no divides. The
    // alternative — dividing by ‖a‖‖b‖ at scoring time — is the same number and
    // n extra divides per query, for no readability.
    if (params.normalise) {
      const inv = 1 / norm;
      for (let d = 0; d < dim; d += 1) matrix[base + d] *= inv;
    }
  }

  return {
    params,
    n,
    dim,
    indexById,
    idByIndex,
    matrix,
    norms,
    normRange: [minNorm, maxNorm]
  };
}

function rank(state, queryDoc, ctx) {
  const { params, n, dim, indexById, idByIndex, matrix } = state;
  const qi = indexById.get(queryDoc.id);
  const qBase = qi * dim;
  const cosine = params.normalise;

  // Collect every candidate rather than pre-truncating with ctx.k — §15.6's
  // reason unchanged: collecting everything is the version whose equivalence to
  // the interface contract needs no argument, because it IS the contract. Here
  // it also happens to be forced: with no postings list every document is a
  // candidate, which is what "exact search" means.
  for (let i = 0; i < n; i += 1) {
    if (i === qi) continue;
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d += 1) dot += matrix[qBase + d] * matrix[base + d];

    if (!Number.isFinite(dot)) {
      throw new Error(`v5-embeddings: non-finite score ${dot} for ${queryDoc.id} -> ${idByIndex[i]}`);
    }
    if (cosine && Math.abs(dot) > 1 + COSINE_TOLERANCE) {
      // What the formula actually guarantees, in the shape §16.6 used for v4:
      // assert the invariant the configuration HAS rather than one it does not.
      // v3 had [0,1]; BM25 had none, being an unbounded sum; a cosine has ±1
      // back. Exceeding it means the rows were not unit vectors, so the run is
      // not the run its params describe.
      throw new Error(
        `v5-embeddings: cosine ${dot} for ${queryDoc.id} -> ${idByIndex[i]} is outside [-1, 1]. ` +
        'The indexed rows are not unit vectors.'
      );
    }
    // No `explain`. See the header — the absence is the finding, not a gap.
    ctx.collect(idByIndex[i], dot, undefined);
  }
}

module.exports = {
  version: 'v5-embeddings',
  defaultParams,
  buildIndex,
  rank,
  /**
   * score(A→B) === score(B→A). A dot product is symmetric in its arguments and
   * ‖a‖‖b‖ is too, so this holds under both settings of `normalise`. Declared
   * here, MEASURED by tests/retrieval.symmetry.test.js against the fixture.
   *
   * NOT a param: it is a property of the algorithm, so it must not enter the
   * params digest — that would move every digest on the ladder and invalidate
   * 21 committed sidecars for a field that describes rather than configures.
   */
  symmetric: true
  // No termCount(). v5 has no terms. scripts/analyse-rungs.js therefore
  // stratifies on a CORPUS axis from 3.4 onward — see its header for why the
  // axis had to leave the retriever, and §14.6's ↳ for what that changed.
};
