'use strict';

/**
 * judge-metrics.test.js — Phase 5.6.
 *
 * PURE: no network, no key, no database, nothing under data/. So it needs no
 * precondition, runs everywhere including CI, and CI's promised-skip ledger
 * does not move. Same position as tests/studypack-metrics.test.js.
 *
 * WHAT THIS SUITE IS FOR, AND IT IS NOT THE SAME AS 5.4's. A conformance rate
 * computed wrongly usually looks wrong. COHEN'S KAPPA COMPUTED WRONGLY LOOKS
 * EXACTLY LIKE COHEN'S KAPPA — it is a single number in [-1, 1] with no
 * external referent, and the most common wrong implementations (swapping the
 * marginals, dividing by n instead of n^2, or returning raw agreement) all
 * produce plausible values. So the arithmetic is pinned against worked examples
 * with hand-computed answers, including the paradox case, rather than against
 * "it returned a number".
 *
 * The sampling and ordering are pinned for a different reason: §32.8 records
 * that gen-v5's stratification was protected by nothing and balanced by luck,
 * and the fix here is an ORDER. An order is exactly the kind of property that
 * looks right when eyeballed and is wrong at the tail.
 */

const fs = require('fs');
const path = require('path');

const judge = require('../scripts/lib/judge-metrics');
const rubric = require('../scripts/lib/judge-rubric');

const {
  hash32, itemKey, itemsForRow, nullLabelFor, orderItems, allocate,
  selectHumanSample, buildPairSet, cohensKappa, rateOf, NULL_SEED
} = judge;

// ---------------------------------------------------------------------------
// Fixtures. Built from the spec rather than typed out, so a fixture cannot
// drift from the thing it is a fixture for.
// ---------------------------------------------------------------------------

function note(label, text = `note ${label} body text`) {
  return { label, noteId: `n${label}`, title: `Title ${label}`, role: label === 1 ? 'seed' : 'neighbour', rank: label - 1, text };
}

function row({ seedId = '100', quintile = 1, labels = [1, 2, 3], flashcards = 2, concepts = 2, source = 1 } = {}) {
  const payload = {
    flashcards: Array.from({ length: flashcards }, (_, i) => ({ q: `q${i}`, a: `a${i}`, source })),
    concepts: Array.from({ length: concepts }, (_, i) => ({ term: `t${i}`, definition: `d${i}`, source }))
  };
  return {
    seedId, quintile, ok: true, finishReason: 'stop',
    model: 'openai/gpt-oss-120b',
    context: { notes: labels.map((l) => note(l)) },
    rawText: JSON.stringify(payload)
  };
}

