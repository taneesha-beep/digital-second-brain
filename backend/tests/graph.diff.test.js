'use strict';

/**
 * graph.diff.test.js — Phase 4.4
 *
 * THE PREDICATE THAT DECIDES WHETHER 4.4's DONE CRITERION IS MET, TESTED FOR
 * ITS ABILITY TO SAY NO.
 *
 * `explainDiff()` answers roadmap 4.4's escape hatch — *"or the diff fully
 * explained by the DF cutoff"*. A predicate that returns `explained: true` for
 * everything would satisfy that clause on any rewrite whatsoever, which is
 * §22.6's "checks too weak to fail" in the one place it would matter most. So
 * almost every test below asserts a REJECTION, and each names the clause it is
 * exercising.
 *
 * The element pairs come from the real `buildGlobalGraph` over a small
 * `FakeNoteStore` corpus, then are mutated. Using the builder as a fixture
 * generator is not the §7.5 problem: nothing here compares two implementations,
 * the builder's output is only a source of correctly-shaped input, and every
 * assertion is about what the predicate does to a deliberately corrupted copy.
 */

jest.mock('../models/Note', () => require('../scripts/lib/fake-note-store').FakeNote);

const { FakeNoteStore, setStore } = require('../scripts/lib/fake-note-store');
const { buildGlobalGraph } = require('../services/graphBuilder.service');
const { explainDiff, derive, normList } = require('../scripts/lib/graph-diff');

const USER = 'u';

/**
 * Four notes over a vocabulary chosen so that at maxDf = 3 exactly one term is
 * cut and one is not:
 *
 *   stock   4 notes  -> CUT at maxDf 3, C(4,2) = 6 cross-links
 *   roux    3 notes  -> admitted,       C(3,2) = 3
 *   sear    2 notes  -> admitted,       C(2,2) = 1
 *   whisk   1 note   -> emits nothing
 */
const NOTES = [
  { _id: 'n1', user: USER, title: 'One', keywords: ['stock', 'roux', 'whisk'] },
  { _id: 'n2', user: USER, title: 'Two', keywords: ['stock', 'roux', 'sear'] },
  { _id: 'n3', user: USER, title: 'Three', keywords: ['stock', 'roux'] },
  { _id: 'n4', user: USER, title: 'Four', keywords: ['stock', 'sear'] },
];
const IDS = NOTES.map((n) => n._id);
const SPEC = NOTES.map((n) => ({ id: n._id, keywords: n.keywords }));
const MAX_DF = 3;

const clone = (x) => JSON.parse(JSON.stringify(x));

let before;
let after;

beforeAll(async () => {
  setStore(new FakeNoteStore(NOTES, IDS));
  before = (await buildGlobalGraph(USER, { maxDf: Infinity })).elements;
  after = (await buildGlobalGraph(USER, { maxDf: MAX_DF })).elements;
});

const check = (b, a) => explainDiff(b, a, { maxDf: MAX_DF, notes: SPEC });

describe('the fixture is what the tests assume', () => {
  test('derive() sees one cut term and the arithmetic that follows from it', () => {
    const d = derive(SPEC, MAX_DF);
    expect(d.df.get('stock')).toBe(4);
    expect(d.df.get('roux')).toBe(3);
    expect([...d.cut]).toEqual(['stock']);
    expect(d.expectedRemoved).toBe(6); // C(4,2)
  });

  test('the cutoff actually removes something, so a PASS below is not vacuous', () => {
    expect(before.length).toBeGreaterThan(after.length);
    expect(before.length - after.length).toBe(6);
  });

  test('normList is the same admission rule the builder uses', () => {
    expect(normList([' a ', '', 3, 'b'])).toEqual(['a', 'b']);
    expect(normList('nope')).toEqual([]);
  });
});

describe('it accepts what the rule permits', () => {
  test('a real cutoff diff is fully explained', () => {
    const v = check(before, after);
    expect(v.violations).toEqual([]);
    expect(v.explained).toBe(true);
    expect(v.counts.removed).toBe(6);
    expect(v.counts.expectedRemoved).toBe(6);
  });

  test('an identical pair is explained, with nothing removed', () => {
    const v = explainDiff(before, clone(before), { maxDf: Infinity, notes: SPEC });
    expect(v.explained).toBe(true);
    expect(v.counts.removed).toBe(0);
  });

  test('`shared` flips only on the cut term, and `size` only downward', () => {
    const v = check(before, after);
    expect(v.counts.sharedFlipped).toBe(4); // one keyword node per note carrying `stock`
    const sizes = new Map(before.filter((e) => e.data.type === 'note').map((e) => [e.data.id, e.data.size]));
    for (const el of after.filter((e) => e.data.type === 'note')) {
      expect(el.data.size).toBeLessThanOrEqual(sizes.get(el.data.id));
    }
  });
});

