/**
 * docs/METHODOLOGY.md's measured tables, pinned to the artifacts they claim to
 * come from. Phase 8.2.
 *
 * WHY THIS EXISTS WHEN check:claims ALREADY SCANS THE FILE. 8.1 MEASURED that
 * the checker catches an INVENTED digit and not a MISPLACED one: across the
 * plausibility band, a third of four-place slots are already justified by some
 * unrelated value in the artifact index. Scoping README to two paths took that
 * from 37.8% to 9.0% and 9.0% is not 0%.
 *
 * A MISPLACEMENT HERE INVERTS A FINDING RATHER THAN DENTING IT. Swap the two
 * rows of the key-composition table and the document says duplicates are the
 * HARDER population, which is the opposite of what the artifact measured and is
 * the single fact section 4 exists to report. check:claims cannot see that —
 * both values are real, both trace, only the rows moved.
 *
 * Same shape as tests/readme-results-table.test.js (8.1) and the same argument.
 * PURE: reads two committed artifacts and one committed document, no network,
 * no database, no key.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const DOC = 'docs/METHODOLOGY.md';

describe('METHODOLOGY.md — the key-composition table matches error-analysis.dev.txt', () => {
  // The artifact's own block:
  //   grade 1 only (linked)       1766        872       49.4%      0.297554
  //   any grade 2 (duplicate)      538        167       31.0%      0.423199
  const artifact = read('results/error-analysis.dev.txt');
  const doc = read(DOC);

  const rowOf = (label) => {
    const m = artifact.match(
      new RegExp(`${label}\\s+(\\d+)\\s+(\\d+)\\s+([\\d.]+)%\\s+([\\d.]+)`)
    );
    if (!m) throw new Error(`artifact row not found: ${label}`);
    return { queries: m[1], zeroRate: m[3], ndcg: m[4] };
  };

  const grade1 = rowOf('grade 1 only \\(linked\\)');
  const grade2 = rowOf('any grade 2 \\(duplicate\\)');

  test('the artifact still has both rows, and they differ', () => {
    expect(grade1.ndcg).not.toBe(grade2.ndcg);
    expect(Number(grade2.ndcg)).toBeGreaterThan(Number(grade1.ndcg));
  });

  // THE ROW BINDING. Each figure must appear on the document line that names
  // its own stratum — not merely somewhere in the file, which is all
  // check:claims can ask.
  const docLine = (label) => {
    const line = doc.split('\n').find((l) => l.includes(label) && l.startsWith('|'));
    if (!line) throw new Error(`document row not found: ${label}`);
    return line;
  };

  test('grade-1 row carries its OWN queries, zero rate and nDCG', () => {
    const line = docLine('grade 1 only');
    expect(line).toContain(grade1.ndcg);
    expect(line).toContain(`${grade1.zeroRate}%`);
    expect(line.replace(/,/g, '')).toContain(grade1.queries);
  });

  test('grade-2 row carries its OWN queries, zero rate and nDCG', () => {
    const line = docLine('any grade 2');
    expect(line).toContain(grade2.ndcg);
    expect(line).toContain(`${grade2.zeroRate}%`);
    expect(line.replace(/,/g, '')).toContain(grade2.queries);
  });

  test('the rows are not swapped', () => {
    expect(docLine('grade 1 only')).not.toContain(grade2.ndcg);
    expect(docLine('any grade 2')).not.toContain(grade1.ndcg);
  });
});

describe('METHODOLOGY.md — the contamination margins match the test-split artifact', () => {
  //   unseen           208      0.304197   0.354344   +0.050147  [...]
  //   seen            2097      0.232610   0.316279   +0.083669  [...]
  const artifact = read('results/contamination-linkdate.test.txt');
  const doc = read(DOC);

  const stratum = (label) => {
    const m = artifact.match(new RegExp(`\\n\\s*${label}\\s+(\\d+)\\s+[\\d.]+\\s+[\\d.]+\\s+\\+([\\d.]+)`));
    if (!m) throw new Error(`artifact stratum not found: ${label}`);
    return { n: m[1], margin: m[2] };
  };
  const unseen = stratum('unseen');
  const seen = stratum('seen');

  test('the artifact still carries both strata', () => {
    expect(unseen.margin).not.toBe(seen.margin);
  });

  // THE DIRECTION IS THE CLAIM. The document says the advantage SURVIVES in the
  // uncontaminated stratum and is SMALLER there. If the artifact ever stops
  // supporting that, the sentence must change — so it is asserted, not assumed.
  test('the uncontaminated margin is positive and smaller than the contaminated one', () => {
    expect(Number(unseen.margin)).toBeGreaterThan(0);
    expect(Number(unseen.margin)).toBeLessThan(Number(seen.margin));
  });

  test('each margin is bound to its own stratum count in the document', () => {
    const sentence = doc.match(/\*\*\+[\d.]+\*\* on the [\d,]+ fully post-snapshot queries and\s*\n?\s*\*\*\+[\d.]+\*\* on the [\d,]+ others/);
    expect(sentence).not.toBeNull();
    const [, m1, n1, m2, n2] = sentence[0].replace(/\n\s*/g, ' ')
      .match(/\*\*\+([\d.]+)\*\* on the ([\d,]+) fully post-snapshot queries and \*\*\+([\d.]+)\*\* on the ([\d,]+) others/);
    expect({ m1, n1: n1.replace(/,/g, ''), m2, n2: n2.replace(/,/g, '') })
      .toEqual({ m1: unseen.margin, n1: unseen.n, m2: seen.margin, n2: seen.n });
  });
});

