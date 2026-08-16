'use strict';

/**
 * check-blocks.test.js — Phase 3.7
 *
 * `check:blocks` is a tool whose whole value is that it fails when a document
 * goes stale. A tool like that has one characteristic failure mode: it passes
 * because it sees nothing. So the tests below are mostly about what the
 * extractors DO see, and each positive case is paired with the near-miss that
 * must NOT be collected — the same shape as check-claims.test.js.
 */

const fs = require('fs');
const path = require('path');

const { npmScriptsIn, pathsIn } = require('../scripts/check-blocks');

describe('npmScriptsIn', () => {
  test('finds a plain and a colonised script name', () => {
    const got = npmScriptsIn('run `npm run test` then `npm run analyse:errors`').map((x) => x.script);
    expect(got).toEqual(['test', 'analyse:errors']);
  });

  test('finds them inside a fenced block, which is where they usually live', () => {
    const text = '```bash\ncd backend && npm run eval -- --split dev\n```';
    expect(npmScriptsIn(text).map((x) => x.script)).toEqual(['eval']);
  });

  test('stops at the flag separator rather than swallowing arguments', () => {
    expect(npmScriptsIn('npm run check:claims -- --verbose').map((x) => x.script))
      .toEqual(['check:claims']);
  });

  test('multi-segment names survive whole', () => {
    expect(npmScriptsIn('npm run a:b:c').map((x) => x.script)).toEqual(['a:b:c']);
  });

  describe('hyphenated names, which produced a false positive at 4.1', () => {
    // Every script name up to 3.7 was `word` or `word:word`, so the character
    // class excluded `-` and nothing revealed it. 4.1 added `price:v5-app`; the
    // name truncated at the hyphen and the tool reported
    // `npm run price:v5 — no such script` against a command that runs fine.
    // A false positive dressed as a staleness finding is worse than no check,
    // because it is the kind that teaches people to skim the report.

    test('a hyphen inside a name is part of the name', () => {
      expect(npmScriptsIn('npm run price:v5-app').map((x) => x.script)).toEqual(['price:v5-app']);
      expect(npmScriptsIn('npm run build-corpus').map((x) => x.script)).toEqual(['build-corpus']);
    });

    test('a hyphenated name still stops at the flag separator', () => {
      // The regression the fix could plausibly introduce: `--` is hyphens, so a
      // greedier class could swallow it and invent a script nobody named.
      expect(npmScriptsIn('npm run price:v5-app -- --n 500').map((x) => x.script))
        .toEqual(['price:v5-app']);
      expect(npmScriptsIn('npm run analyse:app --verbose').map((x) => x.script))
        .toEqual(['analyse:app']);
    });

    test('a name cannot end on a hyphen or a colon', () => {
      expect(npmScriptsIn('npm run eval- x').map((x) => x.script)).toEqual(['eval']);
      expect(npmScriptsIn('npm run eval: x').map((x) => x.script)).toEqual(['eval']);
    });

    test('every script this repo actually has is captured whole', () => {
      // The check that would have caught the original bug, and it is cheap:
      // read the manifest rather than listing names in a test that goes stale.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
      );
      for (const name of Object.keys(manifest.scripts)) {
        expect(npmScriptsIn(`npm run ${name}`).map((x) => x.script)).toEqual([name]);
      }
    });
  });

  test('reports an offset, so a failure can name a line', () => {
    const [hit] = npmScriptsIn('xxxx npm run test');
    expect(hit.index).toBe(5);
  });
});

