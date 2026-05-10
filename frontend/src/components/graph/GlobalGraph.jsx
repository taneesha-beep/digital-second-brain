import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import cytoscape from 'cytoscape';
import api from '../../api/axiosInstance';

const CY_STYLE = [
  {
    selector: 'node.global-note-node',
    style: {
      'width':  'data(size)',
      'height': 'data(size)',
      'background-color': 'data(noteColor)',
      'border-width': 3,
      'border-color': '#fff',
      'label': 'data(label)',
      'color': '#fff',
      'font-size': 12,
      'font-weight': 'bold',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 58,
      'shadow-blur': 16,
      'shadow-color': 'data(noteColor)',
      'shadow-opacity': 0.45,
      'shadow-offset-x': 0,
      'shadow-offset-y': 0,
      'cursor': 'pointer',
    }
  },
  {
    selector: 'node.global-note-node:active',
    style: { 'overlay-opacity': 0.15 }
  },
  {
    selector: 'node.global-kw-node',
    style: {
      'width':  'data(size)',
      'height': 'data(size)',
      'background-color': 'data(noteColor)',
      'background-opacity': 0.75,
      'border-width': 1.5,
      'border-color': '#fff',
      'border-opacity': 0.6,
      'label': 'data(label)',
      'color': '#1e293b',
      'font-size': 11,
      'font-weight': '500',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      'text-wrap': 'none',
    }
  },
  {
    selector: 'node.global-kw-node.shared-kw',
    style: {
      'border-width': 2.5,
      'border-color': '#f59e0b',
      'border-style': 'solid',
    }
  },
  {
    selector: 'edge.global-kw-edge',
    style: {
      'width': 1.5,
      'line-color': 'data(noteColor)',
      'opacity': 0.4,
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': 'data(noteColor)',
      'arrow-scale': 0.6,
    }
  },
  {
    selector: 'edge.cross-edge',
    style: {
      'width': 1.5,
      'line-color': '#f59e0b',
      'line-style': 'dashed',
      'opacity': 0.55,
      'curve-style': 'unbundled-bezier',
      'control-point-distances': [80],
      'control-point-weights': [0.5],
      'target-arrow-shape': 'none',
    }
  },
  {
    selector: 'edge.cross-edge:selected, edge.cross-edge.highlighted',
    style: {
      'line-color': '#f97316',
      'opacity': 1,
      'width': 2.5,
    }
  },
];

function getLayout(nodeCount) {
  return {
    name: 'breadthfirst',
    directed: false,
    padding: 60,
    spacingFactor: nodeCount > 30 ? 1.3 : nodeCount > 15 ? 1.6 : 2.0,
    animate: true,
    animationDuration: 450,
    animationEasing: 'ease-out-cubic',
    fit: true,
    avoidOverlap: true,
    nodeDimensionsIncludeLabels: true,
  };
}

