import React, { createContext, useContext, useState, useCallback } from 'react';
import { loginUser, registerUser } from '../api/notes';

export const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user,  setUser]  = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')); }
    catch { return null; }
  });
  const [token, setToken] = useState(() => localStorage.getItem('token') || null);
  const [authLoading, setAuthLoading] = useState(true);

  React.useEffect(() => {
    // After initial load from localStorage, set loading to false
    setAuthLoading(false);
  }, []);

  const persist = (userData, jwt) => {
    setUser(userData);
    setToken(jwt);
    localStorage.setItem('user',  JSON.stringify(userData));
    localStorage.setItem('token', jwt);
  };

  const login = useCallback(async (email, password) => {
    const { data } = await loginUser({ email, password });
    persist(data.user, data.token);
    return data.user;
  }, []);

  const register = useCallback(async (username, email, password) => {
    const { data } = await registerUser({ name: username, username, email, password });
    persist(data.user, data.token);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('user');
    localStorage.removeItem('token');
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, isAuthenticated: !!token, authLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
