import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';
import { NoteContext } from '../context/NoteContext';
import NoteEditor from '../components/editor/NoteEditor';
import AIPanel from '../components/llm/AIPanel';
import NoteGraph from '../components/graph/NoteGraph';
import LinkedNotesPanel from '../components/editor/LinkedNotesPanel';
import ExportMenu from '../components/ExportMenu';
import SearchBar from '../components/search/SearchBar';
import SearchResults from '../components/search/SearchResults';
import TagInput from '../components/TagInput';
import VersionHistory from '../components/VersionHistory';
import api from '../api/axiosInstance';

// ── PDF text extraction using pdf.js from CDN ────────────────────────────────
async function extractTextFromPDF(file) {
  return new Promise((resolve, reject) => {
    const script = document.getElementById('pdfjs-script');
    const load = () => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const pdfjsLib = window['pdfjs-dist/build/pdf'];
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          const pdf = await pdfjsLib.getDocument({ data: e.target.result }).promise;
          let text = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map((item) => item.str).join(' ') + '\n';
          }
          resolve(text.trim());
        } catch (err) {
          reject(new Error('Could not read PDF: ' + err.message));
        }
      };
      reader.readAsArrayBuffer(file);
    };

    if (window['pdfjs-dist/build/pdf']) {
      load();
    } else {
      const s = document.createElement('script');
      s.id = 'pdfjs-script';
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = load;
      s.onerror = () => reject(new Error('Failed to load PDF.js'));
      document.head.appendChild(s);
    }
  });
}

