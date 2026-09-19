import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { AuthPage } from './pages/AuthPage';
import { AccountsPage } from './pages/AccountsPage';
import { SettingsPage } from './pages/SettingsPage';
import { BacktestsPage } from './pages/BacktestsPage';
import { BacktestRunPage } from './pages/BacktestRunPage';
import {
  AnalysisPage, JobsPage, JournalPage, LogsPage,
  PositionsPage, StrategiesPage, SummaryPage,
} from './pages/stubs';

function Gate() {
  const { user, loading } = useAuth();

  // Blank rather than a spinner: the token check resolves in a few ms, and a
  // spinner that flashes is worse than nothing.
  if (loading) return <div style={{ minHeight: '100vh' }} />;
  if (!user) return <AuthPage />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<SummaryPage />} />
        <Route path="strategies" element={<StrategiesPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="positions" element={<PositionsPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="backtests" element={<BacktestsPage />} />
        <Route path="backtests/:id" element={<BacktestRunPage />} />
        <Route path="analysis" element={<AnalysisPage />} />
        <Route path="journal" element={<JournalPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
