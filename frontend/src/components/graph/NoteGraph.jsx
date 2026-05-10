import React, { useEffect, useRef, useState, useCallback } from 'react';
import cytoscape from 'cytoscape';
import api from '../../api/axiosInstance';

// ─── Cytoscape stylesheet ─────────────────────────────────────────────────────

const CY_STYLE = [
  {
    selector: 'node.note-node',
    style: {
      'width': 80,
      'height': 80,
      'background-color': '#6366f1',
      'border-width': 3,
      'border-color': '#818cf8',
      'label': 'data(label)',
      'color': '#fff',
      'font-size': 12,
      'font-weight': 'bold',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 72,
      'shadow-blur': 18,
      'shadow-color': '#6366f1',
      'shadow-opacity': 0.45,
      'shadow-offset-x': 0,
      'shadow-offset-y': 0,
    }
  },
  {
    selector: 'node.keyword-node',
    style: {
      'width': 'data(size)',
      'height': 'data(size)',
      'background-color': '#10b981',
      'border-width': 2,
      'border-color': '#34d399',
      // Label sits BELOW the circle — never overflows
      'label': 'data(label)',
      'color': '#1e293b',
      'font-size': 11,
      'font-weight': '600',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      'text-wrap': 'none',        // single line, no wrapping
      'cursor': 'pointer',
    }
  },
  {
    selector: 'node.keyword-node.expanded',
    style: {
      'border-style': 'dashed',
      'border-color': '#fbbf24',
      'border-width': 3,
    }
  },
  {
    selector: 'node.sub-node',
    style: {
      'width': 28,
      'height': 28,
      'background-color': '#64748b',
      'border-width': 1.5,
      'border-color': '#94a3b8',
      'label': 'data(label)',
      'color': '#334155',
      'font-size': 10,
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 5,
      'text-wrap': 'none',
    }
  },
  {
    selector: 'node.tag-node',
    style: {
      'width': 28,
      'height': 28,
      'background-color': '#f59e0b',
      'border-width': 1.5,
      'border-color': '#fcd34d',
      'label': 'data(label)',
      'color': '#78350f',
      'font-size': 10,
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 5,
      'text-wrap': 'none',
    }
  },
  {
    selector: 'edge.keyword-edge',
    style: {
      'width': 2,
      'line-color': '#a5b4fc',
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#a5b4fc',
      'arrow-scale': 0.7,
      'opacity': 0.7,
    }
  },
  {
    selector: 'edge.sub-edge',
    style: {
      'width': 1.2,
      'line-color': '#94a3b8',
      'line-style': 'dashed',
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#94a3b8',
      'arrow-scale': 0.6,
      'opacity': 0.5,
    }
  },
  {
    selector: 'edge.tag-edge',
    style: {
      'width': 1.5,
      'line-color': '#fde68a',
      'curve-style': 'bezier',
      'opacity': 0.6,
    }
  },
  {
    selector: 'node:active',
    style: { 'overlay-opacity': 0.12 }
  },
];

// Used ONCE on initial load — never re-run after expanding
function getInitialLayout(nodeCount) {
  return {
    name: 'breadthfirst',
    directed: true,
    roots: ['#root'],
    padding: 50,
    spacingFactor: nodeCount > 15 ? 1.5 : 2.0,
    animate: true,
    animationDuration: 400,
    animationEasing: 'ease-out-cubic',
    fit: true,
    avoidOverlap: true,
    nodeDimensionsIncludeLabels: true,
  };
}

/**
 * Place newly added sub-nodes directly below their parent keyword node
 * without touching any existing node positions.
 */
function placeSubNodes(cy, parentId, newNodeIds) {
  const parent = cy.getElementById(parentId);
  if (!parent.length) return;
  const px     = parent.position('x');
  const py     = parent.position('y');
  const count  = newNodeIds.length;
  const SPREAD = 72;
  const DROP   = 95;
  const startX = px - ((count - 1) / 2) * SPREAD;
  newNodeIds.forEach((id, i) => {
    const node = cy.getElementById(id);
    if (!node.length) return;
    node.position({ x: startX + i * SPREAD, y: py + DROP });
    node.lock();  // freeze so future layout calls skip it
  });
}

// ─── component ────────────────────────────────────────────────────────────────

