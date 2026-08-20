'use strict';

/**
 * studyPack.service.js — Phase 5.1. THE JOIN.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, IN ONE LINE: the first code path in this repository where a
 * measured retriever's output reaches a language model.
 *
 * ROADMAP's Phase 5 header states the gap in terms: `routes/llm.js:15` does
 * `Note.findOne({_id, user})` and `:29` passes `note.contentText` alone, so the
 * prompt template's `Notes:` plural at `llm.service.js:114` is a lie — it is one
 * note. Three phases of retrieval work (six rungs, a closed ladder, a shipped
 * v4-bm25) never touched generation. This file is that join, and the `Notes:`
 * separator below is kept deliberately because here it is finally TRUE.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE FILE AND services/llm.service.js IS NOT EDITED AT ALL
 *
 * The five single-note features are 5.1's A/B control, and the control is
 * enforced in code rather than remembered. tests/gen-shipped-parity.test.js
 * asserts `Object.keys(live.PROMPTS).sort()` equals EXACTLY the five feature
 * names, and that `Object.keys(SCHEMAS)` equals `STRIPPED_FEATURES` exactly. So
 * adding a sixth prompt to llm.service.js, or a `studyPack` entry to
 * gen-schema.js, turns that suite red ON THE SHAPE — before any question about
 * wording arises. That is the right behaviour: `results/gen-baseline.txt` and
 * `results/gen-v2.txt` are measurements OF those five prompts, and the true
 * gen-v1 is permanently unmeasurable (§28.12), so there is no re-baselining.
 *
 * MODEL, TEMPERATURE and MAX_TOKENS are IMPORTED rather than restated, so there
 * is still one model string in this repository and `npm run gen:probe` still
 * covers the one the app asks for. An import changes no source text and no
 * exported value, so the parity suite does not see it.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * MAX_TOKENS IS INHERITED, NOT DERIVED, AND THAT IS SAID RATHER THAN IMPLIED.
 *
 * §29.2 argues 2048 as SMALLEST-SUFFICIENT from measured `examQs` demand. No
 * such measurement exists for a study pack — it has never been run. Inheriting
 * the shipped ceiling is the one-variable choice; the alternative is picking a
 * number by feel, which is exactly what §29.2's method exists to avoid. What
 * makes the inheritance safe to state is that `finishReason` is returned on
 * every response from the first call onward, so if 2048 binds, it is visible
 * immediately rather than after a phase of silent truncation — which is the
 * defect §28.3 records for the whole of 5.3.
 */

const crypto = require('crypto');
const Groq = require('groq-sdk');

const Note = require('../models/Note');
const retrieval = require('../retrieval');
const { loadNoteCorpus, APP_RETRIEVER, LINK_CAP } = require('./noteCorpus.service');
const { MODEL, TEMPERATURE, MAX_TOKENS } = require('./llm.service');

/**
 * THE TOKEN ESTIMATOR, FITTED ON THIS PROJECT'S OWN LEDGER RATHER THAN ASSUMED.
 *
 * A context budget needs a token count and this repository has no tokenizer —
 * adding one would be the first new dependency in nine phases, for a number
 * that can be measured instead.
 *
 * `results/gen-v2.calls.jsonl` carries 79 completed calls with their actual
 * `promptTokens`, and the exact text of each prompt is reconstructible from
 * `data/gen-eval/clusters.jsonl` plus the exported prompts. Least squares over
 * those 79 points:
 *
 *     tokens = 76.4 + chars x 0.20898     R2 0.976, resid sd 8.9, err -8.3%..+5.3%
 *
 * A BUDGET NEEDS A BOUND, NOT A POINT ESTIMATE, so the fit is not what ships.
 * `90 + ceil(chars / 4.5)` NEVER UNDERESTIMATES on any of those 79 points (min
 * +1 token) and overestimates by 10.4% on average. tests/studypack.context.test.js
 * re-runs that check against the committed ledger, so it is a test rather than a
 * claim — and it fails if a future run's rows break the bound.
 *
 * WHAT IT IS NOT: this is calibrated on 79 single-note prompts of one shape
 * (English cooking prose, this model's tokenizer). A cluster prompt is ~10x
 * longer, so this extrapolates. The extrapolation is checkable for free —
 * `estimatedPromptTokens` is reported beside the API's `actualPromptTokens` on
 * every response, so the estimator's error is measured on every call and nobody
 * has to trust this paragraph.
 */
