import api from './axiosInstance';

// ── Auth ──────────────────────────────────────────────────────────────────
export const registerUser = (data) => api.post('/auth/register', data);
export const loginUser    = (data) => api.post('/auth/login',    data);

// ── Notes ─────────────────────────────────────────────────────────────────
export const fetchNotes  = ()         => api.get('/notes');
export const fetchNote   = (id)       => api.get(`/notes/${id}`);
export const createNote  = (data)     => api.post('/notes', data);
export const updateNote  = (id, data) => api.put(`/notes/${id}`, data);
export const modifyNoteWithBlockNote = (id, data) =>
  api.put(`/notes/${id}/modify-blocknote`, data);
export const deleteNote  = (id)       => api.delete(`/notes/${id}`);
export const fetchGraph  = ()         => api.get('/notes/graph');

// Remove a specific link between two notes
export const deleteLink  = (noteId, relatedId) =>
  api.delete(`/notes/${noteId}/relations/${relatedId}`);

// ── Upload ────────────────────────────────────────────────────────────────
// file: File object from <input type="file">
export const uploadNote = (file, category = '') => {
  const form = new FormData();
  form.append('file', file);
  if (category) form.append('category', category);
  return api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
};