describe('it rejects what the rule forbids — clause by clause', () => {
  test('clause 1: an added element', () => {
    const bad = clone(after);
    bad.push({ data: { id: 'invented', type: 'cross-link', sharedKeyword: 'roux' }, classes: 'cross-edge' });
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/ADDED 1 element/);
  });

  test('clause 2: a removed note node', () => {
    const bad = clone(after).filter((e) => e.data.id !== 'n3');
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/REMOVED a note element: n3/);
  });

  test('clause 2: a removed keyword node', () => {
    const bad = clone(after).filter((e) => e.data.id !== 'kw_n1_whisk');
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/REMOVED a keyword element/);
  });

  test('clause 3: a cross-link removed on an ADMITTED term', () => {
    const victim = after.find((e) => e.data.type === 'cross-link' && e.data.sharedKeyword === 'roux');
    const bad = clone(after).filter((e) => e.data.id !== victim.data.id);
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/NOT above maxDf/);
  });

  test('clause 3: a PARTIAL cut — one cross-link of the cut term survives', () => {
    const survivor = before.find((e) => e.data.type === 'cross-link' && e.data.sharedKeyword === 'stock');
    const bad = clone(after);
    bad.push(clone(survivor));
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    const text = v.violations.join('\n');
    expect(text).toMatch(/PARTIAL cut on "stock": removed 5 of 6/);
    expect(text).toMatch(/SURVIVING cross-link on cut term "stock"/);
  });

  test('clause 4: `shared` flipped on a keyword node whose term was NOT cut', () => {
    const bad = clone(after);
    const node = bad.find((e) => e.data.id === 'kw_n1_roux');
    node.data.shared = false;
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/kw_n1_roux: field shared changed true -> false/);
  });

  test('clause 4: a note `size` that INCREASED', () => {
    const bad = clone(after);
    bad.find((e) => e.data.id === 'n1').data.size = 999;
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/n1: field size changed/);
  });

  test('clause 4: a note `size` that decreased to the WRONG value', () => {
    const bad = clone(after);
    const node = bad.find((e) => e.data.id === 'n1');
    node.data.size = node.data.size - 6; // plausible, and not what the degree implies
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/n1: field size changed/);
  });

  test('clause 4: a `classes` string that lost something OTHER than shared-kw', () => {
    const bad = clone(after);
    bad.find((e) => e.data.id === 'n1').classes = 'not-a-note-node';
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/n1: classes changed/);
  });

  test('clause 5: any other field moving', () => {
    const bad = clone(after);
    bad.find((e) => e.data.id === 'n2').data.label = 'renamed';
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/n2: field label changed/);
  });

  test('clause 5: surviving elements reordered', () => {
    const bad = clone(after);
    const i = bad.findIndex((e) => e.data.id === 'kw_n1_roux');
    const j = bad.findIndex((e) => e.data.id === 'kw_n1_whisk');
    [bad[i], bad[j]] = [bad[j], bad[i]];
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    expect(v.violations.join('\n')).toMatch(/ORDER changed at surviving index/);
  });

  test('clause 6: the independent count fires on an over-cut', () => {
    // Every `stock` cross-link removed (legitimate) plus one `sear` cross-link
    // (not) — 7 removed against the 6 the df table predicts.
    const extra = after.find((e) => e.data.type === 'cross-link' && e.data.sharedKeyword === 'sear');
    const bad = clone(after).filter((e) => e.data.id !== extra.data.id);
    const v = check(before, bad);
    expect(v.explained).toBe(false);
    const text = v.violations.join('\n');
    expect(text).toMatch(/COUNT mismatch: 7 element\(s\) removed[\s\S]*says 6/);

    // AND IT IS NOT THE ONLY CLAUSE THAT FIRES HERE, which is worth asserting
    // rather than glossing: clause 3 catches the same removal by a different
    // route. Clause 6 is DELIBERATELY REDUNDANT — given clauses 2 and 3 hold,
    // the total is forced, so there is no diff only clause 6 can catch. Its
    // value is that its expected value comes from the df table rather than from
    // the diff, so it is the one check that still fails if clauses 2-3 are
    // themselves wrong. Recorded here so a later reader does not delete it as
    // dead weight.
    expect(text).toMatch(/NOT above maxDf/);
  });
});

describe('the maxDf boundary is inclusive, and off-by-one would be invisible without this', () => {
  test('a term with df exactly maxDf is ADMITTED', () => {
    // `roux` has df 3 and maxDf is 3. If the builder used `<` instead of `<=`
    // its cross-links would vanish and the predicate would report a partial cut
    // on a term it does not consider cut.
    const d = derive(SPEC, 3);
    expect(d.cut.has('roux')).toBe(false);
    expect(after.some((e) => e.data.type === 'cross-link' && e.data.sharedKeyword === 'roux')).toBe(true);
  });

  test('lowering maxDf by one cuts it, and that diff is also explained', async () => {
    setStore(new FakeNoteStore(NOTES, IDS));
    const tighter = (await buildGlobalGraph(USER, { maxDf: 2 })).elements;
    const v = explainDiff(before, tighter, { maxDf: 2, notes: SPEC });
    expect(v.explained).toBe(true);
    expect(v.counts.expectedRemoved).toBe(6 + 3); // stock C(4,2) + roux C(3,2)
    expect(v.counts.removed).toBe(9);
  });
});
