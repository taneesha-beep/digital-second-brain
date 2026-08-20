'use strict';

/**
 * judge-rubric.js — Phase 5.6. THE RUBRIC, and the only copy of it.
 *
 * PURE. No network, no key, no database, nothing under data/. It builds
 * strings; something else sends them.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS THE RUBRIC. results/gen-judge-rubric.txt IS A RENDERING OF IT.
 * ---------------------------------------------------------------------------
 *
 * ROADMAP 5.6's Done criterion is "the rubric is committed verbatim", and a
 * rubric that lives in two places is committed twice and verbatim nowhere. So
 * RUBRIC below is the text the model receives, character for character, and
 * `npm run judge:rubric -- --write` renders it into results/ for a reader.
 * tests/judge-rubric.test.js asserts the committed artifact still contains this
 * string exactly — the same discipline §32.7 records for the SLOTS
 * transcription: "a hand transcription that drifts produces a PLAUSIBLE RATE,
 * not an error, which is the failure mode that does not announce itself."
 *
 * A RUBRIC EDITED AFTER SEEING SCORES IS NOT A RUBRIC. This file is committed
 * before the first judge call, in its own commit, next to the predictions.
 *
 * ---------------------------------------------------------------------------
 * THREE LEVELS, AND WHY NOT TWO OR FIVE
 * ---------------------------------------------------------------------------
 *
 * TWO (supported / not) would collapse the interesting middle. §32.5 measured
 * the dominant regime as PARAPHRASE — a model asked to connect and contrast
 * writes abstractively — so the common case is an item whose subject is
 * genuinely in the passage while some assertion in it is not. Forcing that to
 * one pole invents a rate either way.
 *
 * FIVE would give the kappa a marginal distribution with cells of size 1 at
 * n=50 hand labels. Cohen's kappa is unstable there, and the agreement number
 * is the deliverable, not the resolution.
 *
 * THE HEADLINE RATE IS STILL BINARY — the share scoring 2 — and a binary kappa
 * is reported beside the three-level one for exactly that reason, so the
 * agreement figure quoted next to the rate is an agreement figure about the
 * same distinction the rate makes.
 *
 * ---------------------------------------------------------------------------
 * THE JUDGE NEVER LEARNS WHETHER THIS PASSAGE IS THE ONE THE ITEM CITED
 * ---------------------------------------------------------------------------
 *
 * Every item is judged twice under presentations that are byte-identical in
 * structure: once against the note it cited, once against a note from the SAME
 * prompt that it did not. The second is the null, and PRIMER §5.3a's rule is
 * that a score without one cannot be read at all.
 *
 * A null only works if the judge cannot tell the conditions apart, so the
 * prompt below carries NO label integer, NO other note from the pack, NO slot
 * name, NO seed id, and NO quintile — and the rubric says in terms that the
 * passage may or may not be the claim's origin. What reaches the model is one
 * passage and one claim. That is the whole of the blinding, and it is
 * structural rather than an instruction the model is trusted to follow.
 *
 * ---------------------------------------------------------------------------
 * WHAT A CLAIM IS: studypack-metrics.js's `claimText`, UNCHANGED
 * ---------------------------------------------------------------------------
 *
 * A flashcard's claim is `q + ' ' + a`; a concept's is `term + ' ' + definition`.
 * That is 5.4's unit and it is reused rather than redefined, so the thing this
 * phase judges and the thing §32.5 scored at 0.283 containment are THE SAME
 * OBJECT. Two metrics over two definitions of an item would not be comparable,
 * and rows 12 and 15 of the predictions exist to compare them.
 *
 * The rubric names which half carries the assertion — the answer, the
 * definition — because a question is not a claim and grading "is this question
 * supported" is a category error. Both halves are shown, since the answer is
 * often unreadable without its question.
 */

/**
 * THE RUBRIC. Sent as the system message, verbatim, on every judge call.
 */
