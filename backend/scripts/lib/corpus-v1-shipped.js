'use strict';

/**
 * corpus-v1-shipped.js — Phase 4.6. THE PRE-4.6 CORPUS LOADER, PRESERVED.
 *
 * NOT SHIPPED CODE. Nothing under backend/routes/, backend/services/ or
 * backend/models/ requires this file. Its callers are scripts/parity-v1.js and
 * scripts/measure-keyword-stability.js, and through the first of them
 * tests/retrieval.v1-parity.test.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS, WHICH IS THE SAME SHAPE AS linker-v1-shipped.js AND FOR THE
 * SAME REASON.
 *
 * §7.6's third freeze — *which 500 documents feed the IDF* — is demonstrated by
 * parity-v1.js's demonstration C: 521 generated documents, one whose tenth
 * keyword slot is contested, where reversing the store's return order changes
 * which of `alpha` and `bravo` survives. That demonstration exists to prove the
 * unsorted cap is LOAD-BEARING.
 *
 * Phase 4.6 gives `utils/corpus.js` a `.sort({_id: 1})`, which makes the
 * demonstration return the same list under both orders. Two obvious things were
 * available and both are wrong:
 *
 *   delete demonstration C   destroys the only place the 500-cap is exercised
 *                            at all, and leaves §7.6's "which 500" row with no
 *                            evidence behind it. A repo that deletes the proof
 *                            a defect existed loses the ability to say what it
 *                            fixed.
 *   flip `not.toEqual` to
 *     `toEqual` in place     silently converts a proof that a hazard EXISTS
 *                            into a proof that it DOES NOT, at the same line
 *                            number, while §7.6 goes on quoting the two
 *                            contested keyword lists.
 *
 * So the "before" is preserved instead and demonstration C prints BOTH rows.
 * That is 4.1's move with linker-v1-shipped.js and 4.4's with
 * graph-builder-v1-shipped.js, and it is what keeps the row a live measurement
 * of real code rather than a recollection.
 *
 * A HAND-WRITTEN "UNSORTED LOADER" WOULD NOT DO. §7.5's load-bearing sentence
 * is that "comparing a reimplementation against a reimplementation would prove
 * nothing", and a six-line function retyped into a test file is exactly a
 * reimplementation. Six lines is cheap; the claim is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT "PRESERVED" MEANS HERE, AND HOW IT IS CHECKED.
 *
 *   source        backend/utils/corpus.js
 *   at            commit 1a3a4b3, unchanged since 268b6bc
 *   whole file    sha256 2f52efa7599883ff13f5b155ad04941c6860ddbf605e4717bcae6280ccfe152f
 *
 * ONE LINE DIFFERS AND IT IS THE FIRST ONE: `require('../models/Note')` becomes
 * `require('../../models/Note')`, because this file sits two directories
 * deeper. Both resolve to the same path, which is the path fake-note-store's
 * install() primes. Everything after it is byte-for-byte the pre-4.6 file,
 * delimited below and hashed by tests/retrieval.v1-parity.test.js against
 * sha256 5fd8c427e72f15d3122c50cb85ddeda0d7651c9cc5fae2e308c25502e286302d
 * — which is that file from line 2, reproducible with:
 *
 *   git show 1a3a4b3:backend/utils/corpus.js | tail -n +2 | shasum -a 256
 *
 * A behavioural check sits behind the byte check and is the stronger of the
 * two: if this copy diverged, demonstration C's unsorted row would stop
 * reporting `same keyword set NO` and the parity test would fail on the output
 * rather than on the source.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES *NOT* PRESERVE, STATED SO THE FILE IS NOT READ AS MORE THAN IT
 * IS.
 *
 * Only the ORDER defect. The pre-4.6 loader and the live one are identical in
 * every other respect — same filter, same projection, same limit, same
 * `excludeId` semantics, same `{title, content}` return shape. The EPOCH defect
 * (§7.2's second unspecified input) lives in `routes/notes.js` extracting at
 * save time, not in either version of this function, and 4.6 does not fix it.
 * results/keyword-stability.txt measures both and keeps them apart.
 */

const Note = require('../../models/Note');

// ─── BEGIN VERBATIM — do not edit below this line ──────────────────────────

async function loadUserCorpus(userId, { excludeId = null, limit = 500 } = {}) {
  const filter = { user: userId };
  if (excludeId) filter._id = { $ne: excludeId };
  const docs = await Note.find(filter).select('title contentText').limit(limit).lean();
  return docs.map((d) => ({ title: d.title || '', content: d.contentText || '' }));
}

module.exports = { loadUserCorpus };

// ─── END VERBATIM ──────────────────────────────────────────────────────────
