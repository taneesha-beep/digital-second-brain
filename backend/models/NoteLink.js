const mongoose = require('mongoose');

const NoteLinkSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    sourceNote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      required: true
    },
    targetNote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      required: true
    },
    similarityScore: {
      type: Number,
      required: true,
      min: 0,
      max: 1
    },
    sharedKeywords: {
      type: [String],
      default: []
    },
    sharedKeywordCount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  { timestamps: true }
);

// One undirected edge per note pair per user.
NoteLinkSchema.index({ user: 1, sourceNote: 1, targetNote: 1 }, { unique: true });
NoteLinkSchema.index({ user: 1, similarityScore: -1 });

module.exports = mongoose.model('NoteLink', NoteLinkSchema);