const RUBRIC = `You grade whether a CLAIM is supported by a PASSAGE.

Judge the claim ONLY against the passage in front of you. Ignore anything you
know from elsewhere: a claim that is true in the world but absent from the
passage is not supported by it. The passage may or may not be where the claim
came from.

A claim has two parts. The first names what it is about; the second is the
assertion being graded. For a question-and-answer pair the answer is the
assertion. For a term-and-definition pair the definition is the assertion.

2 SUPPORTED   every factual assertion in the claim is stated in the passage, or
              follows directly from what the passage states.
1 PARTIAL     the passage is about the claim's subject and supports part of the
              assertion, but at least one part of it is not in the passage.
0 UNSUPPORTED the passage does not support the claim: it contradicts it, or it
              is about something else, or the substance of the assertion is
              simply absent.

Wording will differ. Judge meaning, not vocabulary: a correct paraphrase that
shares no words with the passage is still supported. A claim that only names a
topic the passage covers, without asserting what the passage asserts, is 1. A
passage that merely ASKS about the claim's subject without answering it does
not support an answer, and is 0.

Reply with exactly one line: a single digit 2, 1 or 0, then a space, then at
most 12 words of reason. No other text.`;

/**
 * The user message: one passage, one claim, nothing else.
 *
 * The order is PASSAGE then CLAIM deliberately. The alternative invites the
 * model to read the claim first and then scan the passage for confirmation,
 * which is the shape of confirmation bias and is what a groundedness judge is
 * supposed to resist.
 */
function buildUserMessage({ passageTitle, passageText, claim }) {
  return `PASSAGE\n${String(passageTitle || '').trim()}\n${String(passageText || '').trim()}\n\n` +
    `CLAIM\n${String(claim || '').trim()}\n\nVERDICT:`;
}

/**
 * Parse one verdict line.
 *
 * STRICT, AND A FAILURE IS COUNTED RATHER THAN REPAIRED. §30.6 settled this
 * shape for the study-pack parser: repairing a model's text can corrupt a
 * payload, and a repair that fires silently is a defect nothing can see. So
 * this reads a leading digit and nothing else, and `parseFailed` is a reported
 * rate in the report.
 *
 * The one accommodation is a leading <think> block: qwen/qwen3.6-27b emits its
 * reasoning INLINE in the message content rather than in
 * completion_tokens_details.reasoning_tokens, which is undefined for it. The
 * run disables reasoning, so this should never fire — and if it does, it is a
 * silent change in provider behaviour, so `sawThinkBlock` is recorded and
 * reported rather than absorbed. §28.9's class: the model is the one input with
 * no checksum.
 */
function parseVerdict(rawText) {
  const raw = String(rawText == null ? '' : rawText);
  const sawThinkBlock = /<think>/i.test(raw);
  const afterThink = raw.replace(/^[\s\S]*?<\/think>/i, '');
  const line = afterThink.trim().split('\n').find((l) => l.trim() !== '');
  const m = line ? /^\s*([012])(?:\b|$)/.exec(line) : null;
  return {
    level: m ? Number(m[1]) : null,
    reason: m ? line.slice(m[0].length).trim().slice(0, 200) : null,
    parseFailed: !m,
    sawThinkBlock
  };
}

const LEVELS = [0, 1, 2];
const LEVEL_NAMES = { 0: 'UNSUPPORTED', 1: 'PARTIAL', 2: 'SUPPORTED' };

/** The headline rate's cut. Binary collapse: 2 is grounded, 1 and 0 are not. */
const GROUNDED_LEVEL = 2;
const toBinary = (level) => (level === null ? null : level === GROUNDED_LEVEL ? 1 : 0);

module.exports = {
  RUBRIC,
  LEVELS,
  LEVEL_NAMES,
  GROUNDED_LEVEL,
  buildUserMessage,
  parseVerdict,
  toBinary
};
