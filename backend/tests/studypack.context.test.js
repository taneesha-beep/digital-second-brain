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

  test('the bound holds WITH ROOM TO SPARE — the margin that used to be zero', () => {
    // THIS TEST CHANGED WITH THE DIVISOR AND THE HISTORY IS THE POINT.
    //
    // It used to assert `min slack === 0`, and that equality was itself a
    // finding: on the 79 rows the constant was fitted on the minimum was +1
    // token, and on all 151 it was 0 — the bound never violated, but at least
    // one real call landing EXACTLY on the estimate. The comment here read
    // "'never underestimates' and 'never underestimates with room to spare'
    // are two different claims, and only the first survives".
    //
    // THAT SENTENCE WAS THE WARNING AND NOBODY READ IT AS ONE. A bound sitting
    // exactly on its worst observation is a bound the next population breaks,
    // and the next population — cluster prompts — broke it by 97 tokens. The
    // divisor moved 4.5 -> 4.2 at the pre-Phase-8 sweep, so the margin is real
    // again on single-note prompts too, and this asserts the STRONGER of the
    // two claims rather than recording the weaker one as inevitable.
    const slacks = rows.map((r) => sp.estimateTokens('x'.repeat(charsFor(r))) - r.promptTokens);
    expect(Math.min(...slacks)).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THE POPULATION THE ESTIMATOR ACTUALLY SERVES — the pre-Phase-8 sweep.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // ⚠️ EVERY TEST ABOVE READS gen-v2.calls.jsonl, WHICH IS 151 SINGLE-NOTE
  // PROMPTS. That is where the constant was fitted, and the bound holds there.
  // The constant SHIPS on CLUSTER prompts ~10x longer, and it did not hold
  // there: 27 of 60 committed cluster calls underestimated, worst -97 tokens.
  //
  // SO THIS FILE PINNED THE BOUND EXACTLY WHERE IT COULD NOT FAIL AND WAS
  // SILENT EXACTLY WHERE IT BROKE — §22.6's shape, in the file written to stop
  // a guess shipping. §32.3 named it at 5.4, 5.6 named it again while adding a
  // SECOND estimator without fixing the first, and it survived three more
  // phases because nothing here could go red.
  //
  // WHY IT WAS NOT SIMPLY FIXED AT THE TIME, AND WHY THAT REASON IS SPENT:
  // §30.3 refused to read `data/gen-eval/clusters.jsonl`, correctly — it is
  // TRACKED, so a test needing it PASSES IN CI and FAILS in the local
  // reproduction of CI, where §29.11 moves data/ aside entirely. But the
  // cluster LEDGERS are under results/ and carry `context.notes[]` with the
  // full text of every admitted note, so the same check needs nothing under
  // data/ after all. The obstacle was real and it moved when 5.4 and 5.7
  // committed their ledgers.
  describe('the bound on CLUSTER prompts, which is what actually ships', () => {
    // THE ESTIMATE IS RECOMPUTED AT THE CURRENT CONSTANT, NOT READ OFF THE
    // LEDGER, AND THAT IS FORCED RATHER THAN CHOSEN. `estimatorSlackTokens` was
    // written by the shipped code AT CALL TIME, in August, at whatever
    // CHARS_PER_TOKEN was then — so it is a record of a past configuration and
    // cannot answer a question about the current one. Testing a constant
    // against historical calls means re-deriving what it WOULD have estimated.
    //
    // THE RECONSTRUCTION IS SHARED WITH THE REPORTER, NOT COPIED. A third
    // implementation of the per-span ceil is exactly how 5.7 got 3.437, and
    // "one quantity, two readers" is the defect this sweep keeps finding. The
    // first test below is what licenses the rest: it re-runs the shared
    // reconstruction at the HISTORICAL 4.5 and requires it to reproduce the
    // ledger's own `estimatedPromptTokens` on every row, so a wrong
    // reconstruction fails loudly instead of quietly answering the wrong
    // question.
    const { clusterEstimate } = require('../scripts/measure-estimator-bound');
    const HISTORICAL_DIVISOR = 4.5;

    const clusterRows = ['gen-v5', 'gen-v7'].flatMap((arm) => {
      const file = path.join(__dirname, '..', '..', 'results', `${arm}.calls.jsonl`);
      return fs.readFileSync(file, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line))
        .filter((r) => r.ok && r.context && Number.isFinite(r.promptTokens))
        .map((r) => ({ ...r, arm }));
    });

    test('both committed cluster ledgers are here, at the size they were run to', () => {
      // A floor is what let the single-note artifact drift for three phases
      // while every test kept passing (see the equality above). Pinned exactly,
      // for the same reason: if either ledger grows, this goes red and
      // results/estimator-bound.txt gets regenerated with it.
      expect(clusterRows.filter((r) => r.arm === 'gen-v5')).toHaveLength(30);
      expect(clusterRows.filter((r) => r.arm === 'gen-v7')).toHaveLength(30);
    });

    test('THE LICENCE: the reconstruction reproduces what the shipped code computed', () => {
      // Everything below is void without this. At the divisor these calls were
      // actually made with, the reconstruction must equal the ledger's own
      // recorded estimate — every row, exactly, no tolerance.
      const off = clusterRows
        .filter((r) => clusterEstimate(r, HISTORICAL_DIVISOR) !== r.context.estimatedPromptTokens)
        .map((r) => ({ arm: r.arm, seed: r.seedId }));
      expect(off).toEqual([]);
    });

    test('the ledgers were taken at that divisor, which the licence above assumes', () => {
      // Otherwise the licence passes for the wrong reason and stops being one.
      for (const r of clusterRows) {
        expect(r.estimatorSlackTokens).toBe(r.context.estimatedPromptTokens - r.promptTokens);
      }
      // And the shipped constant is NOT the historical one — if it ever is
      // again, the fix was reverted and these tests are asserting nothing new.
      expect(sp.CHARS_PER_TOKEN).not.toBe(HISTORICAL_DIVISOR);
    });

    test('IT NEVER UNDERESTIMATES ON A CLUSTER PROMPT EITHER', () => {
      // THE ASSERTION THIS FILE COULD NOT MAKE. At CHARS_PER_TOKEN 4.5 it fails
      // on 27 of 60 rows, worst -97 tokens, which is the whole point of it.
      //
      // The direction matters for a NARROWER reason than the single-note test
      // above claims, and overstating it would be its own defect.
      // CONTEXT_TOKEN_BUDGET is 1,800 — set by the RATE LIMIT, far below this
      // model's context window — so an underestimate does not overflow
      // anything. It means ONE MORE NOTE WAS ADMITTED than the budget intended
      // and the reservation was that much low. The guarantee that breaks is
      // "the assembled prompt is at most 1,800 estimated tokens", not "the
      // request fits".
      const under = clusterRows
        .map((r) => ({ arm: r.arm, seed: r.seedId, slack: clusterEstimate(r, sp.CHARS_PER_TOKEN) - r.promptTokens }))
        .filter((r) => r.slack < 0);
      expect(under).toEqual([]);
    });

    test('and it keeps a real margin rather than landing exactly on the bound', () => {
      // 4.238095 is the TIGHTEST divisor bounding all 60 and has slack ZERO on
      // its worst call. That is precisely the fragility that produced this
      // entry: the shipped 4.5 had slack +1 on the 79 rows it was fitted on, 0
      // on all 151, and -97 on clusters. A bound with no margin is a bound the
      // next population breaks.
      //
      // The margin is FREE, measured rather than assumed —
      // results/estimator-bound.txt section E replays the admission loop and
      // finds 4.2 and 4.238095 dropping THE SAME 13 packs by THE SAME one note.
      const slacks = clusterRows.map((r) => clusterEstimate(r, sp.CHARS_PER_TOKEN) - r.promptTokens);
      expect(Math.min(...slacks)).toBeGreaterThan(0);
    });

    test('the two arms are checked SEPARATELY, because pooling hid this for a phase', () => {
      // 4.333 bounds gen-v5's 30 calls exactly and misses 2 of gen-v7's. A
      // pooled-only assertion would go green on an arm-shaped defect for
      // exactly as long as the recorded divisor did — which was one phase.
      for (const arm of ['gen-v5', 'gen-v7']) {
        const worst = Math.min(...clusterRows
          .filter((r) => r.arm === arm)
          .map((r) => clusterEstimate(r, sp.CHARS_PER_TOKEN) - r.promptTokens));
        expect(worst).toBeGreaterThan(0);
      }
    });

    test('it is not so loose as to be useless on clusters either', () => {
      // The other direction. A divisor of 1 would never underestimate and would
      // make the budget meaningless — every pack would be the seed alone.
      const overs = clusterRows.map((r) => (clusterEstimate(r, sp.CHARS_PER_TOKEN) - r.promptTokens) / r.promptTokens);
      const mean = overs.reduce((a, b) => a + b, 0) / overs.length;
      expect(mean).toBeGreaterThan(0);
      expect(mean).toBeLessThan(0.20);
    });
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

    // 4.5 -> 4.2 at the pre-Phase-8 sweep, 27 Aug 2026. Pinned EXACTLY, because
    // this constant decides what reaches the model and a range would let it
    // drift back. The derivation is results/estimator-bound.txt; 4.2 is a PICK
    // below the derived bound of 4.238095, and the service header says which is
    // which.
    expect(sp.CHARS_PER_TOKEN).toBe(4.2);

    // NOT 4.333, WHICH IS WHAT THREE DOCUMENTS AND ONE CODE COMMENT RECORDED AS
    // "the tightest divisor that bounds every observed call". It bounds gen-v5's
    // 30 calls and misses 2 of gen-v7's. Pinned negatively so a future session
    // reading those documents cannot quietly adopt the stale value.
    expect(sp.CHARS_PER_TOKEN).not.toBe(4.333);

    // The per-span helper carries NO overhead — a context assembled from nine
    // notes must pay the chat scaffolding once, not nine times.
    expect(sp.textTokens('x'.repeat(42))).toBe(10);
    expect(sp.estimateTokens('x'.repeat(42))).toBe(100);
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
