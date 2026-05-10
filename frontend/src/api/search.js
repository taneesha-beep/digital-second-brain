import api from './axiosInstance';

export const searchNotes = ({ q, mode = 'keyword', limit = 20 }) =>
  api.get('/search', {
    params: { q, mode, limit }
  });

export const searchByKeyword = (q, limit = 20) =>
  api.get('/search', {
    params: { q, mode: 'keyword', limit }
  });

export const searchByTag = (q, limit = 20) =>
  api.get('/search', {
    params: { q, mode: 'tag', limit }
  });

export const searchSmart = (q, limit = 20) =>
  api.get('/search', {
    params: { q, mode: 'semantic', limit }
  });
