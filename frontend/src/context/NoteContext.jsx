import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import api from '../api/axiosInstance';

export const NoteContext = createContext(null);

export const NoteProvider = ({ children }) => {
  const [notes, setNotes] = useState([]);
  const [selectedNote, setSelectedNote] = useState(null);
  const [starredIds, setStarredIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('starredIds')) || []; }
    catch { return []; }
  });
  const [loading, setLoading] = useState(false);

  // Fetch all notes on mount
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setLoading(true);
    api.get('/notes')
      .then(({ data }) => setNotes(Array.isArray(data) ? data : []))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  }, []);

  const setSelectedNoteId = useCallback((id) => {
    if (!id) { setSelectedNote(null); return; }
    setNotes((prev) => {
      const found = prev.find((n) => n._id === id);
      if (found) setSelectedNote(found);
      return prev;
    });
    // Also fetch fresh from API to get populated linkedNotes
    api.get(`/notes/${id}`)
      .then(({ data }) => setSelectedNote(data))
      .catch(() => {});
  }, []);

  const selectNote = useCallback((noteOrId) => {
    if (!noteOrId) { setSelectedNote(null); return; }
    const id = typeof noteOrId === 'string' ? noteOrId : noteOrId._id;
    if (typeof noteOrId === 'object') setSelectedNote(noteOrId);
    api.get(`/notes/${id}`)
      .then(({ data }) => {
        setSelectedNote(data);
        setNotes((prev) => prev.map((n) => n._id === data._id ? data : n));
      })
      .catch(() => {});
  }, []);

  const createNewNote = useCallback(async () => {
    const { data } = await api.post('/notes', {
      title: 'Untitled Note',
      content: [],
      contentText: ''
    });
    setNotes((prev) => [data, ...prev]);
    setSelectedNote(data);
    return data;
  }, []);

  const saveNote = useCallback(async (id, updates) => {
    const { data } = await api.put(`/notes/${id}`, updates);
    setNotes((prev) => prev.map((n) => n._id === id ? data : n));
    setSelectedNote((prev) => prev?._id === id ? data : prev);
    return data;
  }, []);

  const removeNote = useCallback(async (id) => {
    await api.delete(`/notes/${id}`);
    setNotes((prev) => prev.filter((n) => n._id !== id));
    setSelectedNote((prev) => prev?._id === id ? null : prev);
  }, []);

  const toggleStar = useCallback((id) => {
    setStarredIds((prev) => {
      const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id];
      localStorage.setItem('starredIds', JSON.stringify(next));
      return next;
    });
  }, []);

  const unlinkNotes = useCallback(async (id, relatedId) => {
    await api.delete(`/notes/${id}/relations/${relatedId}`);
    setNotes((prev) => prev.map((n) => {
      if (n._id === id) return { ...n, linkedNotes: (n.linkedNotes || []).filter((l) => l.noteId?._id !== relatedId) };
      if (n._id === relatedId) return { ...n, linkedNotes: (n.linkedNotes || []).filter((l) => l.noteId?._id !== id) };
      return n;
    }));
  }, []);

  return (
    <NoteContext.Provider value={{
      notes, setNotes,
      selectedNote, setSelectedNote,
      selectedNoteId: selectedNote?._id || null,
      setSelectedNoteId,
      starredIds,
      loading,
      selectNote,
      createNewNote,
      saveNote,
      removeNote,
      toggleStar,
      unlinkNotes
    }}>
      {children}
    </NoteContext.Provider>
  );
};

export const useNotes = () => {
  const ctx = useContext(NoteContext);
  if (!ctx) throw new Error('useNotes must be used inside NoteProvider');
  return ctx;
};