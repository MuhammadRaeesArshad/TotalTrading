import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ApiError } from '../lib/api';
import { backtestApi } from '../features/backtests/api';
import type { Sweep } from '../features/backtests/types';
import { SweepTable } from '../features/backtests/components/SweepTable';
import { fmtDate } from '../features/backtests/fmt';

export function SweepPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();

  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      const next = await backtestApi.sweep(id);
      setSweep(next);
      setError(null);
      // Runs go one at a time, so keep looking while any cell is unanswered.
      const pending = next.cells.some((c) => !c.run || c.run.status === 'running' || c.run.status === 'queued');
      if (pending && !next.cancelled) timer.current = window.setTimeout(load, 3_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this sweep.');
    }
  }, [id]);

  useEffect(() => {
    load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  const done = sweep?.cells.filter((c) => c.run?.status === 'completed').length ?? 0;
  const total = sweep?.cells.length ?? 0;

  return (
    <>
      <PageHeader
        title={sweep?.label ?? 'Sweep'}
        lede={sweep
          ? `${done} of ${total} done · ${sweep.symbols.length} pairs · ${fmtDate(sweep.fromDate)} – ${fmtDate(sweep.toDate)}`
          : undefined}
        actions={sweep && !sweep.cancelled && done < total ? (
          <button className="btn2" onClick={() => void backtestApi.cancelSweep(id).then(load)}>
            Stop after this run
          </button>
        ) : undefined}
      />

      {error && <div className="alert err">{error}</div>}
      {sweep?.cancelled && done < total && (
        <div className="alert">Stopped. The {done} runs that finished are kept and still open normally.</div>
      )}
      {sweep && sweep.reusedCount > 0 && (
        <div className="alert">
          {sweep.reusedCount} of these had already been run with the same settings, so they were
          not recomputed.
        </div>
      )}

      {sweep && <SweepTable sweep={sweep} onOpen={(runId) => navigate(`/backtests/${runId}`)} />}
    </>
  );
}
