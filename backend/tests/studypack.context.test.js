'use strict';

/**
 * studypack.context.test.js — Phase 5.1. The pure half of Study Pack.
 *
 * NO NETWORK, NO KEY, NO DATABASE, AND NO data/ — so it runs everywhere `npm
 * test` runs, CI included, and it does not move the promised-skip ledger.
 *
 * The `data/` point is deliberate rather than incidental. The token estimator is
 * calibrated against real API responses, and the obvious place to reconstruct
 * those prompts from is `data/gen-eval/clusters.jsonl` — which is tracked, so it
 * IS present in CI. But §29.11 records that reproducing CI's conditions locally
 * moves `data/` aside ENTIRELY, "a superset of what CI lacks". A test depending
 * on it would pass in CI and fail in the local reproduction of CI, which is the
 * worst of both. `results/gen-v2.calls.jsonl` carries `contentChars` on every
 * row, so the same check needs nothing under `data/`.
 */

const fs = require('fs');
const path = require('path');

const live = require('../services/llm.service');
const sp = require('../services/studyPack.service');

const LEDGER = path.join(__dirname, '..', '..', 'results', 'gen-v2.calls.jsonl');

// ───────────────────────────────────────────────────────────────────────────
// THE TOKEN ESTIMATOR — checked against 151 real API responses, not asserted.
// ───────────────────────────────────────────────────────────────────────────