// ── DOCX text extraction using mammoth from CDN ──────────────────────────────
async function extractTextFromDOCX(file) {
  return new Promise((resolve, reject) => {
    const load = () => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const result = await window.mammoth.extractRawText({
            arrayBuffer: e.target.result
          });
          resolve(result.value.trim());
        } catch (err) {
          reject(new Error('Could not read DOCX: ' + err.message));
        }
      };
      reader.readAsArrayBuffer(file);
    };

    if (window.mammoth) {
      load();
    } else {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
      s.onload = load;
      s.onerror = () => reject(new Error('Failed to load mammoth.js'));
      document.head.appendChild(s);
    }
  });
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, logout } = useContext(AuthContext);
  const navigate = useNavigate();
  const {
    notes, setNotes,
    selectedNote,
    starredIds, loading,
    selectNote, createNewNote, saveNote, removeNote, toggleStar,
    setSelectedNoteId
  } = useContext(NoteContext);

  const [editorText, setEditorText]         = useState('');
  const [editorBlocks, setEditorBlocks]     = useState([]);
  const [noteTitle, setNoteTitle]           = useState('');
  const [noteTags, setNoteTags]             = useState([]);
  const [saving, setSaving]                 = useState(false);
  const [importing, setImporting]           = useState(false);
  const [hoveredNoteId, setHoveredNoteId]   = useState(null);
  const [menuNoteId, setMenuNoteId]         = useState(null);
  const [renamingNoteId, setRenamingNoteId] = useState(null);
  const [renameValue, setRenameValue]       = useState('');
  const [searchResults, setSearchResults]   = useState(null);
  const [showVersions, setShowVersions]     = useState(false);
  const fileInputRef = useRef(null);

  // Sync editor when selected note changes
  useEffect(() => {
    if (!selectedNote) { setEditorText(''); setNoteTitle(''); return; }
    setEditorText(selectedNote.contentText || '');
    setEditorBlocks(selectedNote.content || []);
    setNoteTitle(selectedNote.title || '');
    setNoteTags(selectedNote.tags || []);
  }, [selectedNote?._id]);

  const handleNewNote = async () => {
    try {
      await createNewNote();
      setEditorText('');
      setNoteTitle('Untitled Note');
    } catch (err) {
      alert('Failed to create note: ' + (err?.response?.data?.message || err.message));
    }
  };

  const handleSave = async () => {
    if (!selectedNote) return;
    setSaving(true);
    try {
      await saveNote(selectedNote._id, {
        title: noteTitle,
        tags: noteTags,
        content: editorBlocks.length > 0 ? editorBlocks : { text: editorText },
        contentText: editorText
      });
    } catch (err) {
      alert('Save failed: ' + (err?.response?.data?.message || err.message));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedNote) return;
    if (!window.confirm('Delete "' + (selectedNote.title || 'Untitled') + '"?')) return;
    await removeNote(selectedNote._id);
  };

  const handleLogout = () => { logout(); navigate('/login'); };

  const handleRename = async () => {
    if (!renamingNoteId || !renameValue.trim()) { setRenamingNoteId(null); return; }
    try { await saveNote(renamingNoteId, { title: renameValue.trim() }); }
    catch (err) { console.error('Rename failed', err); }
    setRenamingNoteId(null);
    setRenameValue('');
  };

  const handleImport = () => fileInputRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be re-imported

    setImporting(true);
    try {
      let fileContent = '';
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'pdf') {
        fileContent = await extractTextFromPDF(file);
      } else if (ext === 'docx') {
        fileContent = await extractTextFromDOCX(file);
      } else {
        // .txt or .md — plain text
        fileContent = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.onerror = () => reject(new Error('Could not read file'));
          reader.readAsText(file);
        });
      }

      if (!fileContent) throw new Error('File appears to be empty or could not be parsed');

      const fileName = file.name.replace(/\.(txt|md|pdf|docx)$/i, '');

      // Use selected note or create a new one
      let targetId = selectedNote?._id;
      if (!targetId) {
        const note = await createNewNote();
        targetId = note._id;
      }

      await saveNote(targetId, {
        title: fileName,
        contentText: fileContent,
        content: { text: fileContent }
      });

      setEditorText(fileContent);
      setNoteTitle(fileName);
      alert(`✅ Imported "${fileName}" successfully (${ext.toUpperCase()})`);
    } catch (err) {
      alert('Import failed: ' + err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleVersionRestore = (content) => {
    const text = typeof content === 'string' ? content : content?.text || '';
    setEditorText(text);
    setShowVersions(false);
  };

  // Close note dropdown on outside click
  useEffect(() => {
    const fn = () => setMenuNoteId(null);
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const displayNotes  = searchResults !== null ? searchResults : notes;
  const starredNotes  = useMemo(() => notes.filter((n) => starredIds.includes(n._id)), [notes, starredIds]);
  const avatar        = (user?.username || user?.name || user?.email || 'U')[0].toUpperCase();
  const displayName   = user?.username || user?.name || user?.email || 'User';

  return (
    <div className="flex min-h-screen bg-slate-100">

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside className="flex w-[280px] flex-shrink-0 flex-col justify-between border-r border-slate-800/60 px-4 py-5 text-slate-100"
        style={{ background: '#1a1a2e' }}>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Brand */}
          <div className="mb-4">
            <h1 className="text-lg font-semibold tracking-tight">Digital Second Brain</h1>
            <p className="mt-0.5 text-xs text-slate-400">{displayName}</p>
          </div>

          {/* Search */}
          <div className="mb-3">
            <SearchBar onResults={setSearchResults} placeholder="Search notes…" />
          <SearchResults
            results={searchResults}
            onSelect={(note) => { selectNote(note); setSearchResults(null); }}
            onClear={() => setSearchResults(null)}
          />
          </div>

          {/* New Note */}
          <button type="button" onClick={handleNewNote}
            className="mb-4 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 active:scale-95">
            + New Note
          </button>

          {/* Notes list */}
          <div className="flex-1 overflow-y-auto">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
              {searchResults !== null ? `Results (${searchResults.length})` : 'All Notes'}
            </p>

            {loading && <p className="text-xs text-slate-400">Loading…</p>}

            <div className="space-y-0.5">
              {displayNotes.map((note) => {
                const selected = selectedNote?._id === note._id;
                const starred  = starredIds.includes(note._id);
                return (
                  <div key={note._id}
                    className={`group relative flex items-center justify-between rounded-md px-2 py-1.5 transition ${selected ? 'bg-indigo-600/40' : 'hover:bg-white/10'}`}
                    onMouseEnter={() => setHoveredNoteId(note._id)}
                    onMouseLeave={() => setHoveredNoteId(null)}>

                    {renamingNoteId === note._id ? (
                      <input value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={handleRename}
                        onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                        className="flex-1 bg-transparent text-sm text-slate-100 outline-none" autoFocus />
                    ) : (
                      <button type="button" onClick={() => selectNote(note)}
                        className="min-w-0 flex-1 truncate text-left text-sm text-slate-100">
                        {note.title || 'Untitled'}
                      </button>
                    )}

                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => toggleStar(note._id)}
                        className={`text-sm transition ${starred ? 'text-yellow-300' : 'text-slate-500 opacity-0 group-hover:opacity-100'}`}>
                        {starred ? '★' : '☆'}
                      </button>
                      {hoveredNoteId === note._id && (
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); setMenuNoteId(menuNoteId === note._id ? null : note._id); }}
                          className="text-xs text-slate-400 hover:text-slate-200 px-1">
                          ···
                        </button>
                      )}
                    </div>

                    {menuNoteId === note._id && (
                      <div className="absolute right-0 top-full z-20 mt-1 w-32 rounded-md bg-white shadow-lg"
                        onMouseDown={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => { setRenamingNoteId(note._id); setRenameValue(note.title || ''); setMenuNoteId(null); }}
                          className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">
                          Rename
                        </button>
                        <button
                          onClick={() => { if (window.confirm('Delete this note?')) removeNote(note._id); setMenuNoteId(null); }}
                          className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50">
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Starred section */}
            <p className="mb-2 mt-5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Starred</p>
            {starredNotes.length === 0
              ? <p className="text-xs text-slate-500">No starred notes yet.</p>
              : (
                <div className="space-y-0.5">
                  {starredNotes.map((note) => (
                    <button key={note._id} type="button" onClick={() => selectNote(note)}
                      className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-yellow-200 transition hover:bg-white/10">
                      ★ {note.title || 'Untitled'}
                    </button>
                  ))}
                </div>
              )
            }
          </div>
        </div>

        {/* Bottom: graph link + user + logout */}
        <div className="mt-4 flex-shrink-0">
          <Link to="/graph"
            className="block rounded-md border border-slate-600 px-3 py-2 text-center text-sm text-slate-200 transition hover:bg-white/10">
            Graph View
          </Link>
          <hr className="my-4 border-slate-700" />
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-500 text-xs font-bold text-white">
              {avatar}
            </div>
            <span className="truncate text-sm text-slate-300">{displayName}</span>
          </div>
          <button type="button" onClick={handleLogout}
            className="text-sm text-red-400 transition hover:text-red-300">
            Logout
          </button>
        </div>
      </aside>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto p-6">
        {!selectedNote ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="text-2xl font-semibold text-slate-800">Welcome back, {displayName}</h2>
            <p className="mt-2 text-slate-500">Select a note from the sidebar or create a new one to start writing.</p>
            <p className="mt-4 text-sm text-slate-400">
              Total notes: <span className="font-semibold text-slate-700">{notes.length}</span>
            </p>
          </div>
        ) : (
          <div className="space-y-5">

            {/* ── Editor card ── */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              {/* Toolbar */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <ExportMenu noteId={selectedNote._id} />

                {/* Import button */}
                <button type="button" onClick={handleImport} disabled={importing}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                  title="Import .txt, .md, .pdf, or .docx">
                  {importing ? (
                    <>
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                      Importing…
                    </>
                  ) : (
                    <>📥 Import</>
                  )}
                </button>
                <span className="text-[11px] text-slate-400"></span>

                {/* Version history toggle */}
                <button type="button" onClick={() => setShowVersions((v) => !v)}
                  className={`flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${showVersions ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
                  🕐 History
                </button>

                {/* Delete */}
                <button type="button" onClick={handleDelete}
                  className="flex items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-500 transition hover:bg-red-50">
                  🗑️ Delete
                </button>

                {/* Save */}
                <div className="ml-auto">
                  <button type="button" onClick={handleSave} disabled={saving}
                    className="rounded-md bg-slate-800 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-60">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>

              {/* Title */}
              <input value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                onBlur={handleSave}
                placeholder="Note title…"
                className="mb-3 w-full border-b border-transparent pb-1 text-xl font-semibold text-slate-800 outline-none transition placeholder:text-slate-300 focus:border-slate-200" />


              <TagInput tags={noteTags} onChange={setNoteTags} />

              <NoteEditor
                initialValue={typeof selectedNote?.content === 'object' && !Array.isArray(selectedNote?.content) ? (selectedNote?.content?.text || editorText) : (selectedNote?.content || editorText)}
                onChange={(plainText, blocks) => {
                  setEditorText(plainText);
                  if (blocks) setEditorBlocks(blocks);
                }}
              />
            </section>

            {/* Version history panel */}
            {showVersions && selectedNote?._id && (
              <VersionHistory noteId={selectedNote._id} onRestore={handleVersionRestore} />
            )}

            {/* AI / Graph / Linked notes */}
            {/* AI / Graph / Linked notes — paste this section into Dashboard.jsx
                replacing the existing:
                  <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                    <AIPanel ... />
                    <NoteGraph ... />
                    <LinkedNotesPanel ... />
                  </section>
            */}
            {selectedNote?._id && (
              <section className="space-y-4">
                {/* Note Graph — full width so the tree is readable */}
                <NoteGraph noteId={selectedNote._id} />

                {/* AI panel + Related notes — side by side below the graph */}
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <AIPanel noteId={selectedNote._id} />
                  <LinkedNotesPanel noteId={selectedNote._id} onNoteSelect={selectNote} />
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Hidden file input — accepts txt, md, pdf, docx */}
      <input ref={fileInputRef} type="file" accept=".txt,.md,.pdf,.docx"
        onChange={handleFileChange} className="hidden" />
    </div>
  );
}