// ---------------------------------------------------------------------------
describe('parseVerdict', () => {
  test('reads a leading level and the reason after it', () => {
    const v = rubric.parseVerdict('2 every assertion appears in the passage');
    expect(v.level).toBe(2);
    expect(v.reason).toBe('every assertion appears in the passage');
    expect(v.parseFailed).toBe(false);
    expect(v.sawThinkBlock).toBe(false);
  });

  test.each([['0', 0], ['1', 1], ['2', 2]])('accepts a bare %s', (text, level) => {
    expect(rubric.parseVerdict(text).level).toBe(level);
  });

  test('tolerates leading whitespace and blank lines', () => {
    expect(rubric.parseVerdict('\n\n   1 partial').level).toBe(1);
  });

  test('a level outside the rubric is a PARSE FAILURE, not a clamp', () => {
    // 3 is not a rubric level. Clamping it to 2 would invent a verdict, and a
    // rate built from invented verdicts is unfalsifiable.
    const v = rubric.parseVerdict('3 supported');
    expect(v.level).toBeNull();
    expect(v.parseFailed).toBe(true);
  });

  test('prose with no leading digit fails to parse rather than being searched', () => {
    // Scanning the line for any digit would read "SUPPORTED (2)" as 2 — and
    // would also read "not 2" as 2. §30.6: count a failure, do not repair it.
    const v = rubric.parseVerdict('The claim is SUPPORTED (2) by the passage.');
    expect(v.parseFailed).toBe(true);
    expect(v.level).toBeNull();
  });

  test('a digit embedded in a word is not a verdict', () => {
    expect(rubric.parseVerdict('2nd paragraph supports it').parseFailed).toBe(true);
  });

  test('empty and null inputs fail cleanly', () => {
    for (const input of ['', '   ', null, undefined]) {
      expect(rubric.parseVerdict(input).parseFailed).toBe(true);
    }
  });

  test('a <think> block is stripped AND recorded, never silently absorbed', () => {
    const v = rubric.parseVerdict('<think>\nlots of reasoning\n</think>\n\n0 not in the passage');
    expect(v.level).toBe(0);
    expect(v.sawThinkBlock).toBe(true);
  });

  test('an UNCLOSED think block does not yield a verdict from its contents', () => {
    // The run disables reasoning. If a think block appears at all it is a
    // provider-side change, and an unterminated one means the reply was cut
    // off mid-reasoning — there is no verdict in it to read.
    const v = rubric.parseVerdict('<think>\nI think the answer is 2 because');
    expect(v.parseFailed).toBe(true);
    expect(v.sawThinkBlock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('toBinary', () => {
  test('collapses to the distinction the headline rate makes', () => {
    expect(rubric.toBinary(2)).toBe(1);
    expect(rubric.toBinary(1)).toBe(0);
    expect(rubric.toBinary(0)).toBe(0);
  });

  test('PARTIAL collapses DOWN, not up', () => {
    // The headline rate is "the passage supports every assertion". Folding
    // PARTIAL into supported would make the rate mean something else while
    // still being called groundedness.
    expect(rubric.toBinary(1)).toBe(0);
  });

  test('null stays null so an unparsed verdict is never counted as a 0', () => {
    expect(rubric.toBinary(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("Cohen's kappa", () => {
  // A worked 2x2 with a hand-computed answer:
  //        judge=1  judge=0
  //  h=1      20       5      row 25
  //  h=0      10      15      row 25
  //  cols     30      20      n = 50
  //  P_o = 35/50 = 0.70
  //  P_e = (25/50)(30/50) + (25/50)(20/50) = 0.30 + 0.20 = 0.50
  //  kappa = (0.70 - 0.50) / 0.50 = 0.40
  function worked() {
    const out = [];
    for (let i = 0; i < 20; i += 1) out.push([1, 1]);
    for (let i = 0; i < 5; i += 1) out.push([1, 0]);
    for (let i = 0; i < 10; i += 1) out.push([0, 1]);
    for (let i = 0; i < 15; i += 1) out.push([0, 0]);
    return out;
  }

  test('reproduces a hand-computed example exactly', () => {
    const k = cohensKappa(worked(), [0, 1]);
    expect(k.n).toBe(50);
    expect(k.po).toBeCloseTo(0.7, 10);
    expect(k.pe).toBeCloseTo(0.5, 10);
    expect(k.kappa).toBeCloseTo(0.4, 10);
  });

  test('kappa is NOT observed agreement — the two differ on the worked example', () => {
    // The single most common wrong implementation returns P_o. It would pass
    // any test that only asserts "a number in [0,1]".
    const k = cohensKappa(worked(), [0, 1]);
    expect(k.kappa).not.toBeCloseTo(k.po, 3);
  });

  test('perfect agreement across two used categories is kappa 1', () => {
    const pairs = [[2, 2], [2, 2], [0, 0], [0, 0], [1, 1]];
    const k = cohensKappa(pairs, rubric.LEVELS);
    expect(k.po).toBe(1);
    expect(k.kappa).toBeCloseTo(1, 10);
  });

  test('THE KAPPA PARADOX: 90% agreement can give a NEGATIVE kappa', () => {
    // 45 / 3 / 2 / 0 over 50. P_o = 0.90, P_e = 0.9048, kappa < 0.
    // This is the regime this phase predicts, and a bare kappa in it would
    // read as "no agreement" while the raters agreed on 9 items in 10.
    const pairs = [];
    for (let i = 0; i < 45; i += 1) pairs.push([1, 1]);
    for (let i = 0; i < 3; i += 1) pairs.push([1, 0]);
    for (let i = 0; i < 2; i += 1) pairs.push([0, 1]);
    const k = cohensKappa(pairs, [0, 1]);
    expect(k.po).toBeCloseTo(0.9, 10);
    expect(k.pe).toBeCloseTo(0.9048, 4);
    expect(k.kappa).toBeLessThan(0);
    expect(k.po - k.kappa).toBeGreaterThan(0.2);
  });

  test('kappa is NULL, not 0, when both raters used exactly one category', () => {
    // P_e = 1 makes the statistic undefined. Returning 0 would report "no
    // agreement beyond chance" for two raters who agreed on every item.
    const k = cohensKappa([[0, 0], [0, 0], [0, 0]], [0, 1]);
    expect(k.po).toBe(1);
    expect(k.pe).toBe(1);
    expect(k.kappa).toBeNull();
  });

  test('systematic disagreement gives a negative kappa', () => {
    const k = cohensKappa([[0, 1], [1, 0], [0, 1], [1, 0]], [0, 1]);
    expect(k.po).toBe(0);
    expect(k.kappa).toBeLessThan(0);
  });

  test('the matrix is human-rows by judge-columns, and the two are NOT symmetric', () => {
    // Transposing is a silent error: kappa itself is symmetric, so a swap
    // cannot be caught by the kappa value. Only the marginals show it, and the
    // report prints them as "human" and "judge".
    const k = cohensKappa([[2, 0], [2, 0], [0, 2]], rubric.LEVELS);
    const i0 = k.categories.indexOf(0);
    const i2 = k.categories.indexOf(2);
    expect(k.matrix[i2][i0]).toBe(2);
    expect(k.matrix[i0][i2]).toBe(1);
    expect(k.rowMarginals[i2]).toBe(2);
    expect(k.colMarginals[i2]).toBe(1);
  });

  test('labels outside the category list are dropped from n, not coerced', () => {
    const k = cohensKappa([[2, 2], [null, 2], [2, undefined], [9, 1]], rubric.LEVELS);
    expect(k.n).toBe(1);
  });

  test('an empty input is n=0 with a null kappa rather than a throw', () => {
    const k = cohensKappa([], rubric.LEVELS);
    expect(k.n).toBe(0);
    expect(k.kappa).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('rateOf', () => {
  test('the denominator excludes nulls rather than counting them as misses', () => {
    const r = rateOf([2, 2, 0, null, undefined], 2);
    expect(r.hits).toBe(2);
    expect(r.n).toBe(3);
    expect(r.rate).toBeCloseTo(2 / 3, 10);
  });

  test('an unparsed verdict counted as a 0 would understate the rate', () => {
    const honest = rateOf([2, null], 2);
    const wrong = rateOf([2, 0], 2);
    expect(honest.rate).toBe(1);
    expect(wrong.rate).toBe(0.5);
  });

  test('n = 0 gives a null rate, never a 0', () => {
    expect(rateOf([], 2).rate).toBeNull();
    expect(rateOf([null, null], 2).rate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('allocate — proportional, largest remainder', () => {
  test('the parts sum to exactly the total', () => {
    const strata = new Map([['a', 48], ['b', 36], ['c', 40], ['d', 30], ['e', 32]]);
    const got = allocate(strata, 50);
    expect([...got.values()].reduce((x, y) => x + y, 0)).toBe(50);
  });

  test('rounding down everywhere would lose items — largest remainder does not', () => {
    // Three equal strata and a total of 10: 3.33 each floors to 9.
    const got = allocate(new Map([['a', 10], ['b', 10], ['c', 10]]), 10);
    expect([...got.values()].reduce((x, y) => x + y, 0)).toBe(10);
    expect([...got.values()].sort()).toEqual([3, 3, 4]);
  });

  test('no stratum is allocated more than it holds', () => {
    const strata = new Map([['tiny', 1], ['big', 99]]);
    const got = allocate(strata, 50);
    expect(got.get('tiny')).toBeLessThanOrEqual(1);
    expect([...got.values()].reduce((x, y) => x + y, 0)).toBe(50);
  });

  test('bigger strata get proportionally more', () => {
    const got = allocate(new Map([['big', 80], ['small', 20]]), 10);
    expect(got.get('big')).toBe(8);
    expect(got.get('small')).toBe(2);
  });

  test('an empty population allocates nothing rather than dividing by zero', () => {
    expect([...allocate(new Map(), 50).values()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('itemsForRow', () => {
  test('every well-formed item with a valid citation is judgeable', () => {
    const got = itemsForRow(row({ flashcards: 2, concepts: 3 }));
    expect(got.items).toHaveLength(5);
    expect(got.unciteable).toBe(0);
  });

  test('itemIndex counts WITHIN a slot, so a key is stable across slots', () => {
    const got = itemsForRow(row({ flashcards: 2, concepts: 2 }));
    const fc = got.items.filter((i) => i.slot === 'flashcards').map((i) => i.itemIndex);
    const cc = got.items.filter((i) => i.slot === 'concepts').map((i) => i.itemIndex);
    expect(fc).toEqual([0, 1]);
    expect(cc).toEqual([0, 1]);
  });

  test('an OUT-OF-RANGE citation is counted, not judged', () => {
    // Judging it would need a passage that was never in the prompt.
    const got = itemsForRow(row({ labels: [1, 2], source: 7 }));
    expect(got.items).toHaveLength(0);
    expect(got.unciteable).toBe(4);
  });

  test('a truncated pack yields no items and no crash', () => {
    const got = itemsForRow({ seedId: '1', quintile: 1, ok: true, context: { notes: [note(1)] }, rawText: '{"flashcards":[{"q":"a' });
    expect(got.items).toHaveLength(0);
  });

  test('the stratum is quintile crossed with slot', () => {
    const got = itemsForRow(row({ quintile: 4 }));
    expect(new Set(got.items.map((i) => i.stratum))).toEqual(new Set(['Q4/flashcards', 'Q4/concepts']));
  });
});

// ---------------------------------------------------------------------------
describe('nullLabelFor — the distractor', () => {
  const item = { key: '100:concepts:0', citedLabel: 2, candidateLabels: [1, 2, 3, 4] };

  test('never returns the cited note', () => {
    for (let cited = 1; cited <= 4; cited += 1) {
      for (let i = 0; i < 40; i += 1) {
        const it = { key: `k${i}`, citedLabel: cited, candidateLabels: [1, 2, 3, 4] };
        expect(nullLabelFor(it)).not.toBe(cited);
      }
    }
  });

  test('is deterministic for a given item and seed', () => {
    expect(nullLabelFor(item)).toBe(nullLabelFor(item));
  });

  test('depends on the ITEM, not on iteration order', () => {
    // A sequential PRNG would make the draw a function of how the loop ran, so
    // re-ordering the emission — which §32.8 requires — would redraw every
    // null. This is the property that makes the two independent.
    const first = nullLabelFor(item);
    for (let i = 0; i < 100; i += 1) nullLabelFor({ key: `noise${i}`, citedLabel: 1, candidateLabels: [1, 2] });
    expect(nullLabelFor(item)).toBe(first);
  });

  test('a different seed can draw differently', () => {
    const draws = new Set();
    for (let s = 0; s < 50; s += 1) draws.add(nullLabelFor(item, s));
    expect(draws.size).toBeGreaterThan(1);
  });

  test('a prompt with only the cited note has no distractor', () => {
    expect(nullLabelFor({ key: 'x', citedLabel: 1, candidateLabels: [1] })).toBeNull();
  });

  test('the draw spreads across the available notes rather than fixing on one', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      seen.add(nullLabelFor({ key: `spread${i}`, citedLabel: 1, candidateLabels: [1, 2, 3, 4, 5] }));
    }
    expect(seen).toEqual(new Set([2, 3, 4, 5]));
  });
});

// ---------------------------------------------------------------------------
describe('orderItems — a prefix must be a SAMPLE, not a corner', () => {
  function population() {
    // Deliberately unequal, like the real ten: 40 / 20 / 10.
    const items = [];
    for (const [stratum, n] of [['Q1/concepts', 40], ['Q2/concepts', 20], ['Q3/flashcards', 10]]) {
      for (let i = 0; i < n; i += 1) {
        items.push({ key: `${stratum}:${i}`, seedId: String(i), slot: 'concepts', itemIndex: i, stratum });
      }
    }
    return items;
  }

  test('every prefix holds each stratum near its population share', () => {
    const items = orderItems(population());
    const total = items.length;
    const share = new Map([['Q1/concepts', 40 / 70], ['Q2/concepts', 20 / 70], ['Q3/flashcards', 10 / 70]]);
    for (const n of [7, 14, 35, 70]) {
      const prefix = items.slice(0, n);
      for (const [stratum, want] of share) {
        const got = prefix.filter((i) => i.stratum === stratum).length / n;
        expect(Math.abs(got - want)).toBeLessThan(0.1);
      }
    }
  });

  test('ROUND-ROBIN WOULD FAIL THAT, which is why this is not round-robin', () => {
    // Equal-per-stratum makes a prefix over-represent the small strata. The
    // check below is what a round-robin prefix would look like at n = 9, and
    // the ordering above must NOT produce it.
    const items = orderItems(population());
    const prefix = items.slice(0, 9);
    const counts = ['Q1/concepts', 'Q2/concepts', 'Q3/flashcards'].map(
      (s) => prefix.filter((i) => i.stratum === s).length
    );
    expect(counts).not.toEqual([3, 3, 3]);
    expect(counts[0]).toBeGreaterThan(counts[2]);
  });

  test('every item appears exactly once', () => {
    const items = orderItems(population());
    expect(items).toHaveLength(70);
    expect(new Set(items.map((i) => i.key)).size).toBe(70);
  });

  test('human-sampled items sort first WITHIN their stratum', () => {
    const pop = population();
    const chosen = new Set([pop[30].key, pop[50].key]);
    const items = orderItems(pop, chosen);
    for (const key of chosen) {
      const stratum = items.find((i) => i.key === key).stratum;
      const inStratum = items.filter((i) => i.stratum === stratum);
      expect(inStratum[0].key === key || inStratum[1].key === key).toBe(true);
    }
  });

  test('is deterministic', () => {
    expect(orderItems(population()).map((i) => i.key)).toEqual(orderItems(population()).map((i) => i.key));
  });
});

// ---------------------------------------------------------------------------
describe('selectHumanSample', () => {
  function items(n = 322) {
    const strata = ['Q1/concepts', 'Q1/flashcards', 'Q2/concepts', 'Q5/flashcards'];
    return Array.from({ length: n }, (_, i) => ({
      key: `k${i}`, seedId: String(i), slot: 'concepts', itemIndex: i, stratum: strata[i % strata.length]
    }));
  }

  test('takes the asked-for counts', () => {
    const s = selectHumanSample(items());
    expect(s.cited).toHaveLength(50);
    expect(s.null).toHaveLength(10);
  });

  test('THE NULL ITEMS ARE DISJOINT FROM THE CITED ONES', () => {
    // A rater shown the same claim twice, once against each passage, has been
    // told the two are a pair — the provenance the blinding withholds, handed
    // over by the interface instead of by the prompt.
    const s = selectHumanSample(items());
    const overlap = s.null.filter((k) => s.cited.includes(k));
    expect(overlap).toEqual([]);
  });

  test('spreads across strata rather than taking a block', () => {
    const all = items();
    const byKey = new Map(all.map((i) => [i.key, i]));
    const s = selectHumanSample(all);
    const strata = new Set(s.cited.map((k) => byKey.get(k).stratum));
    expect(strata.size).toBe(4);
  });

  test('is deterministic for a given seed', () => {
    expect(selectHumanSample(items()).cited).toEqual(selectHumanSample(items()).cited);
  });

  test('never asks for more than exists', () => {
    const s = selectHumanSample(items(12));
    expect(s.cited).toHaveLength(12);
    expect(s.null).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('buildPairSet', () => {
  const rows = [row({ seedId: '1', quintile: 1 }), row({ seedId: '2', quintile: 5, labels: [1, 2, 3, 4] })];

  test('every item becomes exactly two pairs', () => {
    const b = buildPairSet(rows);
    expect(b.pairs).toHaveLength(b.items.length * 2);
  });

  test('an item\'s two conditions are emitted BACK TO BACK, cited first', () => {
    // A stop must never leave a cited verdict without its null, or the gap —
    // the only number in section B with information in it — stops being
    // computable on what landed.
    const b = buildPairSet(rows);
    for (let i = 0; i < b.pairs.length; i += 2) {
      expect(b.pairs[i].key).toBe(b.pairs[i + 1].key);
      expect(b.pairs[i].condition).toBe('cited');
      expect(b.pairs[i + 1].condition).toBe('null');
    }
  });

  test('the cited pair shows the cited note and the null pair does not', () => {
    const b = buildPairSet(rows);
    for (const p of b.pairs) {
      if (p.condition === 'cited') expect(p.passageLabel).toBe(p.citedLabel);
      else expect(p.passageLabel).not.toBe(p.citedLabel);
    }
  });

  test('pairIds are unique', () => {
    const b = buildPairSet(rows);
    expect(new Set(b.pairs.map((p) => p.pairId)).size).toBe(b.pairs.length);
  });

  test('rows that did not complete are ignored', () => {
    const b = buildPairSet([...rows, { seedId: '9', ok: false, error: {} }]);
    expect(b.pairs.every((p) => p.seedId !== '9')).toBe(true);
  });

  test('is byte-stable across builds', () => {
    expect(JSON.stringify(buildPairSet(rows).pairs)).toBe(JSON.stringify(buildPairSet(rows).pairs));
  });
});

// ---------------------------------------------------------------------------
describe('the committed pair set matches what the code builds', () => {
  const REPO = path.resolve(__dirname, '..', '..');
  const SET = path.join(REPO, 'results', 'gen-judge-set.jsonl');
  const GEN = path.join(REPO, 'results', 'gen-v5.calls.jsonl');

  const present = fs.existsSync(SET) && fs.existsSync(GEN);
  const maybe = present ? test : test.skip;

  maybe('results/gen-judge-set.jsonl regenerates byte-identically', () => {
    // THE PRE-REGISTRATION IS ONLY WORTH ANYTHING IF IT STILL REPRODUCES. A
    // committed set that no longer matches the code means either the seed or
    // the selection moved after the fact, which is exactly what committing it
    // before the run was meant to rule out.
    const rows = fs.readFileSync(GEN, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.ok);
    const built = buildPairSet(rows).pairs.map((p) => JSON.stringify(p)).join('\n') + '\n';
    expect(built).toBe(fs.readFileSync(SET, 'utf8'));
  });

  maybe('the human sample is 50 cited and 10 null, and they are disjoint', () => {
    const pairs = fs.readFileSync(SET, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const cited = pairs.filter((p) => p.humanLabelled && p.condition === 'cited');
    const nulls = pairs.filter((p) => p.humanLabelled && p.condition === 'null');
    expect(cited).toHaveLength(judge.HUMAN_CITED_N);
    expect(nulls).toHaveLength(judge.HUMAN_NULL_N);
    expect(cited.filter((c) => nulls.some((n) => n.key === c.key))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('hash32 and itemKey', () => {
  test('hash32 is stable and unsigned', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    expect(hash32('abc')).toBeGreaterThanOrEqual(0);
    expect(hash32('abc')).not.toBe(hash32('abd'));
  });

  test('itemKey is stable and separates slots', () => {
    expect(itemKey('7', 'concepts', 0)).toBe('7:concepts:0');
    expect(itemKey('7', 'flashcards', 0)).not.toBe(itemKey('7', 'concepts', 0));
  });

  test('NULL_SEED is fixed for the life of the phase', () => {
    // Changing it redraws every distractor and invalidates every collected
    // verdict. Pinned so the change cannot be quiet.
    expect(NULL_SEED).toBe(20260820);
  });
});
