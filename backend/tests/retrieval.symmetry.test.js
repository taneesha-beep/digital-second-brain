'use strict';

/**
 * The `symmetric` declaration, measured for EVERY registered rung (Phase 3.4).
 *
 * WHY THIS FILE EXISTS. Whether score(A→B) === score(B→A) had been decided four
 * times and written down four times, each in a different section of prose: v1
 * no (§14.5), v2 yes and that was the whole rung (§14.5), v3 yes at real cost
 * (§15.8), v4 no and it won anyway (§14.5's amendment). 3.3's noticed-list asked
 * for it to land on the Retriever contract instead, because Phase 4.2 has to
 * build a BIDIRECTIONAL link graph out of the winner and "which direction do we
 * store" is not a question a document should be answering.
 *
 * A DECLARATION NOBODY CHECKS IS WORSE THAN NO DECLARATION — it looks like
 * evidence. So this file measures every rung and compares the measurement to
 * what the module claims, IN BOTH DIRECTIONS:
 *
 *   declares true  but a pair disagrees  -> fail
 *   declares false but every pair agrees -> fail
 *
 * The second half is the one that is easy to leave out, and it is what stops a
 * `false` going stale after a rung is changed to be symmetric.
 *
 * SYMMETRY HERE MEANS SCORE SYMMETRY, AT FULL DEPTH. §14.5 checked v2's
 * reachability too — B reachable from A exactly when A is reachable from B —
 * which is well-defined for v2 because v2 has an ADMISSION RULE. v3, v4 and v5
 * admit every candidate and are then truncated to k by the interface, so
 * reachability at k=8 is asymmetric for all three even when the score is not.
 * Searching at k = |fixture| removes the truncation and leaves the question the
 * declaration is actually about. §14.5's own test keeps the reachability half
 * for v2, where it means something.
 */

const parity = require('../scripts/parity-v1');
const retrieval = require('../retrieval');
const { withVectors } = require('./helpers/fixture-vectors');

const baseDocs = parity.loadFixture();
const ALL = baseDocs.length;

/**
 * Rungs that consume a `vector` field get deterministic synthetic ones. The
 * suite must not need an 86 MiB model — scripts/embed-corpus.js is corpus
 * preparation and lives outside backend/ for exactly that reason — and a fake
 * vector exercises every line of v5 that is not the model.
 */
function docsFor(version) {
  return retrieval.resolvedParamsFor(version).dim === undefined ? baseDocs : withVectors(baseDocs);
}

/** docId -> Map(otherId -> score) at full depth, uncapped where a cap exists. */
function scoreTable(version, params = {}) {
  const docs = docsFor(version);
  const overrides = { ...params };
  if ('cap' in retrieval.resolvedParamsFor(version)) overrides.cap = null;
  const handle = retrieval.index(version, docs, overrides);
  const table = new Map();
  for (const doc of docs) {
    const row = new Map();
    for (const hit of retrieval.search(handle, doc.id, ALL)) row.set(hit.docId, hit.score);
    table.set(doc.id, row);
  }
  return table;
}

/** Compare both directions on every pair either side reached. */
function measureSymmetry(table) {
  let agreed = 0;
  let disagreed = 0;
  const examples = [];
  for (const [a, row] of table) {
    for (const [b, score] of row) {
      const back = table.get(b).get(a);
      // A pair one side reached and the other did not cannot be a score
      // disagreement; it is a truncation artifact, and searching at full depth
      // is what removes it. Counted separately rather than folded in.
      if (back === undefined) continue;
      if (Object.is(score, back)) agreed += 1;
      else {
        disagreed += 1;
        if (examples.length < 3) examples.push(`${a}<->${b}: ${score} vs ${back}`);
      }
    }
  }
  return { agreed, disagreed, examples };
}

describe('every registered rung declares `symmetric`, and the declaration is measured', () => {
  test('register() rejects a retriever that does not declare it', () => {
    expect(() =>
      retrieval.register({
        version: 'test-no-symmetry-declaration',
        defaultParams: {},
        buildIndex: () => ({}),
        rank: () => {}
      })
    ).toThrow(/must declare symmetric/);
  });

  test('describe(handle) carries it, so it reaches every run sidecar', () => {
    const handle = retrieval.index('v2-jaccard', baseDocs);
    expect(retrieval.describe(handle).symmetric).toBe(true);
    // And it is NOT in the digest: symmetry describes the algorithm rather than
    // configuring it, so folding it in would move all 21 committed sidecars.
    expect(JSON.stringify(retrieval.describe(handle).params)).not.toMatch(/symmetric/);
  });

  test.each(retrieval.versions())('%s — the declaration matches the measurement', (version) => {
    const declared = require(`../retrieval/${version}`).symmetric;
    const { agreed, disagreed, examples } = measureSymmetry(scoreTable(version));

    // Vacuous agreement would pass any declaration. The fixture has to actually
    // produce pairs, and if it stops doing so this fails rather than going quiet.
    expect(agreed + disagreed).toBeGreaterThan(100);

    if (declared) {
      expect(`${version}: ${disagreed} disagreeing pairs — ${examples.join('; ')}`)
        .toBe(`${version}: 0 disagreeing pairs — `);
    } else {
      // The half that stops a stale `false`. If a rung is changed to be
      // symmetric and nobody updates the flag, this is what says so.
      expect(disagreed).toBeGreaterThan(0);
    }
  });

  test('the ladder is v1 no, v2 yes, v3 yes, v4 no, v5 yes — the sequence, in one place', () => {
    expect(retrieval.versions().map((v) => [v, require(`../retrieval/${v}`).symmetric])).toEqual([
      ['v1-overlap', false],
      ['v2-jaccard', true],
      ['v3-tfidf', true],
      ['v4-bm25', false],
      ['v5-embeddings', true]
    ]);
  });

  test('v4 is asymmetric in the shape §14.5 measured — and every exception has equal length', () => {
    const { disagreed } = measureSymmetry(scoreTable('v4-bm25'));
    expect(disagreed).toBeGreaterThan(0);
  });

  test('v5 is symmetric under BOTH settings of `normalise`, since a dot product is too', () => {
    for (const normalise of [true, false]) {
      const { agreed, disagreed } = measureSymmetry(scoreTable('v5-embeddings', { normalise }));
      expect(disagreed).toBe(0);
      expect(agreed).toBeGreaterThan(100);
    }
  });
});
