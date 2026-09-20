import { useEffect, useRef, useState } from 'react';
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
import { PairBreakdown } from '../features/backtests/components/PairBreakdown';
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
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /// Rows opened to show how the result splits across pairs.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  /// The row a range selection extends from — the last one clicked plainly.
  const anchor = useRef<string | null>(null);
  /// What the delete dialog is about to remove: one run, or the selection.
  const [doomed, setDoomed] = useState<Run[] | null>(null);
  const navigate = useNavigate();

  // A selection means nothing on the other shelf, or after the list changes
  // under it — carrying ids across would act on rows that are no longer shown.
  useEffect(() => {
    setPicked(new Set());
    anchor.current = null;
  }, [shelf]);

  const shown = runs ?? [];
  const allPicked = shown.length > 0 && shown.every((r) => picked.has(r._id));
  const somePicked = picked.size > 0 && !allPicked;
  const chosen = shown.filter((r) => picked.has(r._id));

  /** Plain click toggles one; shift-click takes everything back to the anchor. */
  function pick(run: Run, range: boolean) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (range && anchor.current) {
        const from = shown.findIndex((r) => r._id === anchor.current);
        const to = shown.findIndex((r) => r._id === run._id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          // Shift extends the selection; it never clears what it passes over.
          for (let i = lo; i <= hi; i++) next.add(shown[i]._id);
          return next;
        }
      }
      if (next.has(run._id)) next.delete(run._id);
      else next.add(run._id);
      anchor.current = run._id;
      return next;
    });
  }

  async function archiveMany(runs: Run[], archived: boolean) {
    setBusy(true);
    setActionError(null);
    // One at a time: these write to Mongo, and a clear "3 of 12 failed" beats
    // a burst of parallel requests and a single opaque rejection.
    const failed: string[] = [];
    for (const run of runs) {
      try {
        await backtestApi.setArchived(run._id, archived);
      } catch {
        failed.push(run.detector);
      }
    }
    if (failed.length) {
      setActionError(`${failed.length} of ${runs.length} could not be moved.`);
    }
    setPicked(new Set());
    setBusy(false);
    reload();
  }

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
    const failed: string[] = [];
    for (const run of doomed) {
      try {
        await backtestApi.remove(run._id);
      } catch (e) {
        failed.push(e instanceof ApiError ? e.message : run.detector);
      }
    }
    if (failed.length) {
      setActionError(
        doomed.length === 1
          ? failed[0]
          : `${failed.length} of ${doomed.length} could not be deleted.`,
      );
    }
    setDoomed(null);
    setPicked(new Set());
    setBusy(false);
    reload();
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

      {picked.size > 0 && (
        <div className="selbar">
          <span><strong>{picked.size}</strong> selected</span>
          <div className="inline" style={{ gap: 4 }}>
            <button className="btn3" disabled={busy} onClick={() => setPicked(new Set())}>Clear</button>
            <button className="btn3" disabled={busy}
              onClick={() => archiveMany(chosen, shelf === 'current')}>
              {shelf === 'archived' ? 'Restore' : 'Archive'} {picked.size}
            </button>
            <button className="btn3 danger" disabled={busy} onClick={() => setDoomed(chosen)}>
              Delete {picked.size}
            </button>
          </div>
        </div>
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
                  <th className="pick">
                    <input type="checkbox" checked={allPicked}
                      ref={(el) => { if (el) el.indeterminate = somePicked; }}
                      aria-label={allPicked ? 'Clear selection' : 'Select every run shown'}
                      onChange={() => {
                        setPicked(allPicked ? new Set() : new Set(shown.map((r) => r._id)));
                        anchor.current = null;
                      }} />
                  </th>
                  <th>Run</th><th>Window</th><th>Status</th>
                  <th className="r">Trades</th><th className="r">Net</th><th className="r">Profit factor</th><th className="r">Expectancy</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <RunRow key={r._id} run={r} archived={shelf === 'archived'}
                    picked={picked.has(r._id)}
                    expanded={opened.has(r._id)}
                    onExpand={() => setOpened((cur) => {
                      const next = new Set(cur);
                      if (next.has(r._id)) next.delete(r._id);
                      else next.add(r._id);
                      return next;
                    })}
                    onPick={(range) => pick(r, range)}
                    onOpen={() => navigate(`/backtests/${r._id}`)}
                    onArchive={() => archive(r, shelf === 'current')}
                    onDelete={() => setDoomed([r])} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={doomed !== null} onClose={busy ? () => undefined : () => setDoomed(null)}
        title={doomed && doomed.length > 1 ? `Delete ${doomed.length} backtests?` : 'Delete this backtest?'}
        description="The runs and every trade they produced are removed for good. There is no undo. Archiving keeps them instead."
        footer={<>
          <button className="btn2" onClick={() => setDoomed(null)} disabled={busy}>Cancel</button>
          <button className="btn danger" onClick={destroy} disabled={busy}>
            {busy ? 'Deleting…' : `Delete ${doomed && doomed.length > 1 ? doomed.length : ''} for good`.replace('  ', ' ')}
          </button>
        </>}>
        {doomed && (
          <div className="stack" style={{ gap: 6 }}>
            {doomed.slice(0, 8).map((r) => (
              <p key={r._id} className="dim" style={{ margin: 0 }}>
                <strong>{r.detector} v{r.detectorVersion ?? '?'}</strong> ·{' '}
                {fmtDate(r.fromDate)} – {fmtDate(r.toDate)} ·{' '}
                {r.metrics ? `${r.metrics.totalTrades} trades` : 'no result'}
              </p>
            ))}
            {doomed.length > 8 && <p className="dim" style={{ margin: 0 }}>…and {doomed.length - 8} more.</p>}
            <p className="dim" style={{ margin: 0 }}>
              <strong>{doomed.reduce((a, r) => a + (r.metrics?.totalTrades ?? 0), 0).toLocaleString()}</strong> trades go with them.
            </p>
          </div>
        )}
      </Modal>

      <ImportModal open={importing} onClose={() => setImporting(false)} onStarted={reloadImport} />
      <NewRunModal open={creating} onClose={() => setCreating(false)}
        onStarted={(run) => {
          setCreating(false);
          reload();
          // A completed run straight out of start() means the fingerprint
          // matched an existing one and nothing was recomputed. Say so, or
          // landing on a finished result looks like a bug.
          const reused = run.status === 'completed' ? '?reused=1' : '';
          navigate(`/backtests/${run._id}${reused}`);
        }}
        onSwept={(sweep) => { setCreating(false); navigate(`/sweeps/${sweep._id}`); }} />
    </>
  );
}

function RunRow({
  run, archived, picked, expanded, onExpand, onPick, onOpen, onArchive, onDelete,
}: {
  run: Run;
  archived: boolean;
  picked: boolean;
  expanded: boolean;
  onExpand: () => void;
  onPick: (range: boolean) => void;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const m = run.metrics;
  // The row itself opens the run, so the buttons must not also do that.
  const only = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <>
    <tr onClick={onOpen} style={{ cursor: 'pointer' }} tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={picked ? 'picked' : undefined} aria-selected={picked}>
      <td className="pick" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={picked}
          aria-label={`Select ${run.detector}, ${fmtDate(run.fromDate)} to ${fmtDate(run.toDate)}`}
          onClick={(e) => { e.stopPropagation(); onPick(e.shiftKey); }}
          onChange={() => undefined} />
      </td>
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
          <button className="btn3" onClick={only(onExpand)} aria-expanded={expanded}
            title={expanded ? 'Hide the pair split' : 'Show how this splits across pairs'}>
            {expanded ? 'Hide pairs' : 'Pairs'}
          </button>
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
    {expanded && (
      <tr className="splitrow">
        <td colSpan={9}>
          <PairBreakdown runId={run._id} />
        </td>
      </tr>
    )}
    </>
  );
}

