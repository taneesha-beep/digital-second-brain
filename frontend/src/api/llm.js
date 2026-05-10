import api from './axiosInstance';

// axiosInstance uses baseURL '/api', so these map to:
// /api/llm/summarize, /api/llm/flashcards, /api/llm/concepts, /api/llm/eli5
const LLM_BASE = '/llm';

export const summarizeNote = (payload) => api.post(`${LLM_BASE}/summarize`, payload);
export const generateFlashcards = (payload) => api.post(`${LLM_BASE}/flashcards`, payload);
export const extractConcepts = (payload) => api.post(`${LLM_BASE}/concepts`, payload);
export const explainLikeFive = (payload) => api.post(`${LLM_BASE}/eli5`, payload);