const TOKENIZER_OVERHEAD = 90;
const CHARS_PER_TOKEN = 4.5;

/** Characters -> tokens, for one span of text. No per-request overhead. */
function textTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

/** A whole user-visible request: the chat scaffolding plus every character in it. */
function estimateTokens(text) {
  return TOKENIZER_OVERHEAD + textTokens(text);
}

/**
 * THE BUDGET, AND IT IS SET BY THE RATE LIMIT RATHER THAN BY THE CONTEXT WINDOW.
 *
 * `openai/gpt-oss-120b` takes far more than this. The binding constraint is
 * §29.6's finding: the per-minute token limit is charged on what a call
 * RESERVES, `prompt + max_tokens`, however little the model writes. At 1800 +
 * 2048 = ~3850 reserved, 8000/min buys ~2 calls per minute and the 200,000/day
 * organisation cap buys ~52 study packs per day.
 *
 * Measured against the golden set for scale: a cluster of a seed plus 8
 * neighbours averages 1,001 words, p95 1,473, max 2,058 — against a seed alone
 * at 100 words. The cluster is 10.0x the note.
 */
const CONTEXT_TOKEN_BUDGET = 1800;

/**
 * Counts held IDENTICAL to the single-note prompts — `llm.service.js` asks for
 * 6 flashcards and 8 concepts, and so does this.
 *
 * It costs nothing and removes one variable from the eventual gen-v1 vs gen-v5
 * comparison. §28.2 recorded that comparison as confounded with INPUT LENGTH;
 * this keeps the confound to the list of things actually chosen — input, the
 * citation field, one combined call, and this file's system message — rather
 * than adding item counts to it for no reason.
 */
const FLASHCARD_COUNT = 6;
const CONCEPT_COUNT = 8;

/**
 * ONE CALL RETURNING BOTH ARRAYS, NOT TWO CALLS.
 *
 * Quota is the binding constraint of this whole phase and the expensive half of
 * a study pack is the PROMPT — the cluster is sent once either way, so two calls
 * pay for it twice and halve the daily budget from ~52 packs to ~26. It also
 * makes "one study pack" one latency and one cost figure rather than a sum of
 * two, which is what 5.4 has to report against 6.5's budget.
 */
const STUDY_PACK_SYSTEM_MESSAGE =
  'You are a helpful study assistant. Follow the user instructions exactly. ' +
  'When asked for JSON, return ONLY the JSON object — no extra text, no markdown fences.';

/**
 * The prompt. Numbered notes, and every item must name the number it came from.
 *
 * WHY THE MODEL EMITS THE CITATION AND THIS FILE DOES NOT ASSIGN IT. The
 * alternative that still spans the cluster is post-hoc matching of each item to
 * its best lexically-overlapping note — which is precisely 5.4's citation-support
 * METRIC used as the assignment RULE. It would make that metric 100% by
 * construction and measuring nothing. It is also the move
 * `linker.service.js:130-136` already refuses for `sharedKeywords`: "a lexical
 * overlap computed beside a BM25 hit is a post-hoc rationalisation, not the
 * reason the document ranked."
 *
 * So the failure mode chosen is HALLUCINATED OR MIS-ATTRIBUTED CITATIONS THAT
 * ARE VISIBLE AND COUNTABLE, over citations correct by construction and inert.
 * An out-of-range label is mechanically detectable — that is 5.4's citation
 * validity. A valid label on a claim the note does not support is not, and that
 * is 5.4's citation support, which is the interesting one.
 *
 * SMALL INTEGERS RATHER THAN OBJECT IDS, AND THIS NARROWS SOMETHING. A 24-hex
 * ObjectId costs ~10 tokens per item against ~1 for an integer, over 14 items,
 * and a model copies a small integer more reliably. The cost: 5.4's
 * citation-validity will mostly measure OUT-OF-RANGE labels rather than
 * FABRICATED identifiers, which is an easier test than raw ids would be. The
 * mis-attribution mode is untouched by the labelling.
 */
function buildPrompt(noteCount) {
  return (
    `You are building a study pack from ${noteCount} related notes, shown below and numbered.\n\n` +
    `Generate ${FLASHCARD_COUNT} flashcard Q&A pairs and ${CONCEPT_COUNT} key concepts that draw on ` +
    'the notes AS A CLUSTER — prefer items that connect or contrast two notes over items that ' +
    'restate one.\n\n' +
    'EVERY item must carry a "source" field: the number of the note it came from. Use only the ' +
    'numbers shown above. Never invent a number.\n\n' +
    'Return ONLY a valid JSON object — no markdown, no code fences, no explanation, nothing else. ' +
    'Format exactly: {"flashcards":[{"q":"question","a":"answer","source":1}],' +
    '"concepts":[{"term":"term","definition":"one sentence definition","source":1}]}'
  );
}