export default function NoteGraph({ noteId }) {
  const containerRef = useRef(null);
  const cyRef        = useRef(null);
  const expandedRef  = useRef(new Set());

  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hasData,     setHasData]     = useState(false);
  const [tooltip,     setTooltip]     = useState(null);

  // Init Cytoscape once
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      style: CY_STYLE,
      elements: [],
      userZoomingEnabled: true,
      userPanningEnabled: true,
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.25,
    });
    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, []);

  // Load graph when noteId changes
  useEffect(() => {
    if (!noteId || !cyRef.current) return;
    let mounted = true;
    setLoading(true);
    setError('');
    setHasData(false);
    expandedRef.current = new Set();

    api.get(`/graph/note/${noteId}`)
      .then(({ data }) => {
        if (!mounted || !cyRef.current) return;
        const elements = data?.elements || [];
        const cy = cyRef.current;
        cy.elements().remove();
        if (elements.length > 0) {
          cy.add(elements);
          cy.layout(getInitialLayout(cy.nodes().length)).run();
        }
        setHasData(elements.length > 0);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err?.response?.data?.message || 'Failed to load graph');
      })
      .finally(() => { if (mounted) setLoading(false); });

    return () => { mounted = false; };
  }, [noteId]);

  // Click to expand / collapse keyword node
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const onClick = async (evt) => {
      const node = evt.target;
      if (!node.isNode() || node.data('type') !== 'keyword') return;
      const kw = node.data('keyword');
      if (!kw) return;

      if (expandedRef.current.has(kw)) {
        // Collapse
        // Unlock remaining nodes before removing children
        cy.elements(`[parentKeyword = "${kw}"]`).unlock().remove();
        cy.edges().filter((e) => e.target().data('parentKeyword') === kw).unlock().remove();
        node.removeClass('expanded');
        expandedRef.current.delete(kw);
        // No layout re-run — existing positions are untouched
        return;
      }

      // Expand
      try {
        const { data } = await api.get(
          `/graph/note/${noteId}/expand/${encodeURIComponent(kw)}`
        );
        const newEls = data?.elements || [];
        if (!newEls.length) return;
        const existing = new Set(cy.elements().map((el) => el.id()));
        const toAdd = newEls.filter((el) => !existing.has(el.data.id));
        if (toAdd.length) {
          cy.add(toAdd);
          node.addClass('expanded');
          expandedRef.current.add(kw);
          // Place new sub-nodes below parent without disturbing existing layout
          const newNodeIds = toAdd
            .filter((el) => !el.data.id.startsWith('e_') && !el.data.source)
            .map((el) => el.data.id);
          placeSubNodes(cy, `kw_${kw}`, newNodeIds);
        }
      } catch (err) {
        console.error('Expand failed', err);
      }
    };

    cy.on('tap', 'node', onClick);
    return () => cy.removeListener('tap', 'node', onClick);
  }, [noteId]);

  // Hover tooltip
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const onOver = (evt) => {
      const node = evt.target;
      if (!node.isNode()) return;
      const rp = node.renderedPosition();
      setTooltip({
        label:    node.data('label'),
        type:     node.data('type'),
        score:    node.data('score'),
        expanded: expandedRef.current.has(node.data('keyword')),
        x: rp.x,
        y: rp.y,
      });
      if (node.data('type') === 'keyword') {
        containerRef.current.style.cursor = 'pointer';
      }
    };
    const onOut = () => {
      setTooltip(null);
      if (containerRef.current) containerRef.current.style.cursor = 'default';
    };

    cy.on('mouseover', 'node', onOver);
    cy.on('mouseout',  'node', onOut);
    return () => {
      cy.removeListener('mouseover', 'node', onOver);
      cy.removeListener('mouseout',  'node', onOut);
    };
  }, []);

  const handleReset = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements('[level = 2]').unlock().remove();
    cy.nodes('.keyword-node').unlock().removeClass('expanded');
    cy.nodes().unlock();
    expandedRef.current = new Set();
    cy.layout(getInitialLayout(cy.nodes().length)).run();
  }, []);

  const handleCollapse = () => {
    setIsCollapsed((v) => {
      if (v) setTimeout(() => cyRef.current?.fit(undefined, 40), 60);
      return !v;
    });
  };

  // Canvas height: taller so nodes + labels are readable
  const CANVAS_H = 480;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-slate-700">Note Graph</p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={handleReset}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleCollapse}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
          >
            {isCollapsed ? 'Expand' : 'Collapse'}
          </button>
        </div>
      </div>

      {/* States */}
      {loading && (
        <div className="flex items-center justify-center gap-2" style={{ height: CANVAS_H }}>
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-500" />
          <span className="text-sm text-slate-400">Building graph…</span>
        </div>
      )}

      {!loading && error && (
        <div className="m-4 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-600">
          {error}
        </div>
      )}

      {!loading && !error && !hasData && (
        <div className="flex items-center justify-center" style={{ height: CANVAS_H }}>
          <p className="text-sm text-slate-400">Save the note first to generate the graph</p>
        </div>
      )}

      {!loading && hasData && isCollapsed && (
        <div
          className="flex items-center justify-center rounded-b-xl border-t border-dashed border-slate-200 bg-slate-50"
          style={{ height: CANVAS_H }}
        >
          <div className="text-center">
            <p className="mb-2 text-sm text-slate-400">Graph hidden</p>
            <button
              type="button"
              onClick={() => setIsCollapsed(false)}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-xs text-white hover:bg-slate-600 transition-colors"
            >
              Show graph
            </button>
          </div>
        </div>
      )}

      {/* Cytoscape canvas — always mounted, hidden via CSS when not needed */}
      <div className="relative">
        <div
          ref={containerRef}
          className="w-full rounded-b-xl"
          style={{
            height: CANVAS_H,
            display: loading || isCollapsed || (!loading && !hasData) ? 'none' : 'block',
          }}
        />

        {/* Tooltip */}
        {tooltip && !isCollapsed && (
          <div
            className="pointer-events-none absolute z-10 max-w-[180px] rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs text-slate-700 shadow-md backdrop-blur-sm"
            style={{ left: tooltip.x + 14, top: tooltip.y - 12 }}
          >
            <p className="truncate font-semibold text-slate-800">{tooltip.label}</p>
            <p className="mt-0.5 capitalize text-slate-500">{tooltip.type}</p>
            {tooltip.type === 'keyword' && (
              <>
                {tooltip.score !== undefined && (
                  <p className="text-slate-400">Importance: {Math.round(tooltip.score * 100)}%</p>
                )}
                <p className="mt-0.5 text-indigo-500">
                  {tooltip.expanded ? '▾ Click to collapse' : '▸ Click to expand'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      {!isCollapsed && hasData && !loading && (
        <div className="flex flex-wrap items-center justify-center gap-4 border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-500">
          {[
            { color: '#6366f1', label: 'Note' },
            { color: '#10b981', label: 'Keyword (click to expand)' },
            { color: '#64748b', label: 'Sub-concept' },
            { color: '#f59e0b', label: 'Tag' },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: color }} />
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}