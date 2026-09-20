import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { ApiError } from '../lib/api';
import { backtestApi } from '../features/backtests/api';
import { useLatestImport, useRuns } from '../features/backtests/hooks';
import { ImportStatus } from '../features/backtests/components/ImportStatus';
import { ImportModal } from '../features/backtests/components/ImportModal';
import { NewRunModal } from '../features/backtests/components/NewRunModal';
import type { Run } from '../features/backtests/types';
import { StatusTag } from '../features/backtests/components/StatusTag';
import { fmtDate, fmtMoney, fmtR, moneyClass } from '../features/backtests/fmt';

type Shelf = 'current' | 'archived';

export function BacktestsPage() {
  const [shelf, setShelf] = useState<Shelf>('current');
  const { runs, error, reload } = useRuns(shelf === 'archived');
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
  const [doomed, setDoomed] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function archive(run: Run, archived: boolean) {
    setActionError(null);
    try {
      await backtestApi.setArchived(run._id, archived);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not move that run.');
    }
  }

  async function destroy() {
    if (!doomed) return;
    setBusy(true);
    setActionError(null);
    try {
      await backtestApi.remove(doomed._id);
      setDoomed(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not delete that run.');
    } finally {
      setBusy(false);
    }
  }

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

      <div className="tabs2" role="tablist" aria-label="Which backtests to show">
        {(['current', 'archived'] as Shelf[]).map((s) => (
          <button key={s} role="tab" aria-selected={shelf === s} onClick={() => setShelf(s)}>
            {s === 'current' ? 'Current' : 'Archived'}
          </button>
        ))}
      </div>

      {error && <div className="alert err">{error}</div>}
      {actionError && <div className="alert err">{actionError}</div>}
      {job && (job.status === 'running' || job.id !== dismissed) && (
        <ImportStatus job={job} onDismiss={() => dismiss(job.id)} />
      )}

      <div className="card">
        {runs === null && !error && (
          <div className="card-b stack">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ width: `${70 - i * 12}%` }} />)}</div>
        )}
        {runs && runs.length === 0 && shelf === 'archived' && (
          <div className="empty">
            <h3>Nothing archived</h3>
            <p>Runs you put aside land here. They keep every trade — archiving only moves them out of the way.</p>
          </div>
        )}
        {runs && runs.length === 0 && shelf === 'current' && (
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
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <RunRow key={r._id} run={r} archived={shelf === 'archived'}
                    onOpen={() => navigate(`/backtests/${r._id}`)}
                    onArchive={() => archive(r, shelf === 'current')}
                    onDelete={() => setDoomed(r)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={doomed !== null} onClose={busy ? () => undefined : () => setDoomed(null)}
        title="Delete this backtest?"
        description="The run and every trade it produced are removed for good. There is no undo. Archiving keeps it instead."
        footer={<>
          <button className="btn2" onClick={() => setDoomed(null)} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={destroy} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete for good'}
          </button>
        </>}>
        {doomed && (
          <p className="dim" style={{ margin: 0 }}>
            <strong>{doomed.detector} v{doomed.detectorVersion ?? '?'}</strong> ·{' '}
            {fmtDate(doomed.fromDate)} – {fmtDate(doomed.toDate)} ·{' '}
            {doomed.metrics ? `${doomed.metrics.totalTrades} trades` : 'no result'}
          </p>
        )}
      </Modal>

      <ImportModal open={importing} onClose={() => setImporting(false)} onStarted={reloadImport} />
      <NewRunModal open={creating} onClose={() => setCreating(false)}
        onStarted={(run) => { setCreating(false); reload(); navigate(`/backtests/${run._id}`); }} />
    </>
  );
}

function RunRow({ run, archived, onOpen, onArchive, onDelete }: {
  run: Run;
  archived: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const m = run.metrics;
  // The row itself opens the run, so the buttons must not also do that.
  const only = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
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
      <td className="r">
        <div className="row-actions">
          <button className="btn3" onClick={only(onArchive)}
            title={archived ? 'Move back to the current list' : 'Put aside, keeping every trade'}>
            {archived ? 'Restore' : 'Archive'}
          </button>
          <button className="btn3 danger" onClick={only(onDelete)} title="Delete this run and its trades">
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