/** One note as the model sees it. The label is what a citation refers to. */
function renderNote(label, doc) {
  return `[${label}] ${doc.title || 'Untitled'}\n${doc.body || ''}`;
}

/**
 * ASSEMBLE THE CONTEXT, AND CUT WHOLE NOTES FROM THE TAIL OF THE RANKED LIST.
 *
 * THE TRUNCATION STRATEGY, WHICH 5.1'S DONE CRITERION ASKS TO BE DOCUMENTED:
 *
 *   1. The SEED is always included, whole, and is always label [1]. It is the
 *      note the user is looking at; a study pack that dropped it would be about
 *      something else. If the seed alone exceeds the budget it is still included
 *      and zero neighbours are admitted — recorded as `budgetExceededBySeed`.
 *   2. Neighbours are admitted in the retriever's RANK ORDER while they fit,
 *      whole. The first that does not fit is dropped along with every lower-
 *      ranked note after it.
 *   3. NOTHING IS EVER CUT MID-NOTE.
 *
 * WHY WHOLE NOTES AND NOT THE TAIL OF EACH — the reason is citations, not
 * tidiness. Every generated item cites a note. If a body is truncated, an item
 * can cite a note whose supporting sentence was never in the prompt, and 5.4's
 * citation-support metric (lexical overlap between claim and cited note) would
 * then compare the claim against text the model never saw. Whole-note admission
 * keeps THE UNIT OF CITATION IDENTICAL TO THE UNIT OF CONTEXT. Dropping from the
 * tail also means the RETRIEVER chooses what goes, not this file.
 *
 * THE COST, STATED: one very long rank-1 neighbour can starve every note below
 * it. The largest neighbour in the golden set is 545 words (~700 tokens) against
 * an 1800-token budget, so it does not bind on that corpus — but a real notebook
 * has no such bound, and `dropped` is reported so a caller can see it happen.
 */
function assembleContext(seedDoc, neighbourHits, docsById, budget = CONTEXT_TOKEN_BUDGET) {
  const seedRendered = renderNote(1, seedDoc);
  const included = [{
    label: 1,
    noteId: String(seedDoc.id),
    title: seedDoc.title || 'Untitled',
    role: 'seed',
    rank: null,
    score: null,
    tokens: textTokens(seedRendered)
  }];
  const dropped = [];
  const parts = [seedRendered];

  // The fixed cost every request pays whatever the cluster is: the system
  // message, the instruction block, and the separator. Budgeted for FIRST, so a
  // note is never admitted against room the template had already spent.
  const scaffolding = STUDY_PACK_SYSTEM_MESSAGE + buildPrompt(1 + neighbourHits.length) + '\n\nNotes:\n';
  let used = TOKENIZER_OVERHEAD + textTokens(scaffolding) + textTokens(seedRendered);
  const budgetExceededBySeed = used > budget;

  let label = 2;
  let full = budgetExceededBySeed;

  for (const hit of neighbourHits) {
    const doc = docsById.get(String(hit.docId));
    if (!doc) continue; // deleted between index build and this call

    const rendered = renderNote(label, doc);
    const cost = textTokens(rendered);
    const record = {
      noteId: String(doc.id),
      title: doc.title || 'Untitled',
      rank: hit.rank,
      score: hit.score,
      tokens: cost
    };

    // ONCE FULL, EVERYTHING BELOW IS DROPPED — the loop does not keep trying
    // smaller notes further down the list. Admitting a rank-7 note that happens
    // to be short after refusing rank 4 would reorder the cluster by LENGTH,
    // which is not a relevance judgment and is not the retriever's.
    if (full || used + cost > budget) {
      full = true;
      dropped.push({ ...record, label: null, reason: budgetExceededBySeed ? 'seed-exceeds-budget' : 'budget' });
      continue;
    }

    used += cost;
    parts.push(rendered);
    included.push({ ...record, label, role: 'neighbour' });
    label += 1;
  }

  return {
    text: parts.join('\n\n'),
    included,
    dropped,
    budgetTokens: budget,
    estimatedTokens: used,
    budgetExceededBySeed
  };
}

