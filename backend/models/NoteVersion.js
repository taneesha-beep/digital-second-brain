const mongoose = require('mongoose');

const NoteVersionSchema = new mongoose.Schema(
  {
    noteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Note',
      required: true
    },
    versionNumber: {
      type: Number,
      required: true,
      min: 1
    },
    title: {
      type: String,
      default: ''
    },
    content: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    contentText: {
      type: String,
      default: ''
    },
    savedAt: {
      type: Date,
      default: Date.now
    }
  }
);

// Fast version history lookups by note id.
NoteVersionSchema.index({ noteId: 1 });

module.exports = mongoose.model('NoteVersion', NoteVersionSchema);
