'use strict';

/**
 * keywords.stability.test.js — Phase 4.6.
 *
 * Roadmap 4.6's Done criterion: "a test asserts two notes with identical text
 * get identical keywords regardless of save order."
 *
 * ---------------------------------------------------------------------------
 * THE CRITERION IS MET IN ONE FORM AND NOT IN A STRONGER ONE, AND BOTH HALVES
 * ARE ASSERTED HERE. §7.2's move, applied to 4.6's own criterion.
 * ---------------------------------------------------------------------------
 *
 * There are TWO defects behind "the keyword list is a corpus snapshot" and a
 * `.sort()` closes exactly one of them:
 *
 *   ORDER  which <=500 documents feed the IDF. Closed by 4.6, and the first
 *          describe() below is what closes it — these tests FAIL against the
 *          preserved pre-4.6 loader, which is what makes them tests rather
 *          than restatements.
 *
 *   EPOCH  when each list was computed. `routes/notes.js:124-125` extracts at
 *          save time and persists; nothing recomputes. So a note saved into an
 *          8-note account and the same text saved into a 400-note account get
 *          different lists, and no sort can change that — any stored value
 *          derived from a moving corpus is a function of when it was derived.
 *
 * The second describe() PINS EPOCH AS A KNOWN DEFECT rather than asserting it
 * away. Same device §25.3 used for `buildNoteGraph`'s missing user filter: a
 * test that pins current behaviour makes fixing it later a deliberate change
 * with a failing test to update, instead of something to rediscover. If a
 * future session moves extraction to read time, THESE ARE THE TESTS THAT GO
 * RED, and that is the intended signal.
 *
 * results/keyword-stability.txt carries the measurement at corpus scale;
 * EVALUATION §26 carries the argument.
 */

// Same priming as the parity suites: jest keeps its own module registry and
// ignores the require.cache install() the scripts do.
jest.mock('../models/Note', () => require('../scripts/lib/fake-note-store').FakeNote);
jest.mock('../models/NoteLink', () => require('../scripts/lib/fake-note-store').FakeNoteLink);

const parity = require('../scripts/parity-v1');
const stability = require('../scripts/measure-keyword-stability');

const { convergedKeywords, saveHistoryKeywords, USER, CORPUS_LIMIT } = stability;

/** Two notes with byte-identical text, at the two ends of a corpus. */
function withTwins(filler, text) {
  const early = { _id: 'aaa-twin-early', user: USER, title: text.title, contentText: text.body, keywords: [], tags: [] };
  const late = { _id: 'zzz-twin-late', user: USER, title: text.title, contentText: text.body, keywords: [], tags: [] };
  return [early, ...filler, late];
}

/**
 * Background documents above the 500 cap, borrowed from the parity fixture that
 * exists for exactly this — `capFixture` generates 521 documents whose tenth
 * keyword slot is contested by two terms with different document frequencies,
 * which is the only thing that can make WHICH 500 observable.
 */
function capNotes() {
  return parity.capFixture()
    .filter((d) => d.id !== 'query')
    .map((d) => ({ _id: d.id, user: USER, title: d.title, contentText: d.body, keywords: [], tags: [] }));
}

/**
 * The background documents PLUS two contested ones, and the pairing is not
 * cosmetic.
 *
 * THE BACKGROUND DOCUMENTS ALONE CANNOT MOVE, WHICH A MUTATION PASS FOUND
 * RATHER THAN A REVIEW. Each `capFixture` filler carries about six surviving
 * terms — fewer than the ten slots — so every one of them is kept whatever the
 * document frequencies say, and the terms that repeat (`background`, `padding`,
 * `text`, `document`) sit in essentially every note, so swapping which 500 form
 * the corpus moves their df by at most one in five hundred and reorders
 * nothing. The first draft of the order test ran on exactly that fixture and
 * PASSED WITH THE SORT DELETED: a check that could not distinguish the states
 * it existed to distinguish, which is §22.6's shape in the file written to
 * demonstrate the opposite.
 *
 * The twins are what make a corpus change observable: nine terms unique to them
 * take slots 1-9 on df alone, and slot 10 goes to whichever of `alpha` and
 * `bravo` the corpus makes rarer — which is precisely what "which 500" decides.
 */
