/**
 * Links between the published documents — that they RESOLVE, and that they
 * point at the record they NAME. Phase 8.2.
 *
 * WHY A TEST AND NOT A CHECKER RULE. check:blocks' rule 2 requires a token to
 * carry a slash or be a declared root-level file, so an ADR linking a sibling
 * as `0003-no-job-queue.md` is invisible to it — 30 such links exist and
 * nothing checks them. Teaching rule 2 to resolve a link against the file it
 * appears in is the architecturally right fix and a much larger one: pathsIn()
 * sees text and not its origin, so it is an API change to an exported function
 * with its own tests, and it widens the resolver for every writeup. 8.1 met the
 * identical fork over README's results table and bought the same protection
 * with a test; this follows that precedent.
 *
 * WHAT IT CATCHES THAT RESOLUTION ALONE DOES NOT. A link can resolve and still
 * be wrong: `[ADR-0003](0004-microbenchmark-not-load-test.md)` points at a file
 * that exists. Nothing about its existence says it is the record the sentence
 * claims. So the link TEXT is checked against the target's own title — which is
 * the same distinction methodology-tables.test.js draws between a value being
 * present and a value being in the right row.
 *
 * PURE: reads committed markdown, no network, no database, no key.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ADR_DIR = path.join(REPO, 'docs', 'adr');

// DECLARED, with the ADRs themselves derived — and a floor so the derivation
// cannot quietly become empty. The non-ADR documents are named because a new
// published document must be added here deliberately; the ADRs are globbed
// because the whole point is that ADR-0009 onward are covered without anyone
// remembering to say so. The floor is the declaration.
const DECLARED = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/METHODOLOGY.md',
  'docs/FAILURE-MODES.md',
  'docs/OBSERVABILITY.md'
];
const MIN_ADRS = 8;

const adrFiles = fs.readdirSync(ADR_DIR).filter((f) => /^\d{4}-[a-z0-9-]+\.md$/.test(f)).sort();
const scanned = [...DECLARED, 'docs/adr/README.md', ...adrFiles.map((f) => `docs/adr/${f}`)];

const linksIn = (rel) => {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  return [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)]
    .map((m) => ({ text: m[1], target: m[2] }))
    .filter((l) => !/^(https?:|#|mailto:)/.test(l.target));
};

describe('published documents — every relative link resolves', () => {
  test('the ADR glob found the records it is supposed to cover', () => {
    expect(adrFiles.length).toBeGreaterThanOrEqual(MIN_ADRS);
  });

  test.each(scanned)('%s', (rel) => {
    const dir = path.dirname(path.join(REPO, rel));
    const broken = linksIn(rel)
      .filter((l) => !fs.existsSync(path.resolve(dir, l.target.split('#')[0])))
      .map((l) => `${l.target}  (linked as "${l.text}")`);
    expect(broken).toEqual([]);
  });
});

describe('ADR links point at the record they name', () => {
  // Each ADR's own H1 is the authority. `# ADR-0003 — No job queue`.
  const titleOf = (file) => {
    const h1 = fs.readFileSync(path.join(ADR_DIR, file), 'utf8').split('\n')[0];
    const m = h1.match(/^#\s+ADR-(\d{4})\s+—\s+(.+)$/);
    if (!m) throw new Error(`ADR has no conforming H1: ${file} -> ${h1}`);
    return { number: m[1], title: m[2] };
  };

  test('every ADR declares its own filename number in its H1', () => {
    const mismatches = adrFiles
      .map((f) => ({ file: f, fromName: f.slice(0, 4), fromTitle: titleOf(f).number }))
      .filter((r) => r.fromName !== r.fromTitle);
    expect(mismatches).toEqual([]);
  });

  test('numbers are unique — a reused number is the defect the 0005 collision was', () => {
    const nums = adrFiles.map((f) => f.slice(0, 4));
    expect(nums).toEqual([...new Set(nums)]);
  });

  // THE ONE THAT RESOLUTION CANNOT DO. A link naming ADR-0003 must not point at
  // 0004's file, and a link whose text is a phrase must be a phrase that record
  // actually uses.
  test.each(scanned)('%s — link text agrees with the target', (rel) => {
    const wrong = [];
    for (const link of linksIn(rel)) {
      const base = path.basename(link.target.split('#')[0]);
      const m = base.match(/^(\d{4})-[a-z0-9-]+\.md$/);
      if (!m || !link.target.includes('adr') && !rel.startsWith('docs/adr/')) continue;
      if (!adrFiles.includes(base)) continue;
      const target = titleOf(base);

      const numbered = link.text.match(/(?:ADR-)?(\d{4})/);
      if (numbered) {
        if (numbered[1] !== target.number) {
          wrong.push(`"${link.text}" -> ${base} (that file is ADR-${target.number})`);
        }
        continue;
      }
      // Descriptive text: it must be language the target's own title uses.
      if (!target.title.toLowerCase().includes(link.text.toLowerCase())) {
        wrong.push(`"${link.text}" -> ${base} whose title is "${target.title}"`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
