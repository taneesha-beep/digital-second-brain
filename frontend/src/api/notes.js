import api from './axiosInstance';

// ── Auth ──────────────────────────────────────────────────────────────────
// The only consumers left are AuthContext's login/register flows. Note and
// graph calls go through axiosInstance directly from the components that
// make them.
export const registerUser = (data) => api.post('/auth/register', data);
export const loginUser    = (data) => api.post('/auth/login',    data);
