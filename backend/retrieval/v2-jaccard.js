'use strict';

/**
 * v2-jaccard.js — Phase 3.1, the first genuine rung on the ladder.
 *
 *   v1:  strength = |A ∩ B| / |A|        asymmetric — the denominator is the
 *                                        SOURCE's keyword count, so A→B and
 *                                        B→A differ
 *   v2:  strength = |A ∩ B| / |A ∪ B|    symmetric BY CONSTRUCTION
 *
 * WHY SYMMETRY IS THE POINT AND NOT A DETAIL. PRIMER.md §3.5 records two
 * structural quirks of the shipped algorithm, and they compound: the score is
 * asymmetric, and linker.service.js:41 writes the SOURCE's computed strength
 * into the TARGET's record, so whichever note was saved most recently
 * overwrites the other direction. The stored graph therefore depends on save
 * order. Phase 4.2 fixes the second half in storage; this rung removes the
 * first half at the algorithm level, so there is no longer a "which direction"
 * for storage to get wrong. tests/retrieval.v2-symmetry.test.js proves it
 * rather than asserting it — and proves v1 fails the same test.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THRESHOLD IS NOT INHERITED, AND THAT IS THE METHODOLOGICAL CONTENT.
 *
 * Jaccard silently redefines what a threshold means. For two ten-keyword notes
 * sharing s words, |A ∪ B| = 20 − s, so (all values via toFixed(4), which is
 * what decides membership at the boundary — EVALUATION.md §7.7):
 *
 *      s        v1 = s/10        v2 = s/(20−s)
 *      1          0.1000           0.0526
 *      2          0.2000  ✓        0.1111  ✗
 *      3          0.3000           0.1765  ✓
 *
 * The SAME 0.15 therefore demands THREE shared words under Jaccard where it
 * demanded TWO under v1. Keeping `threshold: 0.15` would change the similarity
 * function AND tighten the admission rule — two variables, and the second one
 * dominates: EVALUATION.md §13.5 priced that exact tightening on v1's own axis
 * at 12.2% of nDCG@8 and 42× the zero-result queries.
 *
 * So v2 holds the BEHAVIOUR constant rather than the numeral. The numeral was
 * never a setting: §13.3 measured that 0.15 = 3/20 is not an achievable v1
 * score at all, so `> 0.15` keeps byte-for-byte what `> 0.1429` keeps. "0.15"
 * is a LABEL for the rule "share at least 2 of 10", and the rule is what this
 * rung holds fixed.
 *
 * WHY minShared AND NOT A SCALAR THRESHOLD IN THE EQUIVALENT RANGE. The scalar
 * thresholds reproducing "s ≥ 2" at the modal pair are [1/19, 2/18) =
 * [0.0526, 0.1111). But a Jaccard threshold leaks the TARGET's length into the
 * admission rule, which v1's never did. Enumerated over all 385 (a, b, s) with
 * a, b ≤ 10:
 *
 *   v1(0.15) vs minShared 2, a ≥ 7:  210 agree,  0 differ
 *   v1(0.15) vs scalar 0.1,  a ≥ 7:               6 differ
 *                                    (a=7,b≤3,s=1 · a=8,b≤2,s=1 · a=9,b=1,s=1)
 *
 * minShared is length-independent on both sides and gives EXACT admission-set
 * equality with v1 for every query carrying ≥ 7 keywords — 2,279 of 2,304 dev
 * queries (98.9%, §13.8) — for every target length.
 *
 * WHAT IS NOT CLAIMED. Exact equivalence is impossible: v1's rule does not
 * depend on |B| at all and Jaccard's necessarily does. The residual is the
 * d ≤ 6 stratum, 25 of 2,304 dev queries (1.09%), where v1 links on a single
 * shared word and v2 does not. v2 is strictly STRICTER there, so its candidate
 * set is a subset of v1's on those 25 — bounded, and reported stratified rather
 * than left as an unquantified confound. §14.3.
 *
 * THE SCORE LATTICE MOVES TOO. v1's achievable scores are s/d for 1 ≤ s ≤ d ≤
 * 10 — the Farey fractions of order 10, 32 values, which is what made 2.7's
 * threshold sweep exhaustive. v2's are s/(a+b−s) for 1 ≤ s ≤ min(a,b) ≤ 10,
 * which is { s/u : 1 ≤ s ≤ u ≤ 20 − s }: 64 distinct values, denominators to
 * 19, floor at 1/19 = 0.0526 instead of 1/10. An exhaustive v2 threshold sweep
 * is therefore a DIFFERENT and larger grid, and 3.1 does not run one — a swept
 * v2 measured against an unswept v1 is not the registered experiment.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS SHARED WITH v1, AND WHY THAT IS THE OPPOSITE OF v1's OWN CHOICE.
 * v1-overlap copies the tokenizer and stopword list out of backend/utils/
 * rather than importing them, for two reasons: importing would invert the
 * dependency direction Phase 4.1 needs (app → retrieval, never the reverse),
 * and it would make the parity test a tautology. NEITHER transfers here. Both
 * files already live under backend/retrieval/, and there is no parity claim
 * for a shared import to make circular.
 *
 * The reason that does apply points the other way. This rung's entire premise
 * is that v1 and v2 index IDENTICAL keyword lists, so that the only thing
 * moving is how a pair of lists is scored. Re-implemented, that premise is a
 * claim needing its own test; imported, it is true by construction. And the
 * freeze on v1 is mechanically enforced — tests/retrieval.v1-parity.test.js
 * regenerates the committed evidence and fails on drift — so importing v1's
 * buildIndex inherits a guarantee rather than a risk. No line of v1-overlap.js
 * is edited, including to enable this.
 */

