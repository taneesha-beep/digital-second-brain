/**
 * colors.js
 * Assigns a consistent color to each note based on its top keyword.
 * Notes whose top keyword is the same → same color (same cluster).
 * 8 distinct colors cycle if there are more than 8 unique top keywords.
 */

const PALETTE = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#f97316', // orange
  '#14b8a6', // teal
];

/**
 * Given an array of note objects (each with a `keywords` array and `_id`),
 * returns a Map of  noteId (string) → colorHex (string).
 *
 * Notes that share the same top keyword get the same color,
 * indicating they belong to the same topic cluster.
 *
 * @param {Array} notes  - Array of note documents (lean or full)
 * @returns {Map<string, string>}
 */
function buildColorMap(notes) {
  const keywordToColor = new Map(); // topKeyword → colorHex
  const noteToColor    = new Map(); // noteId     → colorHex
  let colorIndex = 0;

  for (const note of notes) {
    const topKeyword = (note.keywords && note.keywords[0]) || '__uncategorised__';

    if (!keywordToColor.has(topKeyword)) {
      keywordToColor.set(topKeyword, PALETTE[colorIndex % PALETTE.length]);
      colorIndex++;
    }

    noteToColor.set(note._id.toString(), keywordToColor.get(topKeyword));
  }

  return noteToColor;
}

module.exports = { buildColorMap, PALETTE };
