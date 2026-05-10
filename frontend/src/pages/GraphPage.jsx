import React from 'react';
import { useNavigate } from 'react-router-dom';
import GlobalGraph from '../components/graph/GlobalGraph';

export default function GraphPage() {
  const navigate = useNavigate();

  return (
    // position:fixed + inset:0 makes this page truly full screen,
    // overriding any layout padding from parent routes
    <div style={{ position: 'fixed', inset: 0, zIndex: 40 }}>
      {/* Floating back button */}
      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        style={{
          position: 'absolute', top: 16, left: 16, zIndex: 100,
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '8px', padding: '6px 14px',
          fontSize: '13px', fontWeight: 500, color: '#374151',
          cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.1)'
        }}
      >
        ← Dashboard
      </button>

      <GlobalGraph />
    </div>
  );
}