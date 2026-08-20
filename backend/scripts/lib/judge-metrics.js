'use strict';

/**
 * judge-metrics.js — Phase 5.6. The pair set, the sampling, and the agreement
 * arithmetic.
 *
 * PURE. No network, no key, no database, nothing under data/. Everything here
 * runs in `npm test`, for studypack-metrics.js's stated reason: a rate computed
 * by an unrunnable predicate is unauditable, and an AGREEMENT figure computed by
 * one is worse, because Cohen's kappa has a well-known failure mode that a
 * wrong implementation reproduces convincingly.
 *
 * ---------------------------------------------------------------------------
 * THE PAIR SET IS A FUNCTION OF THE COMMITTED LEDGER AND A FIXED SEED
 * ---------------------------------------------------------------------------
 *
 * Nothing here reads data/. The 322 items come from results/gen-v5.calls.jsonl,
 * which carries the rendered text of every note that was sent (§32's decision
 * log: "the input, not derived data"), so both the claim and every candidate
 * passage are already committed. That is what makes the whole of 5.6 replayable
 * from results/ alone — §30.3's reason, which is that a check reading data/
 * passes in CI and fails in the local reproduction of CI.
 *
 * results/gen-judge-set.jsonl carries KEYS ONLY — no claim text, no passage
 * text — because both resolve from the ledger. §8.5's rule against committing
 * derived data twice, honoured rather than argued around: the set is the
 * PRE-REGISTRATION of what will be judged and which items a human labels, and
 * it is 644 rows of identifiers.
 *
 * ---------------------------------------------------------------------------
 * THE NULL: ONE OTHER NOTE FROM THE SAME PROMPT, DRAWN UNIFORMLY
 * ---------------------------------------------------------------------------
 *
 * §32.5's lexical null is the mean over ALL other notes in the same prompt. A
 * judged null has to pick ONE, and the choice is a design decision with three
 * candidates, none of them free:
 *
 *   uniform at random   what ships. It is the single-draw analogue of the mean
 *                       the lexical null already takes, so the two nulls are
 *                       estimating the same quantity.
 *   the lexical runner-up  REJECTED. A hardest-case distractor deflates the gap,
 *                       and it makes 5.4's support METRIC the selection RULE —
 *                       the exact move §30.5 refuses for citation assignment,
 *                       and linker.service.js:130-136 refuses for sharedKeywords.
 *   the lexical argmin  REJECTED, flattering for the mirror-image reason.
 *
 * THE DRAW IS KEYED ON THE ITEM, NOT ON ITERATION ORDER. A sequential PRNG
 * makes the null a function of how the loop happened to run, so re-ordering the
 * emission — which §32.8 requires — would silently redraw every null. Hashing
 * the item's own key with a fixed global seed gives the same distractor no
 * matter what order anything runs in, and a resumed run agrees with the one it
 * resumes.
 *
 * ---------------------------------------------------------------------------
 * EMISSION ORDER: PROPORTIONAL INTERLEAVE, SO A PREFIX IS A SAMPLE
 * ---------------------------------------------------------------------------
 *
 * §32.8 records that gen-v5 had NO mechanism protecting its stratification and
 * got a balanced partial set by luck. The lesson it draws is that the
 * protection has to be re-derived for whatever axis a new harness stratifies
 * on, never inherited as a habit. This harness stratifies on (quintile x slot),
 * ten strata of unequal size — 48 down to 18 — so plain round-robin is the
 * WRONG fix: it exhausts the small strata first and makes a prefix
 * equal-per-stratum, which over-represents Q5 relative to the population the
 * headline rate is about.
 *
 * So each item gets a fractional position (rank + 0.5) / stratum_size and the
 * whole set is sorted by it. Every prefix then holds each stratum in
 * proportion to its size, which is what makes a partial run a SAMPLE of the 322
 * rather than a corner of it.
 *
 * TWO FURTHER RULES ON TOP OF THAT ORDER:
 *   - an item's two conditions are emitted BACK TO BACK, so a stop never leaves
 *     a cited verdict without its null and the gap stays computable;
 *   - human-labelled items sort first WITHIN their stratum, so kappa — which
 *     needs only 50 of the 644 — becomes available early rather than last.
 */

const studyPackMetrics = require('./studypack-metrics');

/** Fixed for the life of the phase. Changing it redraws every null. */
const NULL_SEED = 20260820;

/** ROADMAP 5.6 asks for 50. The 10 nulls are this project's own null rule. */
const HUMAN_CITED_N = 50;
const HUMAN_NULL_N = 10;

const CONDITIONS = ['cited', 'null'];

/**
 * FNV-1a, 32-bit. A hash rather than a PRNG so a draw depends on the item and
 * the seed and on nothing else — see the header.
 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable key for one generated item. */
function itemKey(seedId, slot, itemIndex) {
  return `${seedId}:${slot}:${itemIndex}`;
}

