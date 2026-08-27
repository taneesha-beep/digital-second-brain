'use strict';

const mongoose = require('mongoose');

/**
 * objectId.js — the pre-Phase-8 sweep, 27 Aug 2026.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT: A MALFORMED ID IN THE URL WAS A 500 ON EVERY ID-TAKING ENDPOINT.
 * ---------------------------------------------------------------------------
 *
 * `Note.findOne({_id: 'banana'})` throws a mongoose CastError, every handler's
 * catch maps every failure to 500, and the caller gets "Error fetching note" —
 * a server-error status for a client-error cause.
 *
 * MEASURED BEFORE IT WAS FIXED, by driving each route with a malformed id
 * against a real database: **12 of 12 id-taking endpoints across 5 routers**
 * returned 500. Not one of them returned what it returns for a note that is
 * simply absent. It was found while deleting the duplicate graph endpoint,
 * because that removal made `/api/notes/graph` fall through to `/:id` and
 * land on exactly this path.
 *
 * ---------------------------------------------------------------------------
 * WHY IT ANSWERS WITH THE ROUTE'S OWN NOT-FOUND RESPONSE, NOT WITH A 400
 * ---------------------------------------------------------------------------
 *
 * A 400 "malformed id" is the more literal HTTP answer and it was rejected on
 * this repository's own isolation discipline. These routes deliberately return
 * **404 rather than 403** for a note belonging to someone else, so that
 * existence is never leaked (`tests/integration.app.test.js`, cross-user
 * isolation, 11 surfaces). Introducing a distinguishable third response would
 * add a class of reply that says something about the shape of the id space,
 * on endpoints designed to say as little as possible.
 *
 * So each router supplies the status and message IT already uses for a missing
 * note, and a malformed id becomes indistinguishable from an absent one:
 *
 *     notes.js    404  Note not found
 *     graph.js    404  Note not found or access denied
 *     export.js   404  Note not found
 *     llm.js      400  Note not found or access denied
 *     studyPack   400  Note not found or access denied
 *
 * The two 400s are NOT a mistake being propagated — those routers already
 * answer 400 for a missing note, and the point of this file is uniformity
 * WITHIN a route, not across the app. Changing llm.js's choice would be a
 * second variable.
 *
 * ---------------------------------------------------------------------------
 * IT IS A `router.param` HANDLER, WHICH IS THE PART THAT MAKES IT HOLD
 * ---------------------------------------------------------------------------
 *
 * Registered once per router per parameter name, it runs for EVERY route using
 * that parameter — including routes added later. A per-handler `if` would have
 * to be remembered twelve times and then again by whoever adds the thirteenth,
 * which is how the original defect reached twelve endpoints in the first place.
 *
 * ⚠️ IT RUNS AFTER `router.use` MIDDLEWARE, WHICH IS REQUIRED HERE RATHER THAN
 * INCIDENTAL. `protect` and the rate limiters are mounted with `router.use`, so
 * a refused id is still authenticated and still COUNTED against the limiter.
 * `results/rate-limit-verification.txt` was produced by hitting a nonexistent
 * note id precisely because the limiter counts before the handler answers; if
 * this file short-circuited earlier, that artifact's method would silently stop
 * working. A test asserts the ordering rather than trusting this paragraph.
 *
 * ---------------------------------------------------------------------------
 * ON `isValid`, BECAUSE IT HAS A FAMOUS TRAP AND THE TRAP IS GONE
 * ---------------------------------------------------------------------------
 *
 * `ObjectId.isValid` historically accepted ANY 12-character string, casting it
 * bytewise — so `'123456789012'` was "valid" and cast to an id that is not the
 * string you passed. VERIFIED on the mongoose in this repo rather than
 * inherited from folklore: `isValid('123456789012')` is now **false**, and for
 * a string input it requires 24 hex characters. Route params are always
 * strings, so that is the whole input domain here.
 *
 * The round-trip check is kept anyway. It costs nothing, it is true of every id
 * this application has ever generated, and it does not depend on a library
 * version's current strictness — which is the property that changed.
 */
function isCanonicalObjectId(value) {
  if (typeof value !== 'string') return false;
  if (!mongoose.Types.ObjectId.isValid(value)) return false;
  // The identity that makes it canonical: casting and stringifying returns the
  // same id. Anything mongoose would accept but silently TRANSFORM is not an id
  // this app stored.
  //
  // ⚠️ CASE-INSENSITIVE, AND THE FIRST DRAFT WAS NOT — it compared exactly and
  // was TOO STRICT, which is the worse direction for a guard whose whole job is
  // to turn 500s into 404s. Mongoose stringifies to lowercase, so an id sent as
  // `507F1F77BCF86CD799439011` does not round-trip character-for-character —
  // but it casts to the SAME ObjectId and finds the SAME document today. An
  // exact compare would have 404'd a request that currently works, turning a
  // fix into a regression for any caller that uppercases an id.
  return String(new mongoose.Types.ObjectId(value)).toLowerCase() === value.toLowerCase();
}

/**
 * A `router.param` handler that refuses an id which cannot name a document.
 *
 * Usage, once per router:
 *   router.param('id', objectIdParam({ status: 404, message: 'Note not found' }));
 */
function objectIdParam({ status, message }) {
  if (!Number.isInteger(status)) throw new TypeError('objectIdParam: status must be an integer');
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('objectIdParam: message must be a non-empty string');
  }
  return function validateObjectId(req, res, next, value) {
    if (isCanonicalObjectId(value)) return next();
    return res.status(status).json({ message });
  };
}

module.exports = { objectIdParam, isCanonicalObjectId };