/**
 * Build the cluster for one note: the seed, the retriever's neighbours, the
 * assembled context, and the provenance of all three.
 *
 * NO NETWORK AND NO KEY. Split from the generation call deliberately, so the
 * join this phase exists to make — retrieval output reaching a prompt — is
 * testable against a real database WITHOUT SPENDING QUOTA. That is what
 * tests/studypack.cluster.test.js does.
 *
 * THE RETRIEVER IS A PARAMETER AND ITS VERSION IS RECORDED, WHICH IS 5.7's
 * REQUIREMENT ARRIVING EARLY. 5.7 runs this against v1-overlap and against the
 * shipped v4-bm25 with prompts fixed, so a hardcoded version would make that
 * phase a rewrite. It is deliberately NOT exposed over HTTP: an untrusted input
 * selecting a retriever could name v5-embeddings, which needs per-note vectors
 * that do not exist. 5.7 calls this function directly, the same way 5.3 and 5.5
 * call the generator directly rather than over HTTP.
 *
 * PROVENANCE COMES FROM describe(handle) — the thing that produced the ranking —
 * rather than from the version constant this function was asked for. Same rule,
 * and the same reason, as `linker.service.js:125`.
 */
async function buildCluster(noteId, userId, { retriever = APP_RETRIEVER, k = LINK_CAP, budget = CONTEXT_TOKEN_BUDGET } = {}) {
  const note = await Note.findOne({ _id: noteId, user: userId }).lean();
  if (!note) return null;

  const docs = await loadNoteCorpus(userId);
  const docsById = new Map(docs.map((d) => [d.id, d]));
  const id = String(note._id);
  const seedFromCorpus = docsById.get(id);

  // THE SEED CAN BE OUTSIDE THE CORPUS SLICE AND THAT IS NOT AN ERROR.
  // utils/corpus.js caps a user at 500 notes, so note 501 is owned, readable and
  // absent from the index — and retrieval.search() REJECTS a query id that is
  // not in the index rather than scoring it (retrieval/index.js:191). Degrading
  // to a seed-only pack is right: the feature still works, it is honest about
  // having no neighbours, and the reason is reported instead of surfacing as an
  // exception from a layer the user never hears about.
  const seedDoc = seedFromCorpus || { id, title: note.title || '', body: note.contentText || '' };

  let hits = [];
  let provenance = null;
  let reason = null;

  if (seedFromCorpus) {
    const handle = retrieval.index(retriever, docs, {});
    provenance = retrieval.describe(handle);
    hits = retrieval.search(handle, id, k).map((hit, i) => ({ ...hit, rank: i + 1 }));
  } else {
    reason = 'seed outside the corpus slice — no neighbours retrieved';
  }

  const context = assembleContext(seedDoc, hits, docsById, budget);

  return {
    seed: { noteId: id, title: note.title || 'Untitled' },
    context,
    retrieval: {
      version: provenance ? provenance.version : null,
      digest: provenance ? provenance.digest : null,
      docCount: provenance ? provenance.docCount : docs.length,
      k,
      retrieved: hits.length,
      reason
    }
  };
}

/**
 * PARSE, WITHOUT REPRODUCING THE STRIP THIS PROJECT MEASURED AT ZERO.
 *
 * `llm.service.js:126` strips markdown fences with two unanchored global
 * regexes. §28.4 measured that strip firing ZERO times in 90 JSON calls on this
 * model, and tests/gen-shipped-parity.test.js pins its known defect: a fence
 * inside a string VALUE is deleted from content.
 *
 * So this file does not strip. It PARSES: strict `JSON.parse` first, and if that
 * throws, one attempt at the outermost `{...}` span. That is a decision about
 * where JSON begins and ends rather than a mutation of the model's text, so it
 * cannot corrupt a payload the way an unanchored replace can — and
 * `usedFallbackParse` is reported, so if a fence ever does appear on this
 * surface it is COUNTED rather than silently absorbed. Building the strip here
 * would be a repair for a defect measured at 0.0%.
 */
function parseStudyPackJson(rawText) {
  const text = String(rawText || '').trim();
  try {
    return { value: JSON.parse(text), usedFallbackParse: false, parseError: null };
  } catch (first) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return { value: JSON.parse(text.slice(start, end + 1)), usedFallbackParse: true, parseError: null };
      } catch (second) {
        return { value: null, usedFallbackParse: true, parseError: second.message };
      }
    }
    return { value: null, usedFallbackParse: false, parseError: first.message };
  }
}