/**
 * Every judgeable item in one completed gen-v5 ledger row.
 *
 * An item is judgeable when its citation resolves to a note that was in the
 * prompt. gen-v5 measured citation validity at 322 of 322, so nothing is
 * expected to be dropped here — but the count is returned rather than assumed,
 * because "the drop was zero" and "the code cannot drop" are different claims
 * and only one of them is checkable.
 */
function itemsForRow(row) {
  const notes = (row.context && row.context.notes) || [];
  const labels = new Map(notes.map((n) => [n.label, n]));
  const out = [];
  let unciteable = 0;

  const perSlot = new Map();
  for (const { slot, element } of studyPackMetrics.itemsOf(row.rawText)) {
    const itemIndex = perSlot.get(slot) || 0;
    perSlot.set(slot, itemIndex + 1);

    const { label, citation } = studyPackMetrics.resolveLabel(element, labels);
    if (citation !== 'valid') {
      unciteable += 1;
      continue;
    }
    const claim = studyPackMetrics.claimText(slot, element);
    if (!claim) {
      unciteable += 1;
      continue;
    }
    out.push({
      key: itemKey(row.seedId, slot, itemIndex),
      seedId: row.seedId,
      quintile: row.quintile,
      slot,
      itemIndex,
      citedLabel: label,
      stratum: `Q${row.quintile}/${slot}`,
      candidateLabels: notes.map((n) => n.label)
    });
  }
  return { items: out, unciteable };
}

/** The distractor for one item: a note from the same prompt it did not cite. */
function nullLabelFor(item, seed = NULL_SEED) {
  const others = item.candidateLabels.filter((l) => l !== item.citedLabel);
  if (others.length === 0) return null;
  return others[hash32(`${seed}|${item.key}`) % others.length];
}

/**
 * Order the items so that ANY PREFIX is a proportional sample of the whole.
 *
 * `humanKeys` sort first inside their stratum; everything else keeps a stable
 * deterministic order. See the header for why this is not round-robin.
 */
function orderItems(items, humanKeys = new Set()) {
  const byStratum = new Map();
  for (const it of items) {
    if (!byStratum.has(it.stratum)) byStratum.set(it.stratum, []);
    byStratum.get(it.stratum).push(it);
  }

  const positioned = [];
  for (const [stratum, group] of [...byStratum.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...group].sort((a, b) => {
      const ha = humanKeys.has(a.key) ? 0 : 1;
      const hb = humanKeys.has(b.key) ? 0 : 1;
      if (ha !== hb) return ha - hb;
      if (a.seedId !== b.seedId) return String(a.seedId) < String(b.seedId) ? -1 : 1;
      if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
      return a.itemIndex - b.itemIndex;
    });
    sorted.forEach((it, rank) => {
      positioned.push({ ...it, position: (rank + 0.5) / sorted.length, stratum });
    });
  }

  return positioned.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.stratum < b.stratum ? -1 : 1;
  });
}

/**
 * Proportional allocation over strata by LARGEST REMAINDER, so the counts sum
 * to exactly `total` without a rounding drift that quietly shortens the sample.
 */
function allocate(strata, total) {
  const sizes = [...strata.entries()];
  const grand = sizes.reduce((a, [, n]) => a + n, 0);
  if (grand === 0) return new Map();

  const exact = sizes.map(([name, n]) => [name, (n / grand) * total]);
  const floors = exact.map(([name, x]) => [name, Math.floor(x)]);
  let used = floors.reduce((a, [, n]) => a + n, 0);

  const order = exact
    .map(([name, x], i) => ({ name, i, rem: x - Math.floor(x) }))
    .sort((a, b) => (b.rem - a.rem) || (a.name < b.name ? -1 : 1));

  for (const o of order) {
    if (used >= total) break;
    const cap = strata.get(o.name);
    if (floors[o.i][1] < cap) {
      floors[o.i][1] += 1;
      used += 1;
    }
  }
  return new Map(floors);
}

/**
 * Choose which items a human labels.
 *
 * THE NULL PAIRS COME FROM ITEMS THE HUMAN DOES NOT SEE IN THE CITED CONDITION,
 * and that is not tidiness. A rater shown the same claim twice, once against
 * each passage, has been told the two are a pair — which is precisely the
 * provenance the blinding exists to withhold, handed over by the interface
 * instead of by the prompt. So the 10 null items are drawn from the complement
 * of the 50, and in the labelling tool the 60 are shuffled together.
 */
