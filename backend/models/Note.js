const mongoose = require('mongoose');

const NoteSchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true
    },
    title: {
      type:     String,
      required: [true, 'Title is required'],
      trim:     true,
      maxlength: [200, 'Title cannot exceed 200 characters']
    },
    content: {
      type:     mongoose.Schema.Types.Mixed,
      required: [true, 'Content is required'],
      default: {}
    },
    contentText: {
      type:     String,
      trim:     true,
      default: ''
    },
    tags: {
      type:    [String],
      default: []
    },
    // Keywords auto-extracted from title + contentText
    keywords: {
      type:    [String],
      default: []
    },
    embedding: {
      type:    [Number],
      default: []
    },
    /**
     * DEPRECATED AT PHASE 4.2 — no longer written, and no route serves it.
     *
     * Links live in models/NoteLink.js, one canonical row per unordered pair
     * behind a unique index. This array was the last-writer-wins storage that
     * made the stored graph depend on save order (PRIMER §3.5).
     *
     * IT IS LEFT ON DISK DELIBERATELY, and for three reasons rather than
     * inertia: it is what migrations/001-canonical-edges.rollback.js reverts
     * to; it holds v1-era sharedKeywords lists, which the migration copies into
     * NoteLink rather than discards; and deleting a field from every document
     * in a live database is a destructive act that buys nothing here.
     *
     * `strength` keeps `min: 0`, which is on 4.1's noticed list as a constraint
     * v4 satisfies only by accident — the `lucene` idf variant is positive,
     * `robertson` is not (§16.6). It is not corrected because nothing writes
     * this any more; NoteLink's scores decide their constraints on purpose.
     *
     * Removing the field is a data migration of its own and wants its own step.
     */
    linkedNotes: [
      {
        noteId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Note',
          required: true
        },
        strength: {
          type: Number,
          default: 0,
          min: 0
        },
        sharedKeywords: {
          type: [String],
          default: []
        }
      }
    ],
    // Color assigned by backend based on top keyword cluster
    color: {
      type:    String,
      default: '#6366f1'
    },
    // Optional subject/category assigned manually by user
    category: {
      type:    String,
      trim:    true,
      default: ''
    }
  },
  { timestamps: true }
);

// Index for fast keyword lookups
NoteSchema.index({ user: 1, keywords: 1 });
// Text index for full-text search in /api/search
NoteSchema.index({ title: 'text', contentText: 'text', tags: 'text' });

module.exports = mongoose.model('Note', NoteSchema);
