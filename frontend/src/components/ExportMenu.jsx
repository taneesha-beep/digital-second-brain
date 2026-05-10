import React, { useEffect, useRef, useState } from 'react';
import api from '../api/axiosInstance';

const downloadFile = (content, filename, mime) => {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

function buildHtml(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:740px;margin:40px auto;padding:0 20px;background:#f8fafc}
  h1{font-size:1.4rem;color:#1e293b;margin-bottom:24px}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.05)}
  .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px}
  .q{font-weight:600;color:#1e293b;margin-bottom:8px}
  .a{color:#475569;border-top:1px solid #f1f5f9;padding-top:8px;margin-top:8px}
  .box{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;line-height:1.8;color:#334155;white-space:pre-wrap}
  .tag{display:inline-block;background:#ede9fe;color:#4c1d95;border-radius:20px;padding:2px 10px;font-size:12px;margin:2px}
</style></head><body>
<h1>${title}</h1>${bodyHtml}</body></html>`;
}

const AI_EXPORTS = {
  summarize: {
    label: '🤖 Export Summary',
    build: (raw) => {
      const html = `<div class="box">${raw}</div>`;
      downloadFile(buildHtml('Summary', html), 'summary.html', 'text/html');
    }
  },
  flashcards: {
    label: '🃏 Export Flashcards',
    build: (raw) => {
      let items = []; try { items = JSON.parse(raw); } catch {}
      const html = items.map((c, i) => `
<div class="card">
  <div class="label">Q${i+1}</div>
  <div class="q">${c.q || c.question || ''}</div>
  <div class="label">Answer</div>
  <div class="a">${c.a || c.answer || ''}</div>
</div>`).join('');
      downloadFile(buildHtml('Flashcards', html), 'flashcards.html', 'text/html');
    }
  },
  concepts: {
    label: '💡 Export Key Concepts',
    build: (raw) => {
      let items = []; try { items = JSON.parse(raw); } catch {}
      const html = items.map((c) => `
<div class="card">
  <div class="q">${c.term || ''}</div>
  <div class="a">${c.definition || ''}</div>
</div>`).join('');
      downloadFile(buildHtml('Key Concepts', html), 'key_concepts.html', 'text/html');
    }
  },
  eli5: {
    label: '🧒 Export ELI5',
    build: (raw) => {
      const html = `<div class="box">${raw}</div>`;
      downloadFile(buildHtml('ELI5 Explanation', html), 'eli5.html', 'text/html');
    }
  },
  examQs: {
    label: '📝 Export Exam Questions',
    build: (raw) => {
      let items = []; try { items = JSON.parse(raw); } catch {}
      const html = items.map((c, i) => `
<div class="card">
  <div class="label">Q${i+1}</div>
  <div class="q">${c.question || ''}</div>
  <div class="label">Answer</div>
  <div class="a">${c.answer || ''}</div>
</div>`).join('');
      downloadFile(buildHtml('Exam Questions', html), 'exam_questions.html', 'text/html');
    }
  }
};

const FILE_ITEMS = [
  { format: 'pdf',      label: '📄 Export as PDF' },
  { format: 'markdown', label: '📝 Export as Markdown' },
  { format: 'text',     label: '📃 Export as Text' },
];

export default function ExportMenu({ noteId }) {
  const [open, setOpen]       = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });
  const [busy, setBusy]       = useState('');
  const rootRef = useRef(null);
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';

  useEffect(() => {
    const fn = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  const handleToggle = () => {
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(v => !v);
  };

  const runFileExport = (format) => {
    if (!noteId) return;
    setOpen(false);
    const token = localStorage.getItem('token');
    window.open(`${apiBase}/export/${noteId}?format=${format}&token=${token}`, '_blank');
  };

  const runAIExport = async (feature) => {
    if (!noteId || busy) return;
    setOpen(false);
    setBusy(feature);
    try {
      const { data } = await api.post(`/llm/${noteId}/${feature}`);
      AI_EXPORTS[feature].build(data?.result || '');
    } catch (err) {
      alert('Export failed: ' + (err?.response?.data?.message || err.message));
    } finally {
      setBusy('');
    }
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" disabled={!noteId || !!busy} onClick={handleToggle}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60">
        {busy
          ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
          : <span>⬇</span>}
        {busy ? 'Exporting…' : 'Export'}
        <span className={`text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'fixed', top: dropPos.top, left: dropPos.left,
          zIndex: 99999, width: '220px', borderRadius: '12px',
          border: '1px solid #e2e8f0', background: '#ffffff',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: '6px'
        }}>
          <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.06em', color: '#94a3b8', padding: '4px 10px 2px' }}>Files</p>
          {FILE_ITEMS.map(({ format, label }) => (
            <button key={format} type="button" onClick={() => runFileExport(format)}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">
              {label}
            </button>
          ))}
          <hr style={{ border: 'none', borderTop: '1px solid #f1f5f9', margin: '4px 0' }} />
          <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.06em', color: '#94a3b8', padding: '4px 10px 2px' }}>AI Generated</p>
          {Object.entries(AI_EXPORTS).map(([feature, { label }]) => (
            <button key={feature} type="button" onClick={() => runAIExport(feature)}
              className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100">
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}