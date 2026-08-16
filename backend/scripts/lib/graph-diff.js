'use strict';

/**
 * graph-diff.js — Phase 4.4. THE PREDICATE THAT DECIDES WHETHER 4.4 IS DONE.
 *
 * Roadmap 4.4's second Done clause is: *"output identical to the
 * characterization fixture, OR the diff fully explained by the DF cutoff in the
 * decisions log."*
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE RATHER THAN A PARAGRAPH.
 *
 * That escape hatch is where the task goes wrong if "fully explained" is
 * decided AFTER the diff is visible — at which point any diff can be narrated
 * into an explanation and the clause asserts nothing. So the rule was written
 * down before the rewrite existed (ROADMAP decisions log, 2026-08-16), and it
 * is here as executable code so that "explained" is a verdict rather than a
 * claim.
 *
 * It is a separate module and not inline in characterize-graph.js for the
 * reason §23.5 gives for `unlabelled()`: a pure function that decides whether a
 * criterion is met is exactly the thing that needs unit tests, and one buried
 * in a driver gets none. tests/graph.diff.test.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RULE, VERBATIM FROM THE DECISIONS LOG.
 *
 *   1. ZERO additions.
 *   2. ZERO removals of any `note`, `keyword` or `note-keyword` element.
 *   3. The only permitted removals are `cross-link` edges whose `sharedKeyword`
 *      has df > maxDf, and removal is ALL-OR-NOTHING PER TERM.
 *   4. The only permitted field changes are `shared` flipping true -> false on
 *      `keyword` nodes of cut terms (and the `classes` string that mirrors it),
 *      and `size` DECREASING on `note` nodes to exactly
 *      64 + min(6 * conns', 24) over admitted terms.
 *   5. Every other field on every surviving element is byte-identical, and the
 *      surviving elements appear IN THE SAME ORDER.
 *   6. The removed cross-edge count equals Sigma_{t: df_t > maxDf} C(df_t, 2),
 *      COMPUTED FROM THE DF TABLE AND NOT FROM THE DIFF. Off by one and the
 *      diff is not explained.
 *
 * `meta` is exempt by declaration, because it is not an element and nothing
 * renders it (GlobalGraph.jsx:166 reads `data?.elements`). Stated in the rule
 * rather than discovered as a convenient exception.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT "INDEPENDENT" MEANS HERE, BECAUSE IT IS THE LOAD-BEARING WORD.
 *
 * This module NEVER asks the builder anything. It is handed the notes and it
 * derives its own postings, its own df table, its own admitted-term set and its
 * own expected degrees. Clause 6's expected count in particular comes from that
 * table — if it were computed by counting what the diff removed it would agree
 * with any diff whatsoever, which is the shape of a check that cannot fail
 * (§22.6).
 *
 * That does mean the size formula `64 + min(6 * conns', 24)` is expressed in
 * two places. It is a SPECIFICATION here rather than a copy: the checker's job
 * is to verify the builder against a stated rule, and a rule has to be stated
 * somewhere. §7.5's warning is about proving two implementations equal, which
 * is a different task from this one.
 */

const NON_CROSS_TYPES = new Set(['note', 'keyword', 'note-keyword']);

/** normList(), from services/graphBuilder.service.js — the same admission rule. */
function normList(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/**
 * Postings, df and expected degree, derived from the NOTES alone.
 *
 * @param {Array<{id: string, keywords: string[]}>} notes  in emission order
 * @param {number} maxDf
 */
function derive(notes, maxDf) {
  const postings = new Map();
  notes.forEach((note, i) => {
    for (const kw of normList(note.keywords)) {
      let bucket = postings.get(kw);
      if (bucket === undefined) { bucket = []; postings.set(kw, bucket); }
      bucket.push(i);
    }
  });

  const df = new Map();
  const cut = new Set();
  let expectedRemoved = 0;
  for (const [kw, bucket] of postings) {
    df.set(kw, bucket.length);
    if (bucket.length > maxDf) {
      cut.add(kw);
      expectedRemoved += (bucket.length * (bucket.length - 1)) / 2;
    }
  }

  // Degree over ADMITTED terms only, deduped per pair — a pair sharing three
  // keywords is one connection, which is what the pre-4.4 pairwise loop counted.
  const partners = notes.map(() => new Set());
  for (const [kw, bucket] of postings) {
    if (bucket.length < 2 || cut.has(kw)) continue;
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        partners[bucket[a]].add(bucket[b]);
        partners[bucket[b]].add(bucket[a]);
      }
    }
  }

  const expectedSize = new Map();
  notes.forEach((note, i) => {
    expectedSize.set(String(note.id), 64 + Math.min(partners[i].size * 6, 24));
  });

  return { postings, df, cut, expectedRemoved, expectedSize };
}

const byId = (elements) => new Map(elements.map((el) => [el.data.id, el]));

