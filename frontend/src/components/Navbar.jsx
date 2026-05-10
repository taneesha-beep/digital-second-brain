import React, { useContext } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../context/AuthContext';

export default function Navbar() {
  const navigate = useNavigate();
  const { user, logout: authLogout } = useContext(AuthContext);
  const displayName = user?.name || user?.username || user?.email || 'User';
  const avatarLetter = displayName.charAt(0).toUpperCase();

  const logout = () => {
    authLogout?.();
    navigate('/login');
  };

  return (
    <header className="border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
        <Link to="/dashboard" className="text-sm font-semibold text-slate-800">
          Digital Second Brain
        </Link>

        <div className="flex items-center gap-3">
          <Link to="/graph" className="text-xs font-medium text-slate-600 hover:text-slate-800">
            Graph
          </Link>
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ background: '#7F77DD' }}
            >
              {avatarLetter}
            </div>
            <span className="text-[13px] text-slate-500">{displayName}</span>
          </div>
          <button
            type="button"
            onClick={logout}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}