const v1 = require('./v1-overlap');

const defaultParams = {
  /**
   * INHERITED UNCHANGED from v1. Settled at 2.6 (EVALUATION.md §12.1): the
   * only value the committed parity proof covers, and exact with respect to
   * the shipped excludeId semantics. Holding it is what makes v1 and v2 index
   * identical keyword lists.
   */
  idfCorpus: 'leave-one-out',
  /**
   * INHERITED UNCHANGED. Roadmap 3.2 owns vocabulary truncation as a
   * registered one-variable ablation. It is also an input to BOTH denominators
   * here, so moving it would redefine every threshold on both axes at once.
   */
  topN: 10,
  /**
   * INHERITED UNCHANGED. Roadmap 3.2 owns the length bonus. Flipping it
   * changes keyword SELECTION, hence the candidate pool and every shared count
   * — not a scoring change at all.
   */
  lengthBonus: true,
  /**
   * INHERITED UNCHANGED, and not merely out of deference. §7.7: toFixed(4) is
   * part of the algorithm rather than presentation. Under minShared it no
   * longer decides MEMBERSHIP in v2 — but it still decides TIE STRUCTURE, and
   * index.js breaks ties lexicographically on the id. Keeping 4 means v2's tie
   * groups partition the same way v1's do; changing it would silently
   * re-partition them, which is a hidden second variable inside the ranking.
   */
  scorePrecision: 4,
  /**
   * INHERITED UNCHANGED. §13.5 measured cap 8 → 10 at +0.005086 nDCG@10 —
   * twenty times the size of the effect this rung is looking for — so dropping
   * it is a second variable worth more than the first. It is also free of risk
   * on the registered metric: slice(0, min(k, cap)) makes @1, @5 and @8
   * cap-invariant BY CONSTRUCTION, and nDCG@8 is the pre-registered primary,
   * so the cap cannot touch the registered result.
   *
   * Recorded for the rungs after this one: §13.2 showed every cap ≥ 10 is
   * unobservable at kMax = 10, so when v3 and v4 arrive carrying no cap they
   * differ from v1 and v2 at @10 by exactly this already-measured amount, and
   * nowhere else.
   */
  cap: 8,
  /**
   * NOT INHERITED — 0.15 → 0. See the block comment above. Kept present rather
   * than deleted so that a future study over v2's 64-value lattice is a param
   * flip landing in describe(handle).digest, not an edit to this file. Inert at
   * 0: every achievable Jaccard score is ≥ 1/19 > 0, so the filter admits
   * everything minShared already admitted.
   */
  threshold: 0,
  /**
   * NEW. The integer v1's threshold actually encodes for d ≥ 7, made
   * length-independent — the fix §7.7 and §13.8 both named and neither could
   * apply, because adding a key to v1-overlap's defaultParams edits the frozen
   * baseline five rungs are measured against. Adding it HERE does not touch
   * v1, its digest, or its parity files.
   */
  minShared: 2
};

/**
 * Validate v2's own precondition, then delegate.
 *
 * The delegation is the whole point (see the header): v1's buildIndex is what
 * produces the keyword lists, so both rungs provably index the same ones.
 *
 * One inherited check reads oddly and is left rather than worked around: v1's
 * buildIndex asserts `params.threshold >= 0`, which here is a check on a
 * parameter that no longer carries the admission rule. It passes (0 >= 0) and
 * is harmless. Noted so it does not read as intentional.
 */
function buildIndex(docs, params) {
  if (!Number.isInteger(params.minShared) || params.minShared < 1) {
    throw new Error(
      `v2-jaccard: minShared must be a positive integer (got ${JSON.stringify(params.minShared)})`
    );
  }
  return v1.buildIndex(docs, params);
}

/**
 * linker.service.js:21-36 with the denominator replaced, and the admission
 * rule expressed as the integer it always was.
 *
 * `sharedKeywords` is built in TARGET order — filtering the target's list
 * against the query's set — which is v1's convention (it reproduces the
 * shipped stored order, §7.6). Kept so a v1-vs-v2 diff of explain fields is
 * comparable. That order is NOT symmetric: A→B and B→A carry the same shared
 * SET in different orders. The score is what is symmetric, and the symmetry
 * test asserts score equality at exact float equality plus set equality of the
 * shared terms — not sequence equality, which would be a claim this does not
 * make.
 *
 * NO GUARD ON THE DENOMINATOR, DELIBERATELY. At the division,
 * union >= shared >= minShared >= 1, so a zero denominator is unreachable. A
 * defensive Math.max(union, 1) mirroring v1:254 would convert a future bug
 * into a plausible number; without it, a non-finite score is rejected by
 * assertHits instead.
 */
function rank(state, queryDoc, ctx) {
  const { keywordsById, postings, params } = state;
  const queryKeywords = keywordsById.get(queryDoc.id);
  const querySet = new Set(queryKeywords);

  const candidates = new Set();
  for (const word of querySet) {
    const bucket = postings.get(word);
    if (bucket) for (const id of bucket) candidates.add(id);
  }

  for (const docId of candidates) {
    const targetKeywords = keywordsById.get(docId);
    const sharedKeywords = targetKeywords.filter((k) => querySet.has(k));
    if (sharedKeywords.length < params.minShared) continue;

    const union = queryKeywords.length + targetKeywords.length - sharedKeywords.length;
    const strength = Number((sharedKeywords.length / union).toFixed(params.scorePrecision));
    if (!(strength > params.threshold)) continue;

    ctx.collect(docId, strength, { sharedKeywords });
  }
}

module.exports = { version: 'v2-jaccard', defaultParams, buildIndex, rank };
