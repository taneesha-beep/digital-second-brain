'use strict';

/**
 * run-io.test.js — Phase 3.7
 *
 * The TREC loaders were duplicated five ways until this session and are now two
 * by design (scripts/lib/run-io.js explains which two and why). Consolidating a
 * parser that sits under every number in the project is only safe if the
 * behaviour is pinned somewhere, so this pins it.
 *
 * WHAT THESE TESTS ARE FOR, AND WHAT THEY ARE NOT. The load-bearing proof of the
 * refactor is not here — it is that `npm run eval` regenerated
 * v1-overlap.dev.run and v5-embeddings.dev.run and both reproduced the
 * `output.sha256` recorded in their COMMITTED sidecars, byte for byte. That is
 * an end-to-end equality on real data and no unit test can better it.
 *
 * These exist for the copy that could NOT be re-run: sweep-v1.js's outputs are
 * 2.7's committed sweep, 342 configurations, and re-running it to prove a
 * parser swap would rewrite published artifacts to demonstrate that they do not
 * change. So its parse is pinned by construction instead — the properties below
 * are the ones a sweep depends on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readLines, loadQrels, loadQrelsStrict, loadRun, retrievalSha256 } = require('../scripts/lib/run-io');

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-io-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const write = (name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

describe('readLines', () => {
  test('strips ONE trailing newline and keeps interior blanks', () => {
    expect(readLines(write('a.txt', 'x\ny\n'))).toEqual(['x', 'y']);
    expect(readLines(write('b.txt', 'x\n\ny\n'))).toEqual(['x', '', 'y']);
  });

  test('an empty file is zero lines, not one empty line', () => {
    expect(readLines(write('c.txt', ''))).toEqual([]);
    expect(readLines(write('d.txt', '\n'))).toEqual([]);
  });

  test('a file with no trailing newline keeps its last line', () => {
    expect(readLines(write('e.txt', 'x\ny'))).toEqual(['x', 'y']);
  });
});

describe('loadQrels', () => {
  test('groups by qid and parses grades as integers', () => {
    const f = write('q.qrels', '15652 0 5400 1\n15652 0 8871 2\n99 0 1 1\n');
    const byQuery = loadQrels(f);
    expect(byQuery.size).toBe(2);
    expect(byQuery.get('15652').get('5400')).toBe(1);
    expect(byQuery.get('15652').get('8871')).toBe(2);
    expect(byQuery.get('99').get('1')).toBe(1);
  });

  test('ids stay STRINGS on both sides of the join', () => {
    // CLAUDE.md names qrels/corpus id mismatch as a diagnosis for sub-0.05
    // nDCG, and `1 !== "1"` is how that happens. §2's record schema keeps
    // corpus ids as strings for exactly this reason.
    const byQuery = loadQrels(write('s.qrels', '7 0 42 1\n'));
    expect([...byQuery.keys()]).toEqual(['7']);
    expect([...byQuery.get('7').keys()]).toEqual(['42']);
    expect(byQuery.get('7').has(42)).toBe(false);
  });

  test('loadQrelsStrict additionally reports the judgment count', () => {
    const { byQuery, judgments } = loadQrelsStrict(write('t.qrels', '1 0 2 1\n1 0 3 2\n4 0 5 1\n'));
    expect(judgments).toBe(3);
    expect(byQuery.size).toBe(2);
  });

  test('loadQrels is loadQrelsStrict — the permissive parse no longer exists', () => {
    // The merge kept the STRICT copy on purpose. Making every caller validate
    // is the safe direction; making the runner permissive was the unsafe one.
    const bad = write('u.qrels', '1 0 2\n');
    expect(() => loadQrels(bad)).toThrow(/3 fields, expected 4/);
    expect(() => loadQrelsStrict(bad)).toThrow(/3 fields, expected 4/);
  });

  describe('the four validations, each mutation-checked against a passing file', () => {
    const good = '1 0 2 1\n1 0 3 2\n';

    test('the good file loads', () => {
      expect(loadQrelsStrict(write('v.qrels', good)).judgments).toBe(2);
    });

    test('rejects a wrong field count', () => {
      expect(() => loadQrelsStrict(write('w.qrels', '1 0 2 1 extra\n')))
        .toThrow(/5 fields, expected 4/);
    });

    test('rejects a non-zero iteration field', () => {
      expect(() => loadQrelsStrict(write('x.qrels', '1 1 2 1\n')))
        .toThrow(/field 2 is "1", expected the vestigial 0/);
    });

    test('rejects a non-integer grade', () => {
      expect(() => loadQrelsStrict(write('y.qrels', '1 0 2 1.5\n')))
        .toThrow(/grade "1.5" is not an integer/);
    });

    test('rejects a DUPLICATE judgment, which is the one that silently deflates nDCG', () => {
      // The 1.3 bug that produced 18,284 instead of 16,678: a pair kept twice
      // enters the ideal ranking twice, inflating IDCG. Nothing else in the
      // pipeline notices, which is why it is a throw and not a warning.
      expect(() => loadQrelsStrict(write('z.qrels', '1 0 2 1\n1 0 2 1\n')))
        .toThrow(/duplicate judgment for \(1, 2\)/);
    });

    test('the same docid under a DIFFERENT qid is not a duplicate', () => {
      expect(loadQrelsStrict(write('z2.qrels', '1 0 2 1\n9 0 2 1\n')).judgments).toBe(2);
    });
  });
});

describe('loadRun', () => {
  test('orders by the RANK COLUMN, not by file order', () => {
    // A run file is an artifact a reader may hand to another tool, and rank is
    // what a TREC run file means. The writer emits them in order and nothing
    // has ever emitted them otherwise — which is exactly why a parser that
    // silently trusted file order would never be caught.
    const f = write('r.run', [
      '1 Q0 c 3 0.1 lbl',
      '1 Q0 a 1 0.9 lbl',
      '1 Q0 b 2 0.5 lbl'
    ].join('\n') + '\n');
    expect(loadRun(f).get('1')).toEqual(['a', 'b', 'c']);
  });

  test('ranks are numeric, so 10 sorts after 9 rather than before 2', () => {
    const rows = [];
    for (let r = 1; r <= 10; r += 1) rows.push(`1 Q0 d${r} ${r} 0.5 lbl`);
    // Shuffle deterministically into an order a string sort would get wrong.
    const shuffled = [rows[9], rows[1], rows[0], ...rows.slice(2, 9)];
    const got = loadRun(write('r2.run', shuffled.join('\n') + '\n')).get('1');
    expect(got).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10']);
  });

  test('separates queries and tolerates a blank line', () => {
    const f = write('r3.run', '1 Q0 a 1 0.9 lbl\n\n2 Q0 b 1 0.8 lbl\n');
    const run = loadRun(f);
    expect(run.size).toBe(2);
    expect(run.get('2')).toEqual(['b']);
  });

  test('a query absent from the run file is absent from the map, not empty', () => {
    // §8.3: "the retriever returned nothing" and "the query was never run" are
    // two different facts. The caller decides; the parser must not flatten them.
    const run = loadRun(write('r4.run', '1 Q0 a 1 0.9 lbl\n'));
    expect(run.has('2')).toBe(false);
    expect(run.get('2')).toBeUndefined();
  });
});

describe('retrievalSha256', () => {
  test('hashes the retrieval columns only, so the runid does not move it', () => {
    const a = write('h1.run', '1 Q0 a 1 0.9 label-one\n');
    const b = write('h2.run', '1 Q0 a 1 0.9 label-two\n');
    expect(retrievalSha256(a)).toBe(retrievalSha256(b));
  });

  test('but a changed SCORE does move it', () => {
    const a = write('h3.run', '1 Q0 a 1 0.9 lbl\n');
    const b = write('h4.run', '1 Q0 a 1 0.8 lbl\n');
    expect(retrievalSha256(a)).not.toBe(retrievalSha256(b));
  });
});

describe('the real cooking key, if it is present', () => {
  // Skipped rather than failed when data/ is absent: data/qrels/ is gitignored
  // for size, so a fresh clone has no key until `npm run qrels:build` runs.
  const qrelsFile = path.join(__dirname, '..', '..', 'data', 'qrels', 'cooking.qrels');
  const maybe = fs.existsSync(qrelsFile) ? test : test.skip;

  maybe('parses to §3.3\'s committed shape — 16,678 judgments over 9,218 queries', () => {
    const { byQuery, judgments } = loadQrelsStrict(qrelsFile);
    expect(judgments).toBe(16678);
    expect(byQuery.size).toBe(9218);
  });
});
