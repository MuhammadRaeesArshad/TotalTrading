import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import {
  IconAccounts, IconAnalysis, IconBacktests, IconExplore, IconJobs, IconJournal,
  IconLogs, IconPositions, IconSettings, IconStrategies, IconSummary,
  IconTheme, Logomark,
} from './icons';

const NAV = [
  { to: '/', label: 'Summary', Icon: IconSummary, end: true },
  { to: '/strategies', label: 'Strategies', Icon: IconStrategies },
  { to: '/accounts', label: 'MT5 accounts', Icon: IconAccounts },
  { to: '/positions', label: 'Positions', Icon: IconPositions },
  { sep: true },
  { to: '/jobs', label: 'Jobs', Icon: IconJobs },
  { to: '/backtests', label: 'Backtests', Icon: IconBacktests },
  { to: '/explore', label: 'Explore', Icon: IconExplore },
  { to: '/analysis', label: 'AI analysis', Icon: IconAnalysis },
  { sep: true },
  { to: '/journal', label: 'Journal', Icon: IconJournal },
  { to: '/logs', label: 'System logs', Icon: IconLogs },
] as const;

export function Shell() {
  const { user, signOut } = useAuth();
  const [theme, setTheme] = useState(
    () => localStorage.getItem('tt.theme') ?? 'dark',
  );
  const [mockMode, setMockMode] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('tt.theme', theme);
  }, [theme]);

  useEffect(() => {
    api
      .services()
      .then((s) => setMockMode(s['mt5-connector']?.mode === 'mock'))
      .catch(() => setMockMode(false));
  }, []);

  const initials = (user?.displayName ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div id="app" className="on">
      <nav className="rail" aria-label="Main">
        <div className="mark">
          <Logomark size={22} />
        </div>

        {NAV.map((item, i) =>
          'sep' in item ? (
            <div className="rail-sep" key={`sep-${i}`} />
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) => `ri${isActive ? ' on' : ''}`}
              aria-label={item.label}
            >
              <item.Icon />
              <span className="tip">{item.label}</span>
            </NavLink>
          ),
        )}

        <div className="rail-btm">
          <button
            className="ri"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <IconTheme />
            <span className="tip">
              Switch to {theme === 'dark' ? 'light' : 'dark'}
            </span>
          </button>
          <NavLink
            to="/settings"
            className={({ isActive }) => `ri${isActive ? ' on' : ''}`}
            aria-label="Settings"
          >
            <IconSettings />
            <span className="tip">Settings</span>
          </NavLink>
          <button
            className="avatar"
            onClick={() => void signOut()}
            title={`${user?.displayName} — sign out`}
            aria-label="Sign out"
          >
            {initials}
          </button>
        </div>
      </nav>

      <div className="main">
        {mockMode && (
          <div className="mockbar">
            <b>Mock data.</b>
            The MT5 connector has no terminal attached, so prices are synthetic.
            Run it on your Windows machine for real candles.
          </div>
        )}
        <div className="page on">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