function contestedNotes() {
  return withTwins(capNotes(), TWIN_TEXT);
}

/**
 * `capFixture`'s query document, and the text has to be exactly this.
 *
 * THE FIRST DRAFT OF THIS FIXTURE COULD NOT FAIL, which is the shape §22.6
 * names and this file is not allowed to have. It gave the twins a title and
 * nine long nonsense words, so `alpha` and `bravo` — the only two terms whose
 * document frequency the corpus can move — were crowded out of the top ten by
 * the length bonus and never reached the list at all. Every df that survived
 * was 0 at every epoch, and `idf = log((docCount+1)/1) + 1` is then the same
 * factor on every term, so it scales the scores and reorders nothing. The
 * epoch tests passed against a corpus that could not have moved them.
 *
 * So: no title, and nine unique terms that take slots 1-9 on df alone, leaving
 * slot 10 contested between two terms whose df the corpus actually changes.
 * That is what `capFixture` was built for and it is borrowed rather than
 * re-invented.
 */
const TWIN_TEXT = {
  title: '',
  body: 'aardvarks binnacles cormorants dromedary escutcheon fandangos gasconade hibernate ichthyoid alpha bravo'
};

describe('what 4.6 makes true: one corpus state, one answer', () => {
  test('above the cap, the store return order no longer changes any keyword list', async () => {
    const notes = contestedNotes();
    expect(notes.length).toBeGreaterThan(CORPUS_LIMIT);

    const ids = notes.map((n) => String(n._id));
    const asc = await convergedKeywords(notes, ids);
    const desc = await convergedKeywords(notes, [...ids].reverse());

    const differing = ids.filter((id) => asc.get(id).join(',') !== desc.get(id).join(','));
    expect(differing).toEqual([]);
  });

  test('the SAME fixture under the preserved pre-4.6 loader DOES change', async () => {
    // The mutation check, in the file rather than by hand, and on the identical
    // fixture and identical experiment so the only difference is the loader.
    // Without it the test above passes on documents that could not have moved
    // anyway — which is what the first draft did, see contestedNotes().
    const notes = contestedNotes();
    const ids = notes.map((n) => String(n._id));

    const asc = await convergedKeywords(notes, ids, parity.loadUserCorpusV1);
    const desc = await convergedKeywords(notes, [...ids].reverse(), parity.loadUserCorpusV1);

    const differing = ids.filter((id) => asc.get(id).join(',') !== desc.get(id).join(','));
    expect(differing.length).toBeGreaterThan(0);
    // The contested slot is the one that moves, and naming it stops this
    // passing on some incidental reordering elsewhere in a list.
    const early = 'aaa-twin-early';
    expect(asc.get(early)[9]).not.toBe(desc.get(early)[9]);
    expect(new Set([asc.get(early)[9], desc.get(early)[9]])).toEqual(new Set(['alpha', 'bravo']));
  });

  test('two notes with identical text get identical keywords — at or below the cap', async () => {
    // The criterion's own sentence, in the range the app was designed for.
    // It is EXACT here for a reason worth stating: each twin's leave-one-out
    // corpus contains the other, and identical text contributes identical
    // document frequencies, so the two df tables agree term for term.
    const filler = capNotes().slice(0, CORPUS_LIMIT - 2);
    const notes = withTwins(filler, TWIN_TEXT);
    expect(notes.length).toBe(CORPUS_LIMIT);

    const ids = notes.map((n) => String(n._id));
    const forward = await convergedKeywords(notes, ids);
    const reverse = await convergedKeywords(notes, [...ids].reverse());

    expect(forward.get('aaa-twin-early')).toEqual(forward.get('zzz-twin-late'));
    // ...and it does not depend on which order the store hands them back.
    expect(reverse.get('aaa-twin-early')).toEqual(forward.get('aaa-twin-early'));
    expect(forward.get('aaa-twin-early').length).toBeGreaterThan(0);
  });

  test('above the cap the property is determinism, and equality is NOT claimed', async () => {
    // The honest claim above the cap is narrower than "identical text,
    // identical keywords", and the reason is `excludeId`: `loadUserCorpus`
    // filters the note out BEFORE the limit, so an early note's window is
    // documents 1..501 minus itself while a late note's is 1..500. That is a
    // one-document difference in the df table which the sort SPECIFIES and does
    // not remove. On this fixture the two lists happen to agree anyway; the
    // test does not assert that, because it is a property of these documents
    // rather than of the change.
    const notes = withTwins(capNotes(), TWIN_TEXT);
    expect(notes.length).toBeGreaterThan(CORPUS_LIMIT + 1);

    const ids = notes.map((n) => String(n._id));
    const converged = await convergedKeywords(notes, ids);
    const early = converged.get('aaa-twin-early');
    const late = converged.get('zzz-twin-late');

    // What IS asserted: run it again in the opposite store order and nothing
    // moves. That is what 4.6 buys above the cap.
    const again = await convergedKeywords(notes, [...ids].reverse());
    expect(again.get('aaa-twin-early')).toEqual(early);
    expect(again.get('zzz-twin-late')).toEqual(late);
    expect(early.length).toBeGreaterThan(0);
    expect(late.length).toBeGreaterThan(0);
  });
});

