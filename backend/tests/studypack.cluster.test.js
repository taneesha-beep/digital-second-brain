'use strict';

/**
 * studypack.cluster.test.js — Phase 5.1. THE JOIN, PROVED, WITHOUT SPENDING A
 * SINGLE TOKEN.
 *
 * This is why `buildCluster` is a separate exported function from
 * `buildStudyPack`. The claim 5.1 exists to make is that a MEASURED RETRIEVER'S
 * OUTPUT REACHES A PROMPT — and that claim is entirely about the half of the
 * path before the API call. Splitting the two means it can be checked against a
 * real database, deterministically, with no key, no network, no quota and no
 * model in the loop.
 *
 * It needs the `mongo` precondition and skips LOUDLY without it, exactly as
 * integration.app.test.js does:
 *
 *   docker run -d --rm --name dsb-mongo -p 27017:27017 \
 *     mongo:7@sha256:9bdaeb6dac6e7e762e84e2f84103d1f9bb078fa1ba6bde8bb9d2274f655ad173
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017/dsb_studypack_test npm test
 *
 * `mongo` is a PROMISED precondition in CI, so this suite runs there.
 */

const mongoose = require('mongoose');

const { describeWith, mongoUri } = require('./helpers/preconditions');

describeWith('mongo', 'buildCluster joins retrieval to the prompt', () => {
  let Note;
  let User;
  let sp;
  let noteCorpus;
  let retrieval;
  let userId;
  let otherUserId;

  /**
   * Four notes on two clearly separate topics, plus one note belonging to a
   * different user. Written so the RANKING is not a coin flip: a lexical
   * retriever has to put the two bread notes together and the two networking
   * notes together, or the assertions below are about noise.
   */
  const NOTES = {
    sourdough: {
      title: 'Sourdough starter maintenance',
      contentText:
        'A sourdough starter is flour and water fermented by wild yeast and lactic acid bacteria. ' +
        'Feed the starter with equal weights of flour and water once a day at room temperature. ' +
        'A sluggish starter usually means it is cold or underfed, so raise the temperature or feed it twice.'
    },
    bread: {
      title: 'Why bread dough fails to rise',
      contentText:
        'Bread dough that will not rise is usually a yeast problem: dead yeast, cold dough, or too much salt ' +
        'in direct contact with the yeast. A sourdough starter that is underfed behaves the same way. ' +
        'Proof the dough somewhere warm and give the wild yeast time to ferment the flour.'
    },
    /**
     * A THIRD baking note, so the bread cluster has more than one neighbour.
     * Without it the `k` and budget assertions below pass vacuously — a cap of
     * 1 over a list of length 1 tests nothing, which is §26.7's shape.
     */
    yeast: {
      title: 'Wild yeast versus commercial yeast',
      contentText:
        'Wild yeast in a sourdough starter ferments flour more slowly than commercial yeast and gives dough ' +
        'a sour flavour from lactic acid bacteria. Commercial yeast makes bread dough rise faster but the ' +
        'flavour is flatter. Either way the yeast needs warmth, water and flour to ferment.'
    },
    tcp: {
      title: 'TCP retransmission basics',
      contentText:
        'TCP retransmits a segment when its acknowledgement does not arrive before the retransmission timeout. ' +
        'The timeout is derived from a smoothed round trip time estimate. Repeated retransmission collapses ' +
        'the congestion window and throughput falls sharply on a lossy network path.'
    },
    congestion: {
      title: 'Congestion control and the window',
      contentText:
        'Congestion control sizes the congestion window against observed loss on the network path. ' +
        'A retransmission timeout is read as congestion, so the sender shrinks its window and throughput drops. ' +
        'Slow start then grows the window again until loss reappears.'
    }
  };

  const ids = {};

  beforeAll(async () => {
    /**
     * ITS OWN DATABASE, NOT THE ONE MONGO_TEST_URI NAMES — and this was found by
     * running it, not by reading it.
     *
     * integration.app.test.js reads the same MONGO_TEST_URI and calls
     * dropDatabase() in its own beforeAll. Jest runs suites in parallel workers,
     * so with both pointed at one database the two drop each other's fixtures
     * mid-run: 28 integration tests failed on missing indexes the first time
     * these two suites ran together. `dbName` isolates this suite whatever URI
     * the operator exports, and the localhost check in mongoUri() still applies
     * because the host half of the URI is untouched.
     */
    await mongoose.connect(mongoUri(), { serverSelectionTimeoutMS: 15000, dbName: 'dsb_studypack_suite' });
    await mongoose.connection.dropDatabase();

    Note = require('../models/Note');
    User = require('../models/User');
    sp = require('../services/studyPack.service');
    noteCorpus = require('../services/noteCorpus.service');
    retrieval = require('../retrieval');

    for (const model of [Note, User]) await model.syncIndexes();

    const owner = await User.create({
      name: 'Study Pack Owner', username: 'sp-owner', email: 'sp-owner@example.com', password: 'x'.repeat(12)
    });
    const stranger = await User.create({
      name: 'Stranger', username: 'sp-stranger', email: 'sp-stranger@example.com', password: 'x'.repeat(12)
    });
    userId = owner._id;
    otherUserId = stranger._id;

    // Created directly rather than through the route: this suite is about the
    // cluster builder, and the route fires linking un-awaited (CLAUDE.md), which
    // a direct create avoids racing.
    for (const [key, note] of Object.entries(NOTES)) {
      const created = await Note.create({ ...note, user: userId });
      ids[key] = String(created._id);
    }
    const strangerNote = await Note.create({
      title: 'Sourdough starter maintenance', contentText: NOTES.sourdough.contentText, user: otherUserId
    });
    ids.stranger = String(strangerNote._id);
  }, 60000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('THE JOIN: the notes in the prompt are the retriever\'s ranked neighbours', async () => {
    const cluster = await sp.buildCluster(ids.sourdough, userId);

    // Independently recompute the ranking through the same interface the
    // linker uses. If these two ever disagree, the prompt is being built from
    // something other than the retriever — which is the whole defect 5.1 exists
    // to remove, and it would be invisible in any assertion about counts.
    const docs = await noteCorpus.loadNoteCorpus(userId);
    const handle = retrieval.index(noteCorpus.APP_RETRIEVER, docs, {});
    const expected = retrieval.search(handle, ids.sourdough, noteCorpus.LINK_CAP).map((h) => h.docId);

    const neighboursInPrompt = cluster.context.included
      .filter((n) => n.role === 'neighbour')
      .map((n) => n.noteId);

    expect(neighboursInPrompt).toEqual(expected);
    expect(neighboursInPrompt.length).toBeGreaterThan(0);
  });

  test('the ranking is real rather than incidental — the topics separate', async () => {
    // MEASURED WHEN THIS TEST WAS WRITTEN, AND IT IS STRONGER THAN THE
    // ASSERTION IT REPLACED. The first draft asserted bread ranks ABOVE tcp.
    // v4-bm25 does not rank tcp at all: it shares no term with the sourdough
    // seed that survives the tokenizer, scores zero, and never enters the
    // ranked list. So the check is that the cross-topic notes are ABSENT, not
    // merely lower — a weaker assertion would have passed on an empty list too.
    const bread = await sp.buildCluster(ids.sourdough, userId);
    const breadNeighbours = bread.context.included.filter((n) => n.role === 'neighbour').map((n) => n.noteId);
    expect(breadNeighbours).toContain(ids.bread);
    expect(breadNeighbours).toContain(ids.yeast);
    expect(breadNeighbours).not.toContain(ids.tcp);
    expect(breadNeighbours).not.toContain(ids.congestion);

    const net = await sp.buildCluster(ids.tcp, userId);
    const netNeighbours = net.context.included.filter((n) => n.role === 'neighbour').map((n) => n.noteId);
    expect(netNeighbours).toEqual([ids.congestion]);
  });

  test('the assembled text really contains the neighbour bodies', async () => {
    const cluster = await sp.buildCluster(ids.sourdough, userId);
    expect(cluster.context.text).toContain(NOTES.sourdough.contentText);
    expect(cluster.context.text).toContain(NOTES.bread.contentText);
    expect(cluster.context.text.startsWith(`[1] ${NOTES.sourdough.title}`)).toBe(true);
  });

  test('ANOTHER USER\'S IDENTICAL NOTE IS NEVER IN THE CONTEXT', async () => {
    // §25.3 tested 11 route surfaces for cross-user leakage. This is a twelfth
    // surface and a worse one: a leak here would not merely return a stranger's
    // note, it would SEND IT TO A THIRD PARTY. The stranger's note is a
    // byte-identical copy of the seed, so it would rank first if the corpus
    // were not scoped.
    const cluster = await sp.buildCluster(ids.sourdough, userId);
    const inContext = cluster.context.included.map((n) => n.noteId);
    expect(inContext).not.toContain(ids.stranger);
    expect(cluster.context.text).not.toContain('sp-stranger');
    expect(cluster.retrieval.docCount).toBe(Object.keys(NOTES).length);
  });

  test('the seed never retrieves itself as its own neighbour', async () => {
    // CLAUDE.md's first evaluation trap. The structural exclusion lives in
    // retrieval/index.js, and this is the check that it survives the trip
    // through the adapter into a prompt.
    const cluster = await sp.buildCluster(ids.sourdough, userId);
    const neighbours = cluster.context.included.filter((n) => n.role === 'neighbour');
    expect(neighbours.map((n) => n.noteId)).not.toContain(ids.sourdough);
    expect(cluster.context.included.filter((n) => n.noteId === ids.sourdough)).toHaveLength(1);
  });

  test('the retriever version and digest are RECORDED, not assumed', async () => {
    const cluster = await sp.buildCluster(ids.sourdough, userId);
    expect(cluster.retrieval.version).toBe(noteCorpus.APP_RETRIEVER);
    expect(cluster.retrieval.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the retriever is a PARAMETER — 5.7 varies it and gets a different cluster', async () => {
    const v4 = await sp.buildCluster(ids.sourdough, userId, { retriever: 'v4-bm25' });
    const v1 = await sp.buildCluster(ids.sourdough, userId, { retriever: 'v1-overlap' });

    expect(v1.retrieval.version).toBe('v1-overlap');
    expect(v4.retrieval.version).toBe('v4-bm25');
    expect(v1.retrieval.digest).not.toBe(v4.retrieval.digest);
    // The digest changing is the point; whether the ranking changes on four
    // notes is not something this suite should assert, because it would be an
    // assertion about the retrievers rather than about the parameter.
  });

  test('k is a parameter and bounds the neighbours', async () => {
    // Meaningful only because the baking cluster has MORE than one neighbour;
    // a cap of 1 over a list of length 1 would assert nothing.
    const uncapped = await sp.buildCluster(ids.sourdough, userId);
    expect(uncapped.context.included.filter((n) => n.role === 'neighbour').length).toBeGreaterThan(1);

    const capped = await sp.buildCluster(ids.sourdough, userId, { k: 1 });
    expect(capped.context.included.filter((n) => n.role === 'neighbour')).toHaveLength(1);
  });

  test('a tight budget drops neighbours and says which', async () => {
    const cluster = await sp.buildCluster(ids.sourdough, userId, { budget: 200 });
    expect(cluster.context.dropped.length).toBeGreaterThan(0);
    expect(cluster.context.included.some((n) => n.role === 'seed')).toBe(true);
    for (const d of cluster.context.dropped) expect(d.reason).toMatch(/budget/);
  });

  test('another user\'s note id returns null rather than a pack', async () => {
    expect(await sp.buildCluster(ids.stranger, userId)).toBeNull();
    expect(await sp.buildCluster(new mongoose.Types.ObjectId(), userId)).toBeNull();
  });

  test('the context digest is stable across two identical builds', async () => {
    const a = await sp.buildCluster(ids.sourdough, userId);
    const b = await sp.buildCluster(ids.sourdough, userId);
    expect(sp.contextDigest(a.context.text)).toBe(sp.contextDigest(b.context.text));
  });
});
