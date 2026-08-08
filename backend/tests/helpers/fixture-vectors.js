'use strict';

/**
 * Deterministic synthetic embeddings for the 34-document fixture (Phase 3.4).
 *
 * WHY FAKE VECTORS RATHER THAN REAL ONES. The model is 86 MiB, lives under
 * data/ which is gitignored, and is reached through a dependency that
 * deliberately sits outside backend/ (scripts/package.json). The test suite has
 * to run on a clean clone and in CI, which is the same argument §7.4 used for
 * committing the fixture corpus in the first place. A synthetic vector
 * exercises every line of v5-embeddings.js that is not the model — the shape
 * checks, the normalisation, the dot product, the cosine bound, self-exclusion
 * and symmetry — because none of those care where the numbers came from.
 *
 * WHAT IT DOES NOT COVER, stated so the suite is not read as more than it is:
 * nothing here says the embeddings are any good. Whether MiniLM separates
 * cooking questions is measured on dev by the run, not asserted by a test.
 *
 * mulberry32 seeded from the doc id, so the vectors are a pure function of the
 * fixture: the same on every machine and every Node version, which is the same
 * reason 1.4 and 2.5 use it instead of Math.random().
 */

const DIM = 384;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from a doc id string. */
function seedFor(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * One vector per document. Values are centred on zero and scaled per document,
 * so norms VARY — which matters, because a fixture where every vector happened
 * to be unit length would make `normalise: true` and `normalise: false`
 * indistinguishable and the ablation test vacuous.
 */
function vectorFor(id, dim = DIM) {
  const rand = mulberry32(seedFor(id));
  const scale = 0.5 + rand() * 3;
  const vector = new Float32Array(dim);
  for (let d = 0; d < dim; d += 1) vector[d] = (rand() * 2 - 1) * scale;
  return vector;
}

/** Fixture documents with a `vector` field attached. Does not mutate the input. */
function withVectors(docs, dim = DIM) {
  return docs.map((doc) => ({ ...doc, vector: vectorFor(doc.id, dim) }));
}

module.exports = { DIM, withVectors, vectorFor, mulberry32, seedFor };
