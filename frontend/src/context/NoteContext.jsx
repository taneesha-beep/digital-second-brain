import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import api from '../api/axiosInstance';

export const NoteContext = createContext(null);

export const NoteProvider = ({ children }) => {
  const [notes, setNotes] = useState([]);
  // Mirrors `notes` so selection can read the current list synchronously
  // without taking it as a dependency, which would rebuild every callback on
  // each keystroke-triggered save.
  const notesRef = useRef([]);
  const [selectedNote, setSelectedNote] = useState(null);
  const [starredIds, setStarredIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('starredIds')) || []; }
    catch { return []; }
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => { notesRef.current = notes; }, [notes]);

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

  /*
   * SELECTING A NOTE FETCHES ONLY WHEN WE DO NOT ALREADY HAVE IT — which, in
   * normal use, is never.
   *
   * Both of these used to fetch `GET /notes/:id` unconditionally, under the
   * comment "fetch fresh from API to get populated linkedNotes". That comment
   * outlived the thing it described: Phase 4.2 removed the populate, and
   * routes/notes.js says so on the handler itself. GET /notes and
   * GET /notes/:id both project `-linkedNotes`, so for a note already in the
   * list the response was byte-identical to what we were holding — a full HTTP
   * round trip, ~120 ms, essentially all network now that an Atlas query is
   * 0.9 ms (18 Nov 2026, Singapore).
   *
   * ⚠️ IT IS "IF MISSING" RATHER THAN "NEVER", AND THE REASON IS SEARCH.
   * Dashboard.jsx:270 hands a SEARCH RESULT straight to selectNote, and
   * routes/search.js projects `title tags keywords createdAt contentText` —
   * there is NO `content` on it. The old unconditional refetch was silently
   * repairing that, so dropping it outright put an empty editor on screen for
   * every note opened from search. Resolving against `notes` fixes it, because
   * the list carries full documents; the fetch below is the backstop for when
   * it cannot be resolved there, such as the mount fetch having failed.
   *
   * So do not "simplify" this to a plain setSelectedNote(note). The object a
   * caller passes is not guaranteed to be a whole note.
   *
   * THE TRADE, since this is a behaviour change and not only a deletion: a note
   * edited in another tab or on another device is no longer re-read on click.
   * The list refreshes on mount and after every save, so the window is "changed
   * elsewhere since this tab loaded". Accepted for a single-user notes app. If
   * multi-device editing ever matters, refetch the LIST rather than restoring a
   * per-click request.
   */
  const selectById = useCallback((id, fallback) => {
    if (!id) { setSelectedNote(null); return; }
    // Read through a ref, NOT by calling setNotes with an identity updater to
    // peek at `prev`: React does not promise to run an updater synchronously
    // during dispatch, so that read can land after this function has returned
    // and already decided to fetch.
    const found = notesRef.current.find((n) => n._id === id);
    if (found) { setSelectedNote(found); return; }
    // Not in the list. Show whatever we were given so the UI responds at once,
    // then fill in the real document.
    if (fallback) setSelectedNote(fallback);
    api.get(`/notes/${id}`)
      .then(({ data }) => {
        setSelectedNote(data);
        setNotes((prev) => prev.some((n) => n._id === data._id)
          ? prev.map((n) => (n._id === data._id ? data : n))
          : [data, ...prev]);
      })
      .catch(() => {});
  }, []);

  const setSelectedNoteId = useCallback((id) => selectById(id, null), [selectById]);

  const selectNote = useCallback((noteOrId) => {
    if (!noteOrId) { setSelectedNote(null); return; }
    return typeof noteOrId === 'string'
      ? selectById(noteOrId, null)
      : selectById(noteOrId._id, noteOrId);
  }, [selectById]);

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