/**
 * Resolve every item's citation against the context THAT WAS ACTUALLY SENT.
 *
 * INVALID ITEMS ARE KEPT AND FLAGGED, NEVER DROPPED AND NEVER REPAIRED.
 * Dropping them would make citation validity 100% at the API surface — the
 * defect would still be there and no number could see it, which is §22.6's shape
 * and the exact reason `eli5`'s prose truncation went unnoticed (§28.5).
 * Repairing them by picking a best-overlap note is the post-hoc assignment
 * `buildPrompt` above rejects.
 *
 * `citation` takes one of three values and they are not interchangeable:
 *   valid           the label is an integer in range; sourceNoteId is set
 *   out-of-range    the model named a note that was not in the context
 *   missing         the model emitted no usable `source` at all
 */
function resolveCitations(items, included, requiredKeys) {
  const byLabel = new Map(included.map((n) => [n.label, n]));

  return items.map((item) => {
    const raw = item && item.source;
    const label = Number.isInteger(raw) ? raw : Number.isInteger(Number(raw)) && String(raw).trim() !== '' ? Number(raw) : null;
    const note = label === null ? null : byLabel.get(label);
    const missingKeys = requiredKeys.filter((key) => typeof item[key] !== 'string' || item[key].trim() === '');

    return {
      ...item,
      source: label,
      sourceNoteId: note ? note.noteId : null,
      sourceTitle: note ? note.title : null,
      citation: note ? 'valid' : label === null ? 'missing' : 'out-of-range',
      // A wrong SHAPE and a wrong CITATION are two different defects and are
      // reported as two fields. Folding them into one flag would make a study
      // pack with perfect citations and no answers look like the same failure
      // as one with answers and no citations.
      complete: missingKeys.length === 0,
      missingKeys
    };
  });
}

/**
 * The generation call. Mirrors `llm.service.js` in the two things that matter —
 * one serial call, and an error that CARRIES ITS STATUS FORWARD.
 *
 * The status carry-forward is §29.6's second defect, and it is reproduced here
 * on purpose rather than left out: the 5.5 harness burned 21 attempts into a
 * rate limit because every SDK error arrived as a sentence with no `status` to
 * branch on. Any future harness driving this function needs to stop on the first
 * 429, and that is only possible if the field survives translation.
 */
async function generate(contextText, noteCount) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing GROQ_API_KEY — add it to backend/.env and restart the server. ' +
      'Get a free key at console.groq.com'
    );
  }

  const groq = new Groq({ apiKey });
  const prompt = buildPrompt(noteCount);
  const startedAt = Date.now();

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: STUDY_PACK_SYSTEM_MESSAGE },
        { role: 'user', content: `${prompt}\n\nNotes:\n${contextText}` }
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS
    });

    const choice = completion.choices?.[0] || {};
    const usage = completion.usage || {};

    return {
      rawText: choice.message?.content || '',
      model: completion.model || MODEL,
      finishReason: choice.finish_reason ?? null,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
      totalTokens: usage.total_tokens ?? null
    };
  } catch (err) {
    const e = new Error(mapErrorMessage(String(err.message || '')));
    e.status = err.status ?? null;
    e.code = (err.error && err.error.error && err.error.error.code) || err.code || null;
    e.cause = err;
    throw e;
  }
}

function mapErrorMessage(msg) {
  if (msg.includes('401') || msg.includes('invalid_api_key')) {
    return 'Invalid Groq API key — check GROQ_API_KEY in your .env file';
  }
  if (msg.includes('429') || msg.includes('rate_limit')) {
    return 'Groq rate limit hit — wait a few seconds and try again';
  }
  if (msg.includes('503') || msg.includes('unavailable')) {
    return 'Groq service temporarily unavailable — try again in a moment';
  }
  if (msg.includes('404') || msg.includes('model_not_found')) {
    return `Groq model "${MODEL}" is not available to this key — it may have been ` +
      'retired. Run `npm run gen:probe` to see which models the key can reach.';
  }
  return `Study pack generation failed: ${msg}`;
}

/**
 * The whole feature: cluster, generate, resolve citations, report what happened.
 *
 * EVERYTHING NEEDED TO AUDIT THE CALL IS IN THE RESPONSE, which is the opposite
 * of the position §28.3 records for `processNote()` before 5.5: it returned the
 * text and discarded `usage` and `finish_reason`, so tokens and truncation were
 * unmeasurable through the only surface the app had, and 5.3 had to measure a
 * frozen copy instead. A new surface starts observable rather than acquiring
 * observability two phases later.
 */
