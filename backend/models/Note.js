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
    // Similar notes + similarity metadata
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