function selectHumanSample(items, { citedN = HUMAN_CITED_N, nullN = HUMAN_NULL_N, seed = NULL_SEED } = {}) {
  const strata = new Map();
  for (const it of items) strata.set(it.stratum, (strata.get(it.stratum) || 0) + 1);

  const pick = (pool, quota) => {
    const chosen = [];
    const byStratum = new Map();
    for (const it of pool) {
      if (!byStratum.has(it.stratum)) byStratum.set(it.stratum, []);
      byStratum.get(it.stratum).push(it);
    }
    const available = new Map([...byStratum.entries()].map(([s, g]) => [s, g.length]));
    const alloc = allocate(available, quota);
    for (const [stratum, n] of [...alloc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const group = [...(byStratum.get(stratum) || [])]
        .sort((a, b) => hash32(`${seed}|pick|${a.key}`) - hash32(`${seed}|pick|${b.key}`));
      chosen.push(...group.slice(0, n));
    }
    return chosen;
  };

  const cited = pick(items, Math.min(citedN, items.length));
  const citedKeys = new Set(cited.map((it) => it.key));
  const rest = items.filter((it) => !citedKeys.has(it.key));
  const nulls = pick(rest, Math.min(nullN, rest.length));

  return {
    cited: cited.map((it) => it.key),
    null: nulls.map((it) => it.key),
    strata
  };
}

/**
 * The full pair set, in emission order.
 *
 * @param {Array} rows  ok rows from results/gen-v5.calls.jsonl
 * @returns {{pairs:Array, items:Array, human:Object, unciteable:number}}
 */
function buildPairSet(rows, options = {}) {
  const seed = options.seed === undefined ? NULL_SEED : options.seed;
  let unciteable = 0;
  let items = [];
  for (const row of rows) {
    if (!row || row.ok !== true) continue;
    const got = itemsForRow(row);
    unciteable += got.unciteable;
    items = items.concat(got.items);
  }

  const human = selectHumanSample(items, { ...options, seed });
  const humanKeys = new Set([...human.cited, ...human.null]);
  const ordered = orderItems(items, humanKeys);

  const pairs = [];
  for (const it of ordered) {
    const nullLabel = nullLabelFor(it, seed);
    for (const condition of CONDITIONS) {
      if (condition === 'null' && nullLabel === null) continue;
      pairs.push({
        pairId: `${it.key}:${condition}`,
        key: it.key,
        seedId: it.seedId,
        quintile: it.quintile,
        slot: it.slot,
        itemIndex: it.itemIndex,
        stratum: it.stratum,
        condition,
        passageLabel: condition === 'cited' ? it.citedLabel : nullLabel,
        citedLabel: it.citedLabel,
        humanLabelled:
          (condition === 'cited' && human.cited.includes(it.key)) ||
          (condition === 'null' && human.null.includes(it.key))
      });
    }
  }
  return { pairs, items: ordered, human, unciteable };
}

/**
 * Cohen's kappa for two raters over a fixed category list.
 *
 * REPORTED WITH P_o, P_e AND THE MATRIX, NEVER ALONE. Kappa collapses toward 0
 * when both raters put nearly everything in one category, however often they
 * agree — the "kappa paradox". If this project's own prediction is right and
 * most items score 0, that is exactly the regime, so a bare kappa would
 * understate agreement and a reader could not tell. CLAUDE.md's claim discipline
 * forbids a groundedness score without the agreement number beside it; the same
 * argument one level down forbids an agreement number without P_o beside it.
 *
 * `kappa` is null when P_e is 1 — both raters used one category for everything,
 * so chance agreement is total and the statistic is undefined rather than 0.
 */
function cohensKappa(pairsOfLabels, categories) {
  const cats = [...categories];
  const index = new Map(cats.map((c, i) => [String(c), i]));
  const matrix = cats.map(() => cats.map(() => 0));

  let n = 0;
  for (const [a, b] of pairsOfLabels) {
    const ia = index.get(String(a));
    const ib = index.get(String(b));
    if (ia === undefined || ib === undefined) continue;
    matrix[ia][ib] += 1;
    n += 1;
  }
  if (n === 0) return { kappa: null, po: null, pe: null, n: 0, matrix, rowMarginals: [], colMarginals: [], categories: cats };

  const rowMarginals = matrix.map((r) => r.reduce((x, y) => x + y, 0));
  const colMarginals = cats.map((_, j) => matrix.reduce((a, r) => a + r[j], 0));

  const agree = cats.reduce((a, _, i) => a + matrix[i][i], 0);
  const po = agree / n;
  const pe = cats.reduce((a, _, i) => a + (rowMarginals[i] / n) * (colMarginals[i] / n), 0);
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);

  return { kappa, po, pe, n, matrix, rowMarginals, colMarginals, categories: cats };
}

/** Share of `values` equal to `target`, with its denominator. null when n = 0. */
function rateOf(values, target) {
  const scorable = values.filter((v) => v !== null && v !== undefined);
  if (scorable.length === 0) return { rate: null, hits: 0, n: 0 };
  const hits = scorable.filter((v) => v === target).length;
  return { rate: hits / scorable.length, hits, n: scorable.length };
}

module.exports = {
  NULL_SEED,
  HUMAN_CITED_N,
  HUMAN_NULL_N,
  CONDITIONS,
  hash32,
  itemKey,
  itemsForRow,
  nullLabelFor,
  orderItems,
  allocate,
  selectHumanSample,
  buildPairSet,
  cohensKappa,
  rateOf
};
