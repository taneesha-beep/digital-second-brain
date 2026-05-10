import api from './axiosInstance';

const GRAPH_BASE = '/graph';

export const fetchGlobalGraph = () =>
  api.get(`${GRAPH_BASE}/global`);

export const fetchNoteGraph = (noteId, expandedKeywords = []) => {
  const params = expandedKeywords.length
    ? `?expanded=${expandedKeywords.join(',')}`
    : '';
  return api.get(`${GRAPH_BASE}/note/${noteId}${params}`);
};

// Lazy-load Level-2 sub-keywords for a single keyword node.
// Called when user clicks a keyword node in NoteGraph.
export const expandNoteKeyword = (noteId, keyword) =>
  api.get(`${GRAPH_BASE}/note/${noteId}/expand/${encodeURIComponent(keyword)}`);