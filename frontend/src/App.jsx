import React, { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import LoginPage    from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import Dashboard    from './pages/Dashboard';
import WakingNotice from './components/WakingNotice';

/*
 * GraphPage is split out because it pulls in cytoscape, which is 425 KB of a
 * 718 KB bundle — 59% of everything a first-time visitor downloads, for a route
 * most of them never open.
 *
 * SPLITTING THIS ALONE ACHIEVES NOTHING, and that is the trap worth recording:
 * Dashboard also renders <NoteGraph>, which imports cytoscape as well, so a
 * static import there keeps it in the main chunk no matter what this line does.
 * Dashboard.jsx has the matching lazy boundary. Both or neither.
 */
const GraphPage = React.lazy(() => import('./pages/GraphPage'));

// Wrapper: redirect unauthenticated users to /login
const PrivateRoute = ({ children }) => {
  const { isAuthenticated, authLoading } = useAuth();
  if (authLoading) return null;
  return isAuthenticated ? children : <Navigate to="/login" replace />;
};

// Wrapper: redirect already-logged-in users away from auth pages
const PublicRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/" replace /> : children;
};

export default function App() {
  const { isAuthenticated, authLoading } = useAuth();

  return (
    <>
      {/* Mounted outside <Routes> so it survives navigation — the spin-up it
          reports on often spans the login request AND the redirect after it. */}
      <WakingNotice />
      <Routes>
        <Route path="/login"    element={<PublicRoute><LoginPage /></PublicRoute>} />
        <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />
        <Route path="/"         element={authLoading ? null : <Navigate to={isAuthenticated ? "/dashboard" : "/login"} replace />} />
        <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
        <Route
          path="/graph"
          element={
            <PrivateRoute>
              <Suspense fallback={<div style={{ padding: 24, color: '#64748b', fontSize: 14 }}>Loading graph…</div>}>
                <GraphPage />
              </Suspense>
            </PrivateRoute>
          }
        />
        <Route path="*"         element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </>
  );
}