describe('pathsIn', () => {
  const tokens = (text) => pathsIn(text).map((x) => x.token);

  test('collects a backticked repo-relative path', () => {
    expect(tokens('see `backend/eval/metrics.js` for it')).toEqual(['backend/eval/metrics.js']);
  });

  test('collects bare tokens inside a fence — 3.5\'s stale directory listing', () => {
    const text = '```\nbackend/\n  retrieval/index.js\n  eval/metrics.js\n```';
    expect(tokens(text)).toEqual(['retrieval/index.js', 'eval/metrics.js']);
  });

  test('does NOT collect an unbackticked path from running prose', () => {
    // These documents write ordinary sentences. Matching prose would bury the
    // real findings under punctuation, and a noisy check gets switched off.
    expect(tokens('the file backend/eval/metrics.js is fine')).toEqual([]);
  });

  test('strips trailing sentence punctuation but keeps the path', () => {
    expect(tokens('see `backend/eval/metrics.js`.')).toEqual(['backend/eval/metrics.js']);
    expect(tokens('`results/holm-family.txt`,')).toEqual(['results/holm-family.txt']);
  });

  test('requires a slash, so a bare filename is never looked up', () => {
    // Without this, `index.js` would resolve against several ROOTS at once and
    // the check would assert almost nothing while appearing to work.
    expect(tokens('`metrics.js` and `package.json`')).toEqual([]);
  });

  test('requires a known extension, so prose in backticks is not a path', () => {
    expect(tokens('`a/b` and `top-8` and `k1/b`')).toEqual([]);
  });

  test('skips placeholder templates rather than looking them up', () => {
    expect(tokens('`data/corpus/<site>.jsonl`')).toEqual([]);
    expect(tokens('`data/splits/cooking.{train,dev,test}.txt`')).toEqual([]);
    expect(tokens('`results/runs/*.run`')).toEqual([]);
  });

  test('skips URLs and scoped package names', () => {
    expect(tokens('`https://example.com/a/b.json`')).toEqual([]);
    expect(tokens('`@anthropic-ai/sdk/index.js`')).toEqual([]);
  });

  test('skips absolute paths, which are not repo-relative claims', () => {
    expect(tokens('`/etc/hosts.txt`')).toEqual([]);
  });

  test('normalises a leading ./', () => {
    expect(tokens('`./backend/eval/metrics.js`')).toEqual(['backend/eval/metrics.js']);
  });

  test('a fence and a backtick both contribute, and offsets stay in range', () => {
    const text = 'prose `a/b.js` more\n```\nc/d.js\n```';
    const hits = pathsIn(text);
    expect(hits.map((h) => h.token).sort()).toEqual(['a/b.js', 'c/d.js']);
    for (const h of hits) expect(text.slice(h.index)).toContain(h.token.split('/').pop());
  });
});

describe('rule 3 — reverse coverage (4.3)', () => {
  const { expandBraces, COVERED_ROOTS, UNDOCUMENTED } = require('../scripts/check-blocks');
  const REPO = path.resolve(__dirname, '..', '..');

  describe('expandBraces, which exists because rule 3 was WRONG on its first run', () => {
    // It reported results/contamination-linkdate.test.txt as named by nothing.
    // §19.6 names it, as `results/contamination-linkdate.{dev,test}.txt` — a
    // convention this repo uses in at least four places, and one rule 2 already
    // skips as a PLACEHOLDER. A literal substring search could not see through
    // it. This is the 4.1 hyphen bug's family: a false positive dressed as a
    // real finding, and the cheap fix — rewriting the document to satisfy the
    // tool — was refused for the same reason.
    test('the case that actually bit', () => {
      const got = expandBraces('`results/contamination-linkdate.{dev,test}.txt`');
      expect(got).toContain('results/contamination-linkdate.test.txt');
      expect(got).toContain('results/contamination-linkdate.dev.txt');
    });

    test('three alternatives, and a group in the middle of a path', () => {
      const got = expandBraces('`data/splits/{train,dev,test}.ids`').split('\n');
      expect(got).toEqual(['data/splits/train.ids', 'data/splits/dev.ids', 'data/splits/test.ids']);
    });

    test('a group with a directory suffix after it', () => {
      expect(expandBraces('`results/parity/v1-{shipped,harness}.txt`').split('\n'))
        .toEqual(['results/parity/v1-shipped.txt', 'results/parity/v1-harness.txt']);
    });

    test('text with no braces expands to nothing rather than to itself', () => {
      // If it echoed the input, every file would appear "named" by any document
      // that mentions anything, and the rule would silently stop failing.
      expect(expandBraces('results/write-cost.txt')).toBe('');
    });

    test('it does not invent a match for a file no brace form covers', () => {
      const got = expandBraces('`results/contamination-linkdate.{dev,test}.txt`');
      expect(got).not.toContain('results/contamination-linkdate.train.txt');
    });
  });

  describe('the roots it scans', () => {
    test('every covered root exists, so the rule is not vacuous', () => {
      // A root that had moved would make this rule check nothing while still
      // printing PASS — the "too weak to fail" shape §22.6 names.
      expect(COVERED_ROOTS.length).toBeGreaterThan(0);
      for (const root of COVERED_ROOTS) {
        expect(fs.existsSync(path.join(REPO, root.dir))).toBe(true);
      }
    });

    test('each root actually contains files matching its extension', () => {
      for (const root of COVERED_ROOTS) {
        const names = fs.readdirSync(path.join(REPO, root.dir), { withFileTypes: true })
          .filter((e) => e.isFile() && root.ext.test(e.name));
        expect(names.length).toBeGreaterThan(0);
      }
    });

    test('the exemption list is not a junk drawer — every entry carries a reason', () => {
      for (const [rel, why] of UNDOCUMENTED) {
        expect(typeof why).toBe('string');
        expect(why.length).toBeGreaterThan(20);
        expect(fs.existsSync(path.join(REPO, rel))).toBe(true);
      }
    });
  });
});
