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