describe('the token estimator is a BOUND, and the bound is measured', () => {
  const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .filter((r) => r.ok && Number.isFinite(r.promptTokens) && Number.isFinite(r.contentChars));

  /** The exact user message llm.service.js sends, in characters. */
  const charsFor = (row) =>
    live.SYSTEM_MESSAGE.length +
    live.PROMPTS[row.feature].length +
    '\n\nNotes:\n'.length +
    row.contentChars;

  test('the ledger it is calibrated against is actually there, at the size the artifact was fitted on', () => {
    // Without this the three tests below pass vacuously on an empty array —
    // §26.7's defect, in the file whose whole job is to stop a guess shipping.
    expect(rows.length).toBeGreaterThanOrEqual(70);

    // PINNED EXACTLY, 23 Aug 2026, BECAUSE A FLOOR IS WHAT LET THIS DRIFT.
    // This file read `>= 70` and the ledger grew from 79 to 151 when 5.5
    // completed gen-v2. Every test below kept passing on the larger set while
    // this file's comments, its test names and results/studypack-constants.txt
    // all still described the 79. Nothing was WRONG — the bound holds on all
    // 151 — but the artifact was stale for three phases and no check could say
    // so, because a floor cannot notice growth. An equality can: if the ledger
    // ever grows again, this goes red and the artifact gets regenerated with
    // it, which is the only thing that keeps the two in step.
    expect(rows.length).toBe(151);
  });

  test('it NEVER underestimates on any of the 151 completed calls', () => {
    // The direction that matters. An underestimate spends budget the request
    // does not have, which is how a context window overflows in production
    // while every local number looks fine.
    const under = rows
      .map((r) => ({ feature: r.feature, slack: sp.estimateTokens('x'.repeat(charsFor(r))) - r.promptTokens }))
      .filter((r) => r.slack < 0);
    expect(under).toEqual([]);
  });

  test('the bound holds, and on the completed ledger its margin is ZERO', () => {
    // WORTH ITS OWN TEST BECAUSE THE GUARANTEE GOT WEAKER WITHOUT MOVING.
    // On the 79 rows the artifact was originally fitted on, the minimum slack
    // was 1 token. On all 151 it is 0 — the bound is still never violated, but
    // at least one real call now lands exactly on the estimate. "Never
    // underestimates" and "never underestimates with room to spare" are two
    // different claims, and only the first survives on the completed set.
    const slacks = rows.map((r) => sp.estimateTokens('x'.repeat(charsFor(r))) - r.promptTokens);
    expect(Math.min(...slacks)).toBe(0);
  });

  test('it is not so loose as to be useless — under 20% over on average', () => {
    // A bound of "one token per character" would also never underestimate and
    // would make the budget meaningless. Measured: 9.3% mean overestimate over
    // all 151 (it was 10.4% over the 79 the artifact was first fitted on).
    const overs = rows.map((r) => {
      const est = sp.estimateTokens('x'.repeat(charsFor(r)));
      return (est - r.promptTokens) / r.promptTokens;
    });
    const mean = overs.reduce((a, b) => a + b, 0) / overs.length;
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(0.20);
  });

  test('the two constants are the ones the header argues for', () => {
    expect(sp.TOKENIZER_OVERHEAD).toBe(90);
    expect(sp.CHARS_PER_TOKEN).toBe(4.5);
    // The per-span helper carries NO overhead — a context assembled from nine
    // notes must pay the chat scaffolding once, not nine times.
    expect(sp.textTokens('x'.repeat(45))).toBe(10);
    expect(sp.estimateTokens('x'.repeat(45))).toBe(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CONTEXT ASSEMBLY AND THE TRUNCATION STRATEGY.
// ───────────────────────────────────────────────────────────────────────────

const doc = (id, words, title = `note ${id}`) => ({
  id: String(id),
  title,
  body: Array.from({ length: words }, (_, i) => `word${i}`).join(' ')
});

/** hits as retrieval.search returns them, with the rank buildCluster adds. */
const hits = (...ids) => ids.map((id, i) => ({ docId: String(id), score: 100 - i, rank: i + 1 }));

describe('assembleContext admits whole notes in rank order', () => {
  const seed = doc('s', 20);
  const neighbours = [doc(1, 20), doc(2, 20), doc(3, 20)];
  const byId = new Map(neighbours.map((d) => [d.id, d]));

  test('the seed is always first and always label 1', () => {
    const ctx = sp.assembleContext(seed, hits(1, 2, 3), byId);
    expect(ctx.included[0]).toMatchObject({ label: 1, noteId: 's', role: 'seed' });
    expect(ctx.text.startsWith('[1] note s')).toBe(true);
  });

  test('labels are contiguous from 1 and match the rank order', () => {
    const ctx = sp.assembleContext(seed, hits(1, 2, 3), byId);
    expect(ctx.included.map((n) => n.label)).toEqual([1, 2, 3, 4]);
    expect(ctx.included.map((n) => n.noteId)).toEqual(['s', '1', '2', '3']);
    expect(ctx.dropped).toEqual([]);
  });

  test('every admitted note appears in the text under its own label', () => {
    const ctx = sp.assembleContext(seed, hits(1, 2, 3), byId);
    for (const n of ctx.included) {
      expect(ctx.text).toContain(`[${n.label}] ${n.title}`);
    }
  });

  test('a neighbour deleted since the index was built is skipped, not crashed on', () => {
    const ctx = sp.assembleContext(seed, hits(1, 999, 2), byId);
    expect(ctx.included.map((n) => n.noteId)).toEqual(['s', '1', '2']);
  });
});

describe('when the budget binds, whole notes go from the TAIL', () => {
  const seed = doc('s', 10);
  const big = [doc(1, 200), doc(2, 200), doc(3, 200)];
  const byId = new Map(big.map((d) => [d.id, d]));

  test('the notes that fit are kept and the rest are reported as dropped', () => {
    const ctx = sp.assembleContext(seed, hits(1, 2, 3), byId, 700);
    expect(ctx.included.length).toBeGreaterThanOrEqual(2);
    expect(ctx.dropped.length).toBeGreaterThanOrEqual(1);
    expect(ctx.included.length + ctx.dropped.length).toBe(4);
  });

  test('the estimate never exceeds the budget it was given', () => {
    for (const budget of [400, 600, 800, 1200, 1800]) {
      const ctx = sp.assembleContext(seed, hits(1, 2, 3), byId, budget);
      if (!ctx.budgetExceededBySeed) expect(ctx.estimatedTokens).toBeLessThanOrEqual(budget);
    }
  });

  test('dropped notes are the LOWEST-RANKED ones, never the shortest', () => {
    // The load-bearing property. A rank-3 note that happens to be short must
    // NOT be promoted past a rank-2 note that did not fit — that would reorder
    // the cluster by length, which is not a relevance judgment.
    const mixed = [doc(1, 200), doc(2, 200), doc(3, 2)];
    const ctx = sp.assembleContext(seed, hits(1, 2, 3), new Map(mixed.map((d) => [d.id, d])), 700);
    const droppedIds = ctx.dropped.map((d) => d.noteId);
    expect(droppedIds).toContain('3');
    const includedIds = ctx.included.map((n) => n.noteId);
    // whatever survived, it is a PREFIX of the ranked list
    expect(includedIds.slice(1)).toEqual(['1', '2', '3'].slice(0, includedIds.length - 1));
  });

  test('no note is ever cut mid-body', () => {
    const ctx = sp.assembleContext(seed, hits(1, 2, 3), byId, 700);
    for (const n of ctx.included) {
      const source = n.role === 'seed' ? seed : byId.get(n.noteId);
      expect(ctx.text).toContain(source.body);
    }
  });

  test('a seed bigger than the whole budget is still included, with zero neighbours', () => {
    const ctx = sp.assembleContext(doc('s', 3000), hits(1, 2, 3), byId, 700);
    expect(ctx.budgetExceededBySeed).toBe(true);
    expect(ctx.included.map((n) => n.role)).toEqual(['seed']);
    expect(ctx.dropped).toHaveLength(3);
    expect(ctx.dropped.every((d) => d.reason === 'seed-exceeds-budget')).toBe(true);
  });

  test('the shipped budget is the one the header argues for', () => {
    expect(sp.CONTEXT_TOKEN_BUDGET).toBe(1800);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PARSING — no strip, and the fallback is COUNTED.
// ───────────────────────────────────────────────────────────────────────────

describe('parseStudyPackJson parses rather than strips', () => {
  const payload = '{"flashcards":[{"q":"a","a":"b","source":1}],"concepts":[]}';

  test('clean JSON parses with no fallback', () => {
    const out = sp.parseStudyPackJson(payload);
    expect(out.value.flashcards).toHaveLength(1);
    expect(out.usedFallbackParse).toBe(false);
    expect(out.parseError).toBeNull();
  });

  test('a fenced object parses, and the fallback is REPORTED', () => {
    const out = sp.parseStudyPackJson('```json\n' + payload + '\n```');
    expect(out.value.flashcards).toHaveLength(1);
    expect(out.usedFallbackParse).toBe(true);
  });

  test('a fence INSIDE a string value survives — the defect llm.service.js has', () => {
    // tests/gen-shipped-parity.test.js pins the shipped strip deleting ``` from
    // content because its regexes are unanchored and global. A parser cannot do
    // that, which is the reason this surface parses instead of stripping.
    const raw = '{"flashcards":[{"q":"what does ``` mean","a":"a code fence","source":1}],"concepts":[]}';
    const out = sp.parseStudyPackJson(raw);
    expect(out.value.flashcards[0].q).toBe('what does ``` mean');
  });

  test('a truncated payload REPORTS a parse error instead of throwing', () => {
    const out = sp.parseStudyPackJson('{"flashcards":[{"q":"a","a":"b","sou');
    expect(out.value).toBeNull();
    expect(typeof out.parseError).toBe('string');
  });

  test('empty text is a parse failure, not an empty pack', () => {
    expect(sp.parseStudyPackJson('').value).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CITATIONS — kept and flagged, never dropped and never repaired.
// ───────────────────────────────────────────────────────────────────────────

describe('resolveCitations maps labels to note ids and flags what it cannot', () => {
  const included = [
    { label: 1, noteId: 'aaa', title: 'seed' },
    { label: 2, noteId: 'bbb', title: 'neighbour one' }
  ];
  const keys = ['q', 'a'];

  test('a valid label resolves to its note id and title', () => {
    const [item] = sp.resolveCitations([{ q: 'x', a: 'y', source: 2 }], included, keys);
    expect(item).toMatchObject({ sourceNoteId: 'bbb', sourceTitle: 'neighbour one', citation: 'valid', complete: true });
  });

  test('an out-of-range label is KEPT and flagged, not dropped', () => {
    const items = sp.resolveCitations([{ q: 'x', a: 'y', source: 7 }], included, keys);
    expect(items).toHaveLength(1);
    expect(items[0].citation).toBe('out-of-range');
    expect(items[0].sourceNoteId).toBeNull();
  });

  test('a missing or unusable source is distinguished from an out-of-range one', () => {
    const items = sp.resolveCitations(
      [{ q: 'x', a: 'y' }, { q: 'x', a: 'y', source: 'note two' }],
      included,
      keys
    );
    expect(items.map((i) => i.citation)).toEqual(['missing', 'missing']);
  });

  test('a numeric string label is accepted — the model is asked for a number, not a type', () => {
    const [item] = sp.resolveCitations([{ q: 'x', a: 'y', source: '2' }], included, keys);
    expect(item.citation).toBe('valid');
    expect(item.source).toBe(2);
  });

  test('a wrong SHAPE and a wrong CITATION are two separate flags', () => {
    const [item] = sp.resolveCitations([{ q: 'x', a: '', source: 1 }], included, keys);
    expect(item.citation).toBe('valid');
    expect(item.complete).toBe(false);
    expect(item.missingKeys).toEqual(['a']);
  });

  test('nothing is ever repaired — the label the model emitted is preserved', () => {
    const [item] = sp.resolveCitations([{ q: 'x', a: 'y', source: 9 }], included, keys);
    expect(item.source).toBe(9);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE CONTROL. This suite fails if 5.1 touched the five shipped features.
// ───────────────────────────────────────────────────────────────────────────

describe('Study Pack did not disturb the A/B control', () => {
  test('llm.service.js still exports exactly five prompts', () => {
    expect(Object.keys(live.PROMPTS).sort())
      .toEqual(['concepts', 'eli5', 'examQs', 'flashcards', 'summarize']);
  });

  test('Study Pack asks for the SAME item counts as the single-note prompts', () => {
    // One fewer variable in the eventual gen-v1 vs gen-v5 comparison (§28.2).
    expect(sp.FLASHCARD_COUNT).toBe(6);
    expect(sp.CONCEPT_COUNT).toBe(8);
    expect(live.PROMPTS.flashcards).toContain(String(sp.FLASHCARD_COUNT));
    expect(live.PROMPTS.concepts).toContain(String(sp.CONCEPT_COUNT));
  });

  test('it inherits the model and temperature, and sets its OWN ceiling deliberately', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'studyPack.service.js'), 'utf8');
    expect(source).toContain("require('./llm.service')");

    // UPDATED AT 5.9, AND THE EXPECTATION FLIPPED RATHER THAN THE CHECK BEING
    // DELETED. This assertion used to forbid a ceiling in this file at all, on
    // the grounds that "a literal ceiling here would be a second number to keep
    // in step with the one §29.2 argued for, and nothing would notice them
    // diverging." §29.2 argued that number from `examQs` demand, and 5.4/5.7
    // measured it stopping 7 of 30 study-pack calls in each of two arms — so
    // the two numbers SHOULD diverge, and the old assertion was pinning the
    // defect in place. The check is now equally strict in the other direction:
    // the divergence has to be deliberate, named, and visible in one file.
    expect(source).not.toMatch(/max_tokens:\s*\d/);            // still no magic literal at the call
    expect(source).toContain('max_tokens: STUDY_PACK_MAX_TOKENS');
    expect(sp.STUDY_PACK_MAX_TOKENS).toBe(4096);

    // The inherited value is still imported, so this file shows where its own
    // number came from. Not dead code: it is the provenance, and the assertion
    // below is what stops a later edit quietly re-converging them.
    expect(sp.INHERITED_MAX_TOKENS).toBe(live.MAX_TOKENS);
    expect(sp.STUDY_PACK_MAX_TOKENS).not.toBe(sp.INHERITED_MAX_TOKENS);
  });

  test('5.9 moved the OUTPUT ceiling and left the INPUT budget alone', () => {
    // The one-variable rule, pinned. CONTEXT_TOKEN_BUDGET is what
    // results/studypack-constants.txt rests on and what every committed
    // estimator row was fitted against; moving it in the same change as the
    // ceiling would have been two variables.
    expect(sp.CONTEXT_TOKEN_BUDGET).toBe(1800);
    expect(sp.FLASHCARD_COUNT).toBe(6);
    expect(sp.CONCEPT_COUNT).toBe(8);
  });

  test('its system message differs from the shipped one, and only in the JSON shape', () => {
    // Named as a difference rather than hidden: the five features ask for an
    // ARRAY and a study pack returns an OBJECT, so the shipped sentence would
    // be wrong here. Everything before that clause is identical.
    expect(sp.STUDY_PACK_SYSTEM_MESSAGE).not.toBe(live.SYSTEM_MESSAGE);
    expect(sp.STUDY_PACK_SYSTEM_MESSAGE).toContain('You are a helpful study assistant.');
    expect(sp.STUDY_PACK_SYSTEM_MESSAGE).toContain('JSON object');
    expect(live.SYSTEM_MESSAGE).toContain('JSON array');
  });

  test('the prompt demands a source on every item and forbids inventing one', () => {
    const prompt = sp.buildPrompt(9);
    expect(prompt).toContain('"source"');
    expect(prompt).toContain('Never invent a number');
    expect(prompt).toContain('9 related notes');
  });
});
