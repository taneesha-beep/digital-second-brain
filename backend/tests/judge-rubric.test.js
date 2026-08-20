'use strict';

/**
 * judge-rubric.test.js — Phase 5.6.
 *
 * PURE: no network, no key, no database, nothing under data/.
 *
 * ROADMAP 5.6's Done criterion is "the rubric is committed verbatim", and this
 * suite is what makes that claim checkable rather than asserted. The rubric
 * lives in scripts/lib/judge-rubric.js — the copy the model receives — and
 * results/gen-judge-rubric.txt renders it for a reader. A rendering that drifts
 * from the thing it renders is the failure mode §32.7 names for the SLOTS
 * transcription: it produces a PLAUSIBLE artifact rather than an error, and
 * nothing announces it.
 *
 * The other half of this suite pins the BLINDING. The judge is not supposed to
 * be able to tell a cited passage from a distractor, and that is a property of
 * the string that gets sent — so it is testable, and it is the one property
 * that, if it broke, would make every number in section B meaningless while
 * still producing a full set of plausible verdicts.
 */

const fs = require('fs');
const path = require('path');

const { RUBRIC, buildUserMessage, LEVELS, LEVEL_NAMES, GROUNDED_LEVEL } = require('../scripts/lib/judge-rubric');

const REPO = path.resolve(__dirname, '..', '..');
const ARTIFACT = path.join(REPO, 'results', 'gen-judge-rubric.txt');

describe('the committed rubric is the rubric that runs', () => {
  const present = fs.existsSync(ARTIFACT);
  const maybe = present ? test : test.skip;

  maybe('results/gen-judge-rubric.txt contains the system message VERBATIM', () => {
    expect(fs.readFileSync(ARTIFACT, 'utf8')).toContain(RUBRIC);
  });

  maybe('the artifact is not merely a description — it holds every rubric level', () => {
    const text = fs.readFileSync(ARTIFACT, 'utf8');
    for (const level of LEVELS) {
      expect(text).toContain(`${level} ${LEVEL_NAMES[level]}`);
    }
  });
});

describe('the rubric states the three levels it is scored on', () => {
  test.each(LEVELS)('level %i appears with its name', (level) => {
    expect(RUBRIC).toContain(`${level} ${LEVEL_NAMES[level]}`);
  });

  test('there are exactly three levels and the top one is the headline cut', () => {
    expect(LEVELS).toEqual([0, 1, 2]);
    expect(GROUNDED_LEVEL).toBe(2);
  });

  test('it names which half of a two-part claim carries the assertion', () => {
    // A question is not a claim. Grading "is this question supported" is a
    // category error, and the claim unit is q + a — 5.4's claimText, reused.
    expect(RUBRIC).toMatch(/answer is the\s+assertion/);
    expect(RUBRIC).toMatch(/definition is the assertion/);
  });

  test('it tells the judge to grade meaning rather than vocabulary', () => {
    // §32.5 measured the dominant regime as PARAPHRASE. A rubric that rewarded
    // word overlap would reproduce the lexical support metric with an API bill
    // attached instead of measuring something it cannot.
    expect(RUBRIC).toContain('Judge meaning, not vocabulary');
  });

  test('it forbids judging from outside the passage', () => {
    expect(RUBRIC).toMatch(/Ignore anything you\s+know from elsewhere/);
  });

  test('it fixes the output shape so a verdict can be parsed strictly', () => {
    expect(RUBRIC).toContain('exactly one line');
  });
});

describe('the blinding is a property of the string that gets sent', () => {
  const resolved = {
    passageTitle: 'How do I keep cookies chewy?',
    passageText: 'Chill the dough and raise the brown sugar ratio.',
    claim: 'Resting dough Chilling the dough before baking produces a chewier cookie.'
  };

  test('the user message carries exactly one passage and one claim', () => {
    const msg = buildUserMessage(resolved);
    expect(msg.match(/PASSAGE/g)).toHaveLength(1);
    expect(msg.match(/CLAIM/g)).toHaveLength(1);
  });

  test('PASSAGE COMES BEFORE CLAIM', () => {
    // The other order invites the model to read the claim first and then scan
    // for confirmation, which is the shape of confirmation bias and the thing
    // a groundedness judge exists to resist.
    const msg = buildUserMessage(resolved);
    expect(msg.indexOf('PASSAGE')).toBeLessThan(msg.indexOf('CLAIM'));
  });

  test('NO CITATION LABEL REACHES THE MODEL', () => {
    // If the integer the generator emitted appeared here, the judge could
    // condition on provenance and the null would stop being a null — while
    // still returning a full set of perfectly plausible verdicts.
    const msg = buildUserMessage({ ...resolved, passageLabel: 3, citedLabel: 3 });
    expect(msg).not.toMatch(/\[3\]/);
    expect(msg).not.toMatch(/source/i);
    expect(msg).not.toMatch(/cited/i);
    expect(msg).not.toMatch(/label/i);
  });

  test('the two conditions are STRUCTURALLY IDENTICAL at the input', () => {
    // The only thing that differs between a cited call and a null call is
    // which note's text was pasted in. Anything else — an extra field, a
    // different heading, even a trailing marker — would leak the condition.
    const cited = buildUserMessage({ ...resolved, passageText: '<<<the cited note>>>' });
    const nulled = buildUserMessage({ ...resolved, passageText: '<<<a distractor>>>' });
    expect(cited.replace('<<<the cited note>>>', 'X')).toBe(nulled.replace('<<<a distractor>>>', 'X'));
  });

  test('the rubric tells the model the passage may not be the origin', () => {
    expect(RUBRIC).toMatch(/may or may not be where the claim\s+came from/);
  });

  test('no other note from the pack can reach the message', () => {
    const msg = buildUserMessage(resolved);
    expect(msg).not.toContain('Title 2');
    expect(msg.split('PASSAGE')).toHaveLength(2);
  });

  test('missing fields render as empty rather than "undefined"', () => {
    const msg = buildUserMessage({});
    expect(msg).not.toContain('undefined');
    expect(msg).not.toContain('null');
  });
});