async function buildStudyPack(noteId, userId, options = {}) {
  const cluster = await buildCluster(noteId, userId, options);
  if (!cluster) return null;

  const noteCount = cluster.context.included.length;
  const observation = await generate(cluster.context.text, noteCount);
  const parsed = parseStudyPackJson(observation.rawText);

  const rawFlashcards = Array.isArray(parsed.value?.flashcards) ? parsed.value.flashcards : [];
  const rawConcepts = Array.isArray(parsed.value?.concepts) ? parsed.value.concepts : [];

  const flashcards = resolveCitations(rawFlashcards, cluster.context.included, ['q', 'a']);
  const concepts = resolveCitations(rawConcepts, cluster.context.included, ['term', 'definition']);
  const items = [...flashcards, ...concepts];

  return {
    seed: cluster.seed,
    flashcards,
    concepts,
    context: {
      notes: cluster.context.included,
      dropped: cluster.context.dropped,
      budgetTokens: cluster.context.budgetTokens,
      estimatedPromptTokens: cluster.context.estimatedTokens,
      actualPromptTokens: observation.promptTokens,
      // The estimator checking itself, on every call, for free. Positive means
      // the bound held. §5.1's paragraph on TOKENIZER_OVERHEAD says why this is
      // reported rather than asserted.
      estimatorSlackTokens:
        Number.isFinite(observation.promptTokens)
          ? cluster.context.estimatedTokens - observation.promptTokens
          : null,
      budgetExceededBySeed: cluster.context.budgetExceededBySeed
    },
    retrieval: cluster.retrieval,
    generation: {
      model: observation.model,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
      finishReason: observation.finishReason,
      latencyMs: observation.latencyMs,
      completionTokens: observation.completionTokens,
      reasoningTokens: observation.reasoningTokens,
      totalTokens: observation.totalTokens,
      usedFallbackParse: parsed.usedFallbackParse,
      parseError: parsed.parseError
    },
    citations: {
      items: items.length,
      expected: FLASHCARD_COUNT + CONCEPT_COUNT,
      valid: items.filter((i) => i.citation === 'valid').length,
      outOfRange: items.filter((i) => i.citation === 'out-of-range').length,
      missing: items.filter((i) => i.citation === 'missing').length,
      // Distinct notes cited at least once. A pack that cites only the seed is
      // a pack that did not use the cluster, and no conformance metric would
      // otherwise say so.
      notesCited: new Set(items.map((i) => i.sourceNoteId).filter(Boolean)).size,
      notesInContext: noteCount
    }
  };
}

/** SHA-256 over the assembled context, so two runs can be shown identical. */
function contextDigest(contextText) {
  return crypto.createHash('sha256').update(String(contextText)).digest('hex');
}

module.exports = {
  buildStudyPack,
  buildCluster,
  /**
   * EXPORTED FOR PHASE 5.4 AND NOTHING ELSE CHANGED IN THIS FILE.
   *
   * scripts/run-studypack-eval.js drives the 30 golden seeds, which are Stack
   * Exchange documents with neighbours already stamped at 5.2 — there is no
   * note id, no user id and no database, so `buildStudyPack` cannot be the
   * entry point. It calls `assembleContext` and then this.
   *
   * EXPORTED RATHER THAN REIMPLEMENTED IN THE SCRIPT. A second copy of this
   * call would be a SECOND hardcoded model string, which is §28.9's defect —
   * "the model is the one input with no checksum" — built on purpose, and
   * `npm run gen:probe` would stop covering everything the project asks for.
   * §29.4 records the same reasoning from the other side: gen-v2 measures the
   * live function where gen-v1 measured a frozen copy, and calls that the
   * stronger position. gen-v5 starts there.
   *
   * Additive: no behaviour changes and no caller changes.
   */
  generate,
  assembleContext,
  parseStudyPackJson,
  resolveCitations,
  estimateTokens,
  textTokens,
  buildPrompt,
  renderNote,
  contextDigest,
  CONTEXT_TOKEN_BUDGET,
  TOKENIZER_OVERHEAD,
  CHARS_PER_TOKEN,
  FLASHCARD_COUNT,
  CONCEPT_COUNT,
  STUDY_PACK_SYSTEM_MESSAGE
};
