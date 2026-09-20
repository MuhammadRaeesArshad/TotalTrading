import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useLatestImport, useRuns } from '../features/backtests/hooks';
import { ImportStatus } from '../features/backtests/components/ImportStatus';
import { ImportModal } from '../features/backtests/components/ImportModal';
import { NewRunModal } from '../features/backtests/components/NewRunModal';
import type { Run } from '../features/backtests/types';
import { StatusTag } from '../features/backtests/components/StatusTag';
import { fmtDate, fmtMoney, fmtR, moneyClass } from '../features/backtests/fmt';

export function BacktestsPage() {
  const { runs, error, reload } = useRuns();
  const { job, reload: reloadImport } = useLatestImport();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try { return localStorage.getItem('tt.importDismissed'); } catch { return null; }
  });
  const dismiss = (id: string) => {
    setDismissed(id);
    try { localStorage.setItem('tt.importDismissed', id); } catch { /* per-viewer convenience only */ }
  };
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title="Backtests"
        lede="Replays of a detector over real history — every trade, how it was taken, and whether the result holds up."
        actions={<>
          <button className="btn2" onClick={() => setImporting(true)}>Import history</button>
          <button className="btn" onClick={() => setCreating(true)}>New backtest</button>
        </>}
      />

      {error && <div className="alert err">{error}</div>}
      {job && (job.status === 'running' || job.id !== dismissed) && (
        <ImportStatus job={job} onDismiss={() => dismiss(job.id)} />
      )}

      <div className="card">
        {runs === null && !error && (
          <div className="card-b stack">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ width: `${70 - i * 12}%` }} />)}</div>
        )}
        {runs && runs.length === 0 && (
          <div className="empty">
            <h3>No backtests yet</h3>
            <p>Import some price history from your terminal, then run a detector over it.</p>
            <div className="inline" style={{ justifyContent: 'center' }}>
              <button className="btn2" onClick={() => setImporting(true)}>Import history</button>
              <button className="btn" onClick={() => setCreating(true)}>New backtest</button>
            </div>
          </div>
        )}
        {runs && runs.length > 0 && (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Run</th><th>Window</th><th>Status</th>
                  <th className="r">Trades</th><th className="r">Net</th><th className="r">Profit factor</th><th className="r">Expectancy</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => <RunRow key={r._id} run={r} onOpen={() => navigate(`/backtests/${r._id}`)} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ImportModal open={importing} onClose={() => setImporting(false)} onStarted={reloadImport} />
      <NewRunModal open={creating} onClose={() => setCreating(false)}
        onStarted={(run) => { setCreating(false); reload(); navigate(`/backtests/${run._id}`); }} />
    </>
  );
}

function RunRow({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const m = run.metrics;
  return (
    <tr onClick={onOpen} style={{ cursor: 'pointer' }} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <td>
        <div className="t-name">{run.detector} <span className="dimmer mono-sm">v{run.detectorVersion ?? '?'}</span></div>
        <div className="t-sub">{run.timeframes[0]} · {run.symbols.length} pair{run.symbols.length === 1 ? '' : 's'}
          {run.intrabarPolicy === 'optimistic' && ' · optimistic'}
          {run.capital === 'per_symbol' && ' · per-pair capital'}</div>
      </td>
      <td className="mono-sm dim">{fmtDate(run.fromDate)} – {fmtDate(run.toDate)}</td>
      <td><StatusTag run={run} /></td>
      <td className="r mono-sm">{m ? m.totalTrades : '—'}</td>
      <td className={`r mono-sm ${moneyClass(m?.netProfit)}`}>{m ? fmtMoney(m.netProfit) : '—'}</td>
      <td className="r mono-sm">{m ? (m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)) : '—'}</td>
      <td className={`r mono-sm ${moneyClass(m?.expectancyR)}`}>{m ? fmtR(m.expectancyR) : '—'}</td>
    </tr>
  );
}