/** Field-level comparison of two surviving elements, ignoring the permitted set. */
function fieldViolations(before, after, { isCutKeywordNode, isNoteNode, expectedSize }) {
  const problems = [];
  const keys = new Set([...Object.keys(before.data), ...Object.keys(after.data)]);

  for (const key of keys) {
    const a = before.data[key];
    const b = after.data[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;

    if (key === 'shared' && isCutKeywordNode && a === true && b === false) continue;
    if (key === 'size' && isNoteNode && b < a && b === expectedSize) continue;

    problems.push(`${before.data.id}: field ${key} changed ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }

  if (before.classes !== after.classes) {
    // The class string mirrors `shared`, so it is permitted to move exactly when
    // `shared` was. Checked against the recomputed string rather than by
    // substring, so a class list that lost something ELSE is still a violation.
    const mirrored = String(before.classes).replace(' shared-kw', '');
    if (!(isCutKeywordNode && after.classes === mirrored)) {
      problems.push(`${before.data.id}: classes changed ${JSON.stringify(before.classes)} -> ${JSON.stringify(after.classes)}`);
    }
  }
  return problems;
}

/**
 * Is `after` explained by the DF cutoff applied to `before`?
 *
 * @param {Array} before   the pre-4.4 builder's elements
 * @param {Array} after    the live builder's elements
 * @param {{maxDf: number, notes: Array<{id: string, keywords: string[]}>}} ctx
 * @returns {{explained: boolean, violations: string[], counts: Object}}
 */
function explainDiff(before, after, { maxDf, notes }) {
  const { df, cut, expectedRemoved, expectedSize } = derive(notes, maxDf);
  const beforeById = byId(before);
  const afterById = byId(after);
  const violations = [];

  // ── clause 1: zero additions ──
  const added = after.filter((el) => !beforeById.has(el.data.id));
  if (added.length) {
    violations.push(`ADDED ${added.length} element(s), first ${added[0].data.id}`);
  }

  // ── clauses 2 and 3: what may be removed ──
  const removed = before.filter((el) => !afterById.has(el.data.id));
  const removedByTerm = new Map();
  for (const el of removed) {
    if (NON_CROSS_TYPES.has(el.data.type)) {
      violations.push(`REMOVED a ${el.data.type} element: ${el.data.id}`);
      continue;
    }
    if (el.data.type !== 'cross-link') {
      violations.push(`REMOVED an element of unexpected type ${el.data.type}: ${el.data.id}`);
      continue;
    }
    const kw = el.data.sharedKeyword;
    if (!cut.has(kw)) {
      violations.push(`REMOVED a cross-link on "${kw}" (df ${df.get(kw)}), which is NOT above maxDf ${maxDf}`);
    }
    removedByTerm.set(kw, (removedByTerm.get(kw) || 0) + 1);
  }

  // all-or-nothing per term, in both directions
  for (const kw of cut) {
    const d = df.get(kw);
    const expected = (d * (d - 1)) / 2;
    const actual = removedByTerm.get(kw) || 0;
    if (actual !== expected) {
      violations.push(`PARTIAL cut on "${kw}": removed ${actual} of ${expected} cross-links (df ${d})`);
    }
  }
  for (const el of after) {
    if (el.data.type === 'cross-link' && cut.has(el.data.sharedKeyword)) {
      violations.push(`SURVIVING cross-link on cut term "${el.data.sharedKeyword}": ${el.data.id}`);
      break;
    }
  }

  // ── clause 4 and 5: surviving elements ──
  let sharedFlipped = 0;
  let sizeChanged = 0;
  for (const el of after) {
    const prev = beforeById.get(el.data.id);
    if (!prev) continue;
    const isCutKeywordNode = el.data.type === 'keyword' && cut.has(el.data.keyword);
    const isNoteNode = el.data.type === 'note';
    const problems = fieldViolations(prev, el, {
      isCutKeywordNode,
      isNoteNode,
      expectedSize: expectedSize.get(el.data.id),
    });
    violations.push(...problems);
    if (prev.data.shared !== el.data.shared) sharedFlipped += 1;
    if (prev.data.size !== el.data.size) sizeChanged += 1;
  }

  // ── clause 5: order preserved ──
  const survivingBefore = before.filter((el) => afterById.has(el.data.id)).map((el) => el.data.id);
  const survivingAfter = after.filter((el) => beforeById.has(el.data.id)).map((el) => el.data.id);
  for (let i = 0; i < Math.min(survivingBefore.length, survivingAfter.length); i++) {
    if (survivingBefore[i] !== survivingAfter[i]) {
      violations.push(`ORDER changed at surviving index ${i}: ${survivingBefore[i]} != ${survivingAfter[i]}`);
      break;
    }
  }

  // ── clause 6: the independent arithmetic ──
  if (removed.length !== expectedRemoved) {
    violations.push(
      `COUNT mismatch: ${removed.length} element(s) removed, `
      + `Sigma C(df,2) over cut terms says ${expectedRemoved}`
    );
  }

  return {
    explained: violations.length === 0,
    violations,
    counts: {
      before: before.length,
      after: after.length,
      removed: removed.length,
      expectedRemoved,
      added: added.length,
      cutTerms: cut.size,
      sharedFlipped,
      sizeChanged,
    },
  };
}

module.exports = { explainDiff, derive, normList };
