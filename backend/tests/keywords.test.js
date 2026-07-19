const { extractKeywords } = require('../utils/keywords');

describe('extractKeywords TF-IDF', () => {
  const corpus = [
    { title: 'Postgres tuning', content: 'database indexing query planner database' },
    { title: 'Mongo sharding', content: 'database replication sharding database' },
    { title: 'Consensus', content: 'raft consensus leader election database' },
  ];
  test('rare term outranks common term of equal frequency with corpus', () => {
    const kw = extractKeywords('Distributed consensus', 'raft raft database database', corpus, 5);
    expect(kw.indexOf('raft')).toBeLessThan(kw.indexOf('database'));
  });
  test('IDF constant without corpus (equal terms both survive)', () => {
    const kw = extractKeywords('', 'alpha alpha bravo bravo', [], 5);
    expect(kw).toEqual(expect.arrayContaining(['alpha', 'bravo']));
  });
  test('title terms weighted above body-only terms', () => {
    const kw = extractKeywords('kubernetes', 'docker container runtime', [], 5);
    expect(kw[0]).toBe('kubernetes');
  });
  test('empty input returns empty array', () => {
    expect(extractKeywords('', '', [], 5)).toEqual([]);
  });
});