describe('what 4.6 does NOT make true: epoch, pinned as a known defect', () => {
  // If a future session moves extraction to read time, every test in this
  // block goes red. That is the point of them. Do not "fix" one by relaxing
  // its assertion — the writeup that changes the behaviour is what updates it.

  test('a save history does not agree with the converged state', async () => {
    const notes = capNotes().slice(0, 120);
    const ids = notes.map((n) => String(n._id));

    const history = await saveHistoryKeywords(notes, ids);
    const converged = await convergedKeywords(notes, ids);

    const differing = ids.filter((id) => history.get(id).join(',') !== converged.get(id).join(','));
    expect(differing.length).toBeGreaterThan(0);
  });

  test('two save orders of the same notes give different stored keywords', async () => {
    const notes = capNotes().slice(0, 120);
    const ids = notes.map((n) => String(n._id));

    const forward = await saveHistoryKeywords(notes, ids);
    const reversed = await saveHistoryKeywords(notes, [...ids].reverse());

    const differing = ids.filter((id) => forward.get(id).join(',') !== reversed.get(id).join(','));
    expect(differing.length).toBeGreaterThan(0);
  });

  test('identical text saved at two epochs gets two different lists', async () => {
    // The criterion's sentence again, against the save path rather than a
    // corpus state — and this is the half 4.6 does not deliver.
    const filler = capNotes().slice(0, 118);
    const notes = withTwins(filler, TWIN_TEXT);
    const ids = notes.map((n) => String(n._id));

    const history = await saveHistoryKeywords(notes, ids);
    expect(history.get('aaa-twin-early')).not.toEqual(history.get('zzz-twin-late'));

    // ...and the same two notes DO agree once every list comes from one corpus
    // state, so the difference is attributable to the epoch and to nothing else
    // about the two notes. One variable.
    const converged = await convergedKeywords(notes, ids);
    expect(converged.get('aaa-twin-early')).toEqual(converged.get('zzz-twin-late'));
  });

  test('the first saves are where it lives, because an empty corpus has a constant idf', async () => {
    // docCount falls back to 1 and every df is 0, so idf is ln(2)+1 for every
    // term and the ranking collapses to count x lengthBonus — PRIMER §3.3. The
    // first note saved into an account is the extreme case: its corpus is
    // empty, so its list is a pure function of its own text and nothing else.
    const notes = capNotes().slice(0, 60);
    const ids = notes.map((n) => String(n._id));

    const history = await saveHistoryKeywords(notes, ids);
    const converged = await convergedKeywords(notes, ids);

    const moved = (id) => {
      const a = new Set(history.get(id));
      const b = new Set(converged.get(id));
      return [...a].filter((t) => !b.has(t)).length;
    };
    const firstTen = ids.slice(0, 10).filter((id) => moved(id) > 0).length;
    const lastTen = ids.slice(-10).filter((id) => moved(id) > 0).length;
    expect(firstTen).toBeGreaterThanOrEqual(lastTen);
  });
});