describe('METHODOLOGY.md — the metric-validation figures match the run sidecars', () => {
  const doc = read(DOC);
  const sidecar = JSON.parse(read('results/runs/v4-bm25.test.run.json'));

  // A NUMBER HAS MORE THAN ONE CORRECT SPELLING, and this assertion got that
  // wrong before it got the document wrong: String(1e-06) is "0.000001", while
  // both the artifact and the document write `1e-06`. Accept either rendering
  // of the SAME value rather than pinning one spelling — otherwise the test
  // fails on formatting and the fix is to damage a correct document.
  const rendersAs = (n) => {
    const forms = new Set([String(n), n.toExponential(), n.toExponential(2)]);
    // toExponential() gives "1e-6"; the conventional written form pads to two
    // exponent digits, which is what both files use.
    for (const f of [...forms]) forms.add(f.replace(/e([+-])(\d)$/, 'e$10$2'));
    return [...forms];
  };

  test('the reference, tolerance and max delta are the sidecar\'s own', () => {
    const v = sidecar.metricsValidation;
    expect(doc).toContain(v.reference);
    expect(rendersAs(v.maxAbsDelta).some((f) => doc.includes(f))).toBe(true);
    expect(rendersAs(v.tolerance).some((f) => doc.includes(f))).toBe(true);
  });

  // BOUND TO ITS OWN SENTENCE, NOT TO THE WHOLE FILE — and that distinction is
  // here because the first version of this test SURVIVED its mutation. It asked
  // "does 27325 appear anywhere", and the figure appears TWICE: once as the
  // claim, and once in the provenance section as an example of an unguarded
  // number. Corrupting the claim left the example behind and the test passed.
  // Presence in a document is a weaker question than it looks; ask where.
  test('the corpus size is the sidecar\'s docCount, on the sentence that claims it', () => {
    const line = doc.split('\n').find((l) => l.includes('every question in that site'));
    expect(line).toBeDefined();
    expect(line.replace(/,/g, '')).toContain(String(sidecar.retriever.docCount));
  });

  test('each input digest prefix quoted is genuinely that input\'s', () => {
    for (const input of sidecar.inputs) {
      const prefix = input.sha256.slice(0, 8);
      // Bound to the input's NAME on the same line, not merely present.
      const line = doc.split('\n').find((l) => l.includes(`"${input.name}"`));
      expect(line).toBeDefined();
      expect(line).toContain(prefix);
    }
  });
});
