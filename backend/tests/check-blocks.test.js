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

const { execFileSync } = require('child_process');

const {
  npmScriptsIn, pathsIn, ROOT_FILES, gitignoredAmong, publishedLinkFailures
} = require('../scripts/check-blocks');

const REPO = path.resolve(__dirname, '..', '..');

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

  // ── Phase 6.3. MARKDOWN LINK AND IMAGE TARGETS ────────────────────────────
  //
  // Until 6.3 this function read ONLY backticks and fenced blocks, so not one
  // markdown link target had ever been checked. The gap was found by mutating
  // the image path in docs/OBSERVABILITY.md and watching the checker stay
  // green — and it mattered because README grows links at 8.1, which are
  // exactly the references a stranger follows.

  test('collects a markdown IMAGE target — 6.3, the repo\'s first image', () => {
    expect(tokens('![a red span](../results/tracing-background-failure.png)'))
      .toEqual(['results/tracing-background-failure.png']);
  });

  test('collects a markdown LINK target', () => {
    expect(tokens('see [the catalog](docs/FAILURE-MODES.md) for rates'))
      .toEqual(['docs/FAILURE-MODES.md']);
  });

  test('strips a leading ../ so a doc-relative target resolves against ROOTS', () => {
    // A path written from inside docs/ names the same file as one written from
    // the repo root. Stripping hands it to the existing ROOTS machinery rather
    // than adding a second, document-relative resolver.
    expect(tokens('[x](../results/holm-family.txt)')).toEqual(['results/holm-family.txt']);
    expect(tokens('[x](../../results/holm-family.txt)')).toEqual(['results/holm-family.txt']);
  });

  test('alt text spanning brackets does not break the target', () => {
    // The target is matched from the closing `](`, not by parsing the whole
    // construct, precisely so alt text may contain brackets.
    expect(tokens('![a [red] span](results/holm-family.txt)')).toEqual(['results/holm-family.txt']);
  });

  test('ignores an external URL and a bare anchor in a link target', () => {
    expect(tokens('[docs](https://example.com/a/b.md)')).toEqual([]);
    expect(tokens('[jump](#section-two)')).toEqual([]);
  });

  test('a placeholder inside a link target is still a placeholder', () => {
    // docs/EVALUATION.md §39.6 writes the markdown syntax as an EXAMPLE. An
    // illustration of a form is not a reference to a file.
    expect(tokens('![alt](../results/<file>.png)')).toEqual([]);
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

  test('requires a slash UNLESS the name is a declared root file', () => {
    // THIS TEST CHANGED AT THE PRE-PHASE-8 SWEEP AND THE CHANGE IS THE POINT.
    // It used to assert `package.json` was never looked up. That was the whole
    // defect: every file at the repository root was invisible to rule 2, which
    // is how `railway.json` sat in three documents describing a deploy that had
    // stopped existing and was reported zero times.
    //
    // The bar for a bare token is now ROOT_FILES membership, not absence of a
    // slash. `metrics.js` still is not a path — it lives in backend/eval/ and
    // this project writes it as prose shorthand constantly.
    expect(tokens('`metrics.js` and `package.json`')).toEqual(['package.json']);
    expect(tokens('`server.js`, `run-eval.js`, `llm.service.js`')).toEqual([]);
  });

  describe('root files — the pre-Phase-8 sweep, 27 Aug 2026', () => {
    test('the declared set is exactly the files tracked at the repository root', () => {
      // THE ONE ASSERTION THAT CAN CATCH A DRIFTED SET. ROOT_FILES is declared
      // rather than derived, deliberately — deriving it means deleting a file
      // also deletes the check that would have caught the deletion. But a
      // declaration that nobody reconciles is how a list becomes fiction, so
      // the reconciliation is here rather than in anybody's head.
      //
      // A NEW ROOT-LEVEL FILE TURNS THIS RED, and that is correct: it is a
      // decision about whether documents naming it should be checked, and it
      // should be taken by an editor rather than inherited by a glob.
      const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
        .trim().split('\n')
        .filter((f) => f && !f.includes('/'))
        .sort();
      expect([...ROOT_FILES].sort()).toEqual(tracked);
    });

    test('railway.json is NOT in the set, and that is deliberate', () => {
      // It was deleted 27 Aug 2026 and its remaining references are DATED
      // records of the Railway-to-Render move. Adding it would turn a correct
      // historical reference into a red build — the tool serving itself.
      expect(ROOT_FILES.has('railway.json')).toBe(false);
      expect(tokens('`railway.json` was deleted')).toEqual([]);
    });

    test('every declared root file actually resolves at the root', () => {
      // Otherwise the set is a list of names the checker will report forever.
      for (const name of ROOT_FILES) {
        expect(fs.existsSync(path.join(REPO, name))).toBe(true);
      }
    });

    test('a root file is collected from a fence and from a link target too', () => {
      expect(tokens('```\ndocker-compose.yml\n```')).toEqual(['docker-compose.yml']);
      expect(tokens('see [the compose file](docker-compose.yml)')).toEqual(['docker-compose.yml']);
    });

    test('an absolute path with a root-file basename is still rejected', () => {
      // ROOT_FILES loosens the slash rule and must not loosen the others.
      expect(tokens('`/package.json`')).toEqual([]);
      expect(tokens('`node_modules/package.json`')).toEqual(['node_modules/package.json']);
    });
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

describe('rule 4 — a published document may not link to a gitignored file', () => {
  /**
   * THE CHECKER CANNOT CHECK ITSELF, WHICH IS WHY THIS SUITE EXISTS.
   *
   * Rule 4 flags NOTHING in this repository today — measured before it was
   * built. So a mutation that breaks it leaves `npm run check:blocks` green and
   * silent, and the mutation pass confirmed exactly that: replacing the filter
   * with `[]` survived the checker completely. A rule whose correct output is
   * an empty list can only be tested against a case it SHOULD flag.
   *
   * These drive the real function against real paths in this real repository,
   * so they cannot pass on a fixture that agrees with a broken implementation —
   * §32.7's warning, which is why no fake gitignore is constructed here.
   */
  test('it identifies a gitignored path — the docs/EVALUATION.md case that bit twice', () => {
    // The exact reference the README pass had to remove by hand, and the one
    // 8.1's anchor bullet would have shipped.
    const got = gitignoredAmong(['docs/EVALUATION.md']);
    expect(got.ok).toBe(true);
    expect(got.ignored.has('docs/EVALUATION.md')).toBe(true);
  });

  test('it does NOT flag a tracked path — otherwise every link fails', () => {
    const got = gitignoredAmong(['README.md', 'docs/FAILURE-MODES.md', 'backend/scripts/check-blocks.js']);
    expect(got.ok).toBe(true);
    expect([...got.ignored]).toEqual([]);
  });

  test('it separates the two in ONE call, which is how the checker uses it', () => {
    const got = gitignoredAmong(['README.md', 'docs/EVALUATION.md', 'docs/OBSERVABILITY.md']);
    expect(got.ok).toBe(true);
    expect([...got.ignored].sort()).toEqual(['docs/EVALUATION.md']);
  });

  test('an empty input is ok and empty, not an error', () => {
    const got = gitignoredAmong([]);
    expect(got.ok).toBe(true);
    expect(got.ignored.size).toBe(0);
  });

  test('the return shape makes "git did not answer" impossible to read as "nothing ignored"', () => {
    // A bare Set would collapse the two states, and §22.6 is the whole reason
    // this repository refuses that collapse. `ok` is the discriminator and it
    // is present on both branches.
    const got = gitignoredAmong(['README.md']);
    expect(Object.prototype.hasOwnProperty.call(got, 'ok')).toBe(true);
    expect(got.ignored).toBeInstanceOf(Set);
  });

  // ── THE TWO CASES THE FIRST MUTATION PASS MISSED ────────────────────────
  //
  // Five mutations, three caught. The two survivors are both joins rather than
  // logic: the wiring between predicate and rule, and the branch that only
  // fires when git itself fails. Both were reachable only after a seam was
  // added, and adding the seam is the fix §38.6 prescribes — strengthen the
  // test, do not accept the finding.

  test('WIRING: a gitignored resolved path becomes a failure row', () => {
    // Mutation M9 replaced this filter with [] in main() and survived BOTH the
    // suite and the checker, because rule 4's correct output today is empty.
    const rows = [
      { file: 'README.md', line: 12, token: 'docs/EVALUATION.md', resolved: 'docs/EVALUATION.md' },
      { file: 'README.md', line: 20, token: 'results/test-ladder.txt', resolved: 'results/test-ladder.txt' }
    ];
    const verdict = { ok: true, ignored: new Set(['docs/EVALUATION.md']) };
    expect(publishedLinkFailures(rows, verdict)).toEqual([rows[0]]);
  });

  test('WIRING: nothing ignored means no failures', () => {
    const rows = [{ file: 'README.md', line: 1, token: 'a.md', resolved: 'a.md' }];
    expect(publishedLinkFailures(rows, { ok: true, ignored: new Set() })).toEqual([]);
  });

  test('WIRING: a git failure yields NO failures — the skip is reported elsewhere', () => {
    // It must not invent failures from an unanswered question either. The
    // checker prints a declared RULE 4 SKIPPED block for this case.
    const rows = [{ file: 'README.md', line: 1, token: 'a.md', resolved: 'a.md' }];
    expect(publishedLinkFailures(rows, { ok: false, why: 'no git' })).toEqual([]);
  });

  test('A FAILING git is reported as ok:false, NOT as "nothing is ignored"', () => {
    // Mutation M11 returned an empty Set from the catch and survived, because
    // git works on every machine this suite has ever run on. The injected
    // runner is what makes the branch reachable at all.
    const boom = () => { throw new Error('git: command not found'); };
    const got = gitignoredAmong(['docs/EVALUATION.md'], boom);
    expect(got.ok).toBe(false);
    expect(got.why).toContain('git');
    expect(got.ignored).toBeUndefined();
  });

  test('the injected runner is really used, so the test above is not vacuous', () => {
    // Positive control. Without this, a runner argument that main() ignored
    // would make the failure test pass against a function that never ran it.
    const got = gitignoredAmong(['anything.md'], () => 'anything.md\n');
    expect(got.ok).toBe(true);
    expect([...got.ignored]).toEqual(['anything.md']);
  });

  test('the three published writeups are themselves tracked, which rule 4 assumes', () => {
    // If a published writeup were gitignored, rule 4 would be checking the
    // links of a document no stranger can read — a check that runs and means
    // nothing.
    const got = gitignoredAmong(['README.md', 'docs/FAILURE-MODES.md', 'docs/OBSERVABILITY.md']);
    expect([...got.ignored]).toEqual([]);
    for (const f of ['README.md', 'docs/FAILURE-MODES.md', 'docs/OBSERVABILITY.md']) {
      expect(fs.existsSync(path.join(REPO, f))).toBe(true);
    }
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