export default function GlobalGraph({ onNodeClick }) {
  const navigate     = useNavigate();
  const containerRef = useRef(null);
  const cyRef        = useRef(null);

  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [hasData,    setHasData]    = useState(false);
  const [query,      setQuery]      = useState('');
  const [tooltip,    setTooltip]    = useState(null);
  const [stats,      setStats]      = useState({ notes: 0, keywords: 0, links: 0 });
  const [categories, setCategories] = useState([]);

  // ── FULL SCREEN: track window size ──────────────────────────────────────────
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Resize cytoscape canvas when window resizes
  useEffect(() => {
    if (cyRef.current) {
      cyRef.current.resize();
      cyRef.current.fit();
    }
  }, [winSize]);

  // Init Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: CY_STYLE,
      elements: [],
      userZoomingEnabled: true,
      userPanningEnabled: true,
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.25,
    });
    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, []);

  // Load graph data
  useEffect(() => {
    let mounted = true;
    api.get('/graph/global')
      .then(({ data }) => {
        if (!mounted || !cyRef.current) return;
        const elements = data?.elements || [];
        const cy = cyRef.current;
        cy.elements().remove();
        if (elements.length === 0) { setHasData(false); return; }

        const noteColorMap = new Map();
        for (const el of elements) {
          if (el.data.type === 'note') noteColorMap.set(el.data.id, el.data.noteColor);
        }
        const enriched = elements.map((el) => {
          if (el.data.type === 'keyword' || el.classes?.includes('global-kw-edge')) {
            const parentNote = el.data.parentNote || el.data.source;
            if (parentNote && noteColorMap.has(parentNote)) {
              return { ...el, data: { ...el.data, noteColor: noteColorMap.get(parentNote) } };
            }
          }
          return el;
        });

        cy.add(enriched);
        cy.layout(getLayout(cy.nodes().length)).run();
        setHasData(true);

        const noteNodes  = cy.nodes('[type = "note"]');
        const kwNodes    = cy.nodes('[type = "keyword"]');
        const crossEdges = cy.edges('[type = "cross-link"]');
        setStats({ notes: noteNodes.length, keywords: kwNodes.length, links: crossEdges.length });

        const cats = [];
        noteNodes.forEach((n) => cats.push({ label: n.data('label'), color: n.data('noteColor') }));
        setCategories(cats);
      })
      .catch((err) => { if (mounted) setError(err?.response?.data?.message || 'Failed to load graph'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  // Click handlers
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const onNodeTap = (evt) => {
      const node = evt.target;
      if (node.data('type') !== 'note') return;
      if (onNodeClick) onNodeClick(node.id());
      else navigate('/dashboard');
    };
    const onEdgeTap = (evt) => {
      const edge = evt.target;
      if (edge.data('type') !== 'cross-link') return;
      const rp = evt.renderedPosition;
      setTooltip({ kind: 'edge', label: `Shared: "${edge.data('sharedKeyword')}"`, x: rp.x, y: rp.y });
    };
    const onBgTap = () => setTooltip(null);
    cy.on('tap', 'node', onNodeTap);
    cy.on('tap', 'edge', onEdgeTap);
    cy.on('tap', onBgTap);
    return () => {
      cy.removeListener('tap', 'node', onNodeTap);
      cy.removeListener('tap', 'edge', onEdgeTap);
      cy.removeListener('tap', onBgTap);
    };
  }, [navigate, onNodeClick]);

  // Hover tooltips
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const onOver = (evt) => {
      const el = evt.target;
      const rp = el.renderedPosition?.() || evt.renderedPosition;
      if (el.isNode()) {
        const type = el.data('type');
        setTooltip({ kind: 'node', label: el.data('label'), type, keywords: el.data('keywords'), shared: el.data('shared'), x: rp.x, y: rp.y });
        if (type === 'note') containerRef.current.style.cursor = 'pointer';
      } else if (el.isEdge() && el.data('type') === 'cross-link') {
        setTooltip({ kind: 'edge', label: `Shared keyword: "${el.data('sharedKeyword')}"`, x: rp.x, y: rp.y });
      }
    };
    const onOut = () => { setTooltip(null); if (containerRef.current) containerRef.current.style.cursor = 'default'; };
    cy.on('mouseover', 'node, edge', onOver);
    cy.on('mouseout',  'node, edge', onOut);
    return () => {
      cy.removeListener('mouseover', 'node, edge', onOver);
      cy.removeListener('mouseout',  'node, edge', onOut);
    };
  }, []);

  // Search highlight
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const q = query.trim().toLowerCase();
    if (!q) { cy.elements().removeClass('dimmed highlighted'); return; }
    const matched = cy.nodes().filter((n) => n.data('label')?.toLowerCase().includes(q));
    cy.elements().addClass('dimmed');
    matched.removeClass('dimmed').addClass('highlighted');
    matched.connectedEdges().removeClass('dimmed');
  }, [query]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style().selector('node.dimmed').style({ opacity: 0.12 }).update();
    cy.style().selector('edge.dimmed').style({ opacity: 0.05 }).update();
    cy.style().selector('node.highlighted').style({ 'border-color': '#f59e0b', 'border-width': 3 }).update();
  }, [hasData]);

  const matchCount = useMemo(() => {
    if (!query || !cyRef.current) return 0;
    return cyRef.current.nodes('.highlighted').length;
  }, [query, hasData]);

  return (
    // ── FULL SCREEN container ──────────────────────────────────────────────
    <div style={{ position: 'fixed', inset: 0, background: '#ffffff', zIndex: 0 }}>

      {/* Legend */}
      <div style={{ position: 'absolute', left: 16, top: 16, zIndex: 10 }}
        className="max-w-[200px] rounded-xl border border-slate-200 bg-white/95 p-3 text-xs shadow-md">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Legend</p>
        <div className="mb-1 flex items-center gap-2"><span className="h-3 w-3 flex-shrink-0 rounded-full bg-indigo-500" /><span className="text-slate-700">Note</span></div>
        <div className="mb-1 flex items-center gap-2"><span className="h-3 w-3 flex-shrink-0 rounded-full bg-emerald-400 opacity-75" /><span className="text-slate-700">Keyword</span></div>
        <div className="mb-3 flex items-center gap-2"><span className="h-0 w-5 flex-shrink-0 border-t-2 border-dashed border-amber-400" /><span className="text-slate-700">Shared link</span></div>
        {categories.length > 0 && (
          <>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Notes</p>
            <div className="space-y-1">
              {categories.map(({ label, color }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate text-[11px] text-slate-600">{label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Stats */}
      <div style={{ position: 'absolute', right: 16, top: 16, zIndex: 10 }}
        className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-md">
        <span className="font-bold text-slate-800">{stats.notes}</span> notes ·{" "}
        <span className="font-bold text-slate-800">{stats.keywords}</span> keywords ·{" "}
        <span className="font-bold text-slate-800">{stats.links}</span> shared links
      </div>

      {/* Search */}
      <div style={{ position: 'absolute', left: '50%', top: 16, transform: 'translateX(-50%)', zIndex: 10, width: 280 }}>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes or keywords…"
          className="w-full rounded-lg border border-slate-300 bg-white/95 px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-300" />
        {query && <p className="mt-1 text-center text-[11px] text-slate-500">{matchCount} match{matchCount !== 1 ? 'es' : ''}</p>}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div className="pointer-events-none absolute z-20 max-w-[220px] rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs text-slate-700 shadow-lg"
          style={{ left: tooltip.x + 14, top: tooltip.y - 12, position: 'absolute' }}>
          <p className="truncate font-semibold text-slate-800">{tooltip.label}</p>
          {tooltip.kind === 'node' && tooltip.type === 'note' && tooltip.keywords?.length > 0 && (
            <p className="mt-0.5 truncate text-slate-500">{tooltip.keywords.slice(0, 4).join(' · ')}</p>
          )}
          {tooltip.kind === 'node' && tooltip.type === 'note' && (
            <p className="mt-0.5 text-[10px] text-indigo-400">Click to open note</p>
          )}
          {tooltip.kind === 'node' && tooltip.shared && (
            <p className="mt-0.5 text-[10px] text-amber-500">⚡ Shared across notes</p>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/70">
          <div className="flex items-center gap-2.5 rounded-xl border border-slate-100 bg-white px-5 py-3 text-sm text-slate-700 shadow-lg">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
            Building knowledge graph…
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600 shadow">
          {error}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && !hasData && (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-slate-400">No notes yet. Create some notes to build the graph.</p>
        </div>
      )}

      {/* Cytoscape canvas — fills entire container */}
      <div ref={containerRef} style={{ width: '100%', height: '100%', display: loading || (!loading && !hasData) ? 'none' : 'block' }} />

      {/* Hint */}
      {hasData && (
        <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-slate-400">
          Click a note to open · Hover dashed lines for shared keywords · Scroll to zoom
        </p>
      )}
    </div>
  );
}