# Frozen areas

These parts of the app work. They are deliberately receiving **no further hours**
until the retrieval and evaluation work is finished.

Freezing is not deprecation. Nothing here is scheduled for removal, and bugs that
make a frozen area *break* still get fixed. What is frozen is discretionary
improvement: refactors, polish, and features.

| Area | Where | Why frozen |
|---|---|---|
| **Version history** | `services/version.service.js`, `models/NoteVersion.js`, `components/VersionHistory.jsx` | Works. Snapshot-on-save plus load-into-editor is enough. Diffing, named versions, and restore-as-a-mutation are all out of scope. |
| **Export** | `routes/export.js`, `components/ExportMenu.jsx` | Single-note pdf/markdown/text covers the need. No all-notes export, no new formats. The auth fix in Phase 0.3 was the last change here. |
| **Three-format content normalization** | `normalizeContent()` and `blockNoteToPlainText()` in `routes/notes.js` | **Load-bearing.** Real notes are stored in three historical shapes: Quill Delta `{ops:[...]}`, nested block arrays, and plain strings. This path must not break. Do not "clean it up." |
| **Auth** | `routes/auth.js`, `middleware/auth.js` | Beyond the Phase 0.3 fixes, this is done. No OAuth, no refresh tokens, no password reset. |
| **All UI polish** | `frontend/src/` generally | Styling, animation, responsive work, and empty states are not where the remaining value is. |
| **File upload** | `routes/upload.js`, the import path in `Dashboard.jsx` | Works. Note that `POST /api/upload` is currently unreachable from the UI — Dashboard extracts PDF/DOCX client-side instead. Left as-is deliberately. |

## What is *not* frozen

Everything the measurement work touches:

- `utils/keywords.js` — tokenization and keyword extraction
- `services/linker.service.js` — link scoring, threshold, cap
- `services/graphBuilder.service.js` — graph construction
- `routes/search.js` — retrieval surface
- `routes/llm.js`, `services/llm.service.js` — generation, once Phase 5 starts
- Anything new under `backend/retrieval/`, `backend/eval/`, `backend/corpus/`

## If you are tempted

The cost of unfreezing is not the hours spent — it is the hours *not* spent on the
thing that makes this project worth discussing. If a frozen area genuinely blocks
the retrieval work, that is a reason to touch it. "It bothers me" is not.
