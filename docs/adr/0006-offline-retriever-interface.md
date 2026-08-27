# ADR-0006 — A pure retriever interface, with no I/O inside it

- **Status:** Accepted · 4 Aug 2026 · Phase 2.1
- **Relates to:** [ADR-0002](0002-lexical-first-retrieval.md) — this boundary is what made six
  implementations comparable at all.

## Context

The linking algorithm lived inside the application: it read notes from the database, extracted
keywords, scored, and wrote links, in one path. Nothing about it could be scored against a
standard IR answer key without either running a database or copying the algorithm into a script.

**Copying it is the failure mode this record exists to prevent.** A benchmark that runs a *copy*
of the shipped algorithm measures the copy, and the copy drifts. Every number in this repository
would then be a claim about a laboratory twin.

## Decision

**`backend/retrieval/` holds every retriever and nothing else, and it is pure.** Each rung exposes
the same three-function interface — `index(docs)`, `search(handle, query, k)`, `describe(handle)`
— over plain `{id, title, body}` objects. **No file in that directory may require anything that
resolves outside it**, and a test fails the suite if one does.

The database side lives outside the boundary, in an adapter that loads a user's notes and hands
them across as plain objects.

**The boundary is proved by output, not asserted.** Two parity artifacts are regenerated on every
CI run and compared byte for byte: the shipped composition against the harness rung, and the app's
adapter path against the harness path.

## Alternatives rejected

| Rejected | Why |
|---|---|
| **A benchmark script holding its own copy of the algorithm** | Measures the copy. The copy drifts, and nothing tells you when. |
| **Letting the corpus adapter live inside `backend/retrieval/`** | The planned tree put it there. An adapter requires the `Note` model **by definition**, so the location is not merely wrong — it is forbidden by the no-I/O test. The adapter is a service outside the boundary. |
| **A looser rule — "no database calls"** | Unenforceable by a walker. "Nothing resolves outside this directory" is mechanically checkable, which is why it is the rule that got written. |
| **Asserting parity in a test's expectations** | An expectation is a number somebody typed. Byte-identical files where **neither names which side produced it**, so that `sha256sum` is the entire comparison, cannot be satisfied by agreeing with yourself. |

## Consequences

- **The app and the eval harness run the same retriever code**, so every rung's score in
  [`results/test-ladder.txt`](../../results/test-ladder.txt) is a claim about shipped behaviour.
- **Six implementations became directly comparable**, which is what made a ladder possible.
- **Parity is a CI step, not a habit.** The proofs are *regenerated* rather than read, so a drift
  fails the build. [`results/parity/README.md`](../../results/parity/README.md)
- **The parity proof exposed three hidden inputs, which is worth more than the parity itself.**
  Shipped v1 was not a function of `(query, corpus)` — it was a function of
  `(query, corpus, save history, database return order)`. Freezing those three is what made
  byte-identity possible, and each freeze was shown to be load-bearing: reversing the store's
  return order changes **87 of 151 lines** of output, and for three documents changes *which
  eight* come back rather than merely their order. That is a real defect the boundary surfaced and
  a later phase fixed with a one-line sort.
- **The cost is paid at the edges, deliberately.** Tracing cannot enter the directory either — an
  OpenTelemetry import would resolve outside it — so retrieval is timed from its caller with no
  child span. That was a real trade taken with the reason recorded, not an oversight.
- **The directory has not been modified for sixteen phases.** That is the boundary working: rungs
  are added, never edited, and a closed rung's numbers cannot move under it.

## Evidence

| Source | What it carries |
|---|---|
| [`results/parity/README.md`](../../results/parity/README.md) | what byte-identity does and does not claim, and the three frozen inputs with the evidence each one matters |
| [`results/parity/v1-shipped.txt`](../../results/parity/v1-shipped.txt) · [`results/parity/v1-harness.txt`](../../results/parity/v1-harness.txt) | the shipped composition and the harness rung, byte-identical |
| [`results/parity/app-adapter.txt`](../../results/parity/app-adapter.txt) · [`results/parity/app-harness.txt`](../../results/parity/app-harness.txt) | the same proof across the corpus adapter |
| [`results/test-ladder.txt`](../../results/test-ladder.txt) | what the boundary bought — six rungs, one interface, one answer key |
| `backend/tests/retrieval.interface.test.js` | the walker that fails any require resolving outside the directory |

**Not machine-checked:** the line counts above are integers and outside `npm run check:claims`.
The parity claim itself is checked, by regeneration and comparison, on every CI run.
