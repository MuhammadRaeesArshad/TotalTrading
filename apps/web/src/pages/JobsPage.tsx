import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { backtestApi } from '../features/backtests/api';
import type { ImportJob, Run, Sweep } from '../features/backtests/types';
import { PageHeader } from '../components/PageHeader';
import { StatusTag } from '../features/backtests/components/StatusTag';
import { fmtWhen } from '../features/backtests/fmt';
import { ago } from '../lib/format';

/**
 * Everything the machine is chewing on, in one place.
 *
 * The three long-running things this system does already report progress —
 * history imports have a job registry in the engine, runs carry `progressPct`,
 * and a sweep knows which of its cells have come back. They were only ever
 * visible from the page that started them, so a sweep left running was
 * invisible the moment you navigated away.
 *
 * Polls while anything is live and stops when nothing is.
 */

const isLiveRun = (r: Run) => r.status === 'queued' || r.status === 'running';
const isLiveSweep = (s: Sweep) => !s.cancelled && s.cells.some((c) => !c.runId);

/** Seconds as "4m 20s" — a two-hour import should not read as 7,200s. */
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function Bar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="pairsplit-track" role="progressbar" aria-valuenow={Math.round(pct)}>
      <div className="pairsplit-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

function ImportRow({ job }: { job: ImportJob }) {
  const added = job.report?.imported.reduce((a, s) => a + (s.added ?? 0), 0);
  const failed = job.report?.failed.length ?? 0;
  // The engine reports epoch seconds, not milliseconds.
  const finished = job.finished_at ? job.finished_at * 1000 : Date.now();
  const elapsed = job.report?.elapsed_ms ?? finished - job.created_at * 1000;

  return (
    <div className="crow">
      <div className="row">
        <b>History import</b>
        {job.status === 'running' ? (
          <span className="tag hot">
            <span className="d pulse" />
            {job.series_done} of {job.series_total} series
          </span>
        ) : (
          <span className="tag" style={job.status === 'failed' ? { borderStyle: 'dashed' } : undefined}>
            {job.status}
          </span>
        )}
        <span className="meta">{ago(new Date(job.created_at * 1000).toISOString())}</span>
      </div>

      {job.status === 'running' && (
        <>
          <Bar done={job.series_done} total={job.series_total} />
          <div className="meta">
            {job.current ? (
              <>
                Currently <b className="f-mono">{job.current}</b> ·{' '}
              </>
            ) : null}
            {job.bars_done.toLocaleString('en-US')} bars so far. First pull of a pair takes
            minutes; a top-up takes seconds.
          </div>
        </>
      )}

      {job.status !== 'running' && job.report && (
        <div className="meta">
          {job.report.imported.length} series in {duration(elapsed)} ·{' '}
          {job.report.total_bars.toLocaleString('en-US')} bars cached
          {added !== undefined && <> · {added.toLocaleString('en-US')} new</>}
          {failed > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="loss">
                {failed} failed: {job.report.failed.map((f) => `${f.symbol} ${f.timeframe}`).join(', ')}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  return (
    <div className="crow">
      <div className="row">
        <Link className="link" to={`/backtests/${run._id}`}>
          <b className="f-mono">{run.detector}</b>
        </Link>
        <StatusTag run={run} />
        <span className="meta">
          {run.symbols.length} pair{run.symbols.length === 1 ? '' : 's'} ·{' '}
          {run.timeframes.join('/')} · {fmtWhen(run.fromDate, false)} to {fmtWhen(run.toDate, false)}
        </span>
      </div>
      {isLiveRun(run) && <Bar done={run.progressPct} total={100} />}
      {run.status === 'failed' && run.error && <div className="meta loss">{run.error}</div>}
    </div>
  );
}

function SweepRow({ sweep, onCancel }: { sweep: Sweep; onCancel: (id: string) => void }) {
  const done = sweep.cells.filter((c) => c.runId).length;
  return (
    <div className="crow">
      <div className="row">
        <Link className="link" to={`/sweeps/${sweep._id}`}>
          <b>{sweep.label}</b>
        </Link>
        <span className="tag hot">
          <span className="d pulse" />
          {done} of {sweep.cells.length} runs
        </span>
        <span className="meta">
          {sweep.reusedCount > 0 && `${sweep.reusedCount} answered from cache · `}
          {ago(sweep.createdAt)}
        </span>
        <button className="btn3 btn-sm" onClick={() => onCancel(sweep._id)}>
          Cancel
        </button>
      </div>
      <Bar done={done} total={sweep.cells.length} />
    </div>
  );
}

function Section({
  title,
  lede,
  empty,
  children,
}: {
  title: string;
  lede: string;
  empty: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{title}</h3>
          <span className="t-sub">{lede}</span>
        </div>
      </div>
      <div className="card-b">{empty ? <div className="empty">{lede}</div> : children}</div>
    </div>
  );
}

export function JobsPage() {
  const [imports, setImports] = useState<ImportJob[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number>();

  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      const [i, r, s] = await Promise.all([
        backtestApi.imports(),
        backtestApi.runs(),
        backtestApi.sweeps(),
      ]);
      setImports(i);
      setRuns(r);
      setSweeps(s);
      setError(null);
      setLoaded(true);
      // Poll only while something can still change. An idle machine stops
      // asking rather than hitting the engine once a second forever.
      const live = i.some((j) => j.status === 'running') || r.some(isLiveRun) || s.some(isLiveSweep);
      if (live) timer.current = window.setTimeout(load, 1_500);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the gateway.');
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  async function cancel(id: string) {
    if (!confirm('Cancel this sweep? Runs already finished are kept; the rest are never started.')) {
      return;
    }
    try {
      await backtestApi.cancelSweep(id);
      void load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not cancel that sweep.');
    }
  }

  const liveRuns = runs.filter(isLiveRun);
  const liveSweeps = sweeps.filter(isLiveSweep);
  const runningImports = imports.filter((j) => j.status === 'running');
  const pastImports = imports.filter((j) => j.status !== 'running').slice(0, 8);
  const recentFailures = runs.filter((r) => r.status === 'failed').slice(0, 5);
  const busy = runningImports.length + liveRuns.length + liveSweeps.length;

  return (
    <>
      <PageHeader
        title="Jobs"
        lede={
          busy > 0
            ? `${busy} job${busy === 1 ? '' : 's'} running. This page refreshes itself until they finish.`
            : 'Background work: history imports, backtests and sweeps. Nothing is running.'
        }
      />

      {error && <div className="alert">{error}</div>}
      {!loaded && <div className="skel" style={{ height: 160 }} />}

      {loaded && (
        <div className="stack">
          <Section
            title="Running now"
            lede="Nothing is running. Start an import from MT5 accounts, or a backtest from Backtests."
            empty={busy === 0}
          >
            {runningImports.map((j) => (
              <ImportRow key={j.id} job={j} />
            ))}
            {liveSweeps.map((s) => (
              <SweepRow key={s._id} sweep={s} onCancel={cancel} />
            ))}
            {liveRuns.map((r) => (
              <RunRow key={r._id} run={r} />
            ))}
          </Section>

          {recentFailures.length > 0 && (
            <Section title="Failed" lede="Runs that stopped with an error." empty={false}>
              {recentFailures.map((r) => (
                <RunRow key={r._id} run={r} />
              ))}
            </Section>
          )}

          <Section
            title="Finished imports"
            lede="No history has been imported yet."
            empty={pastImports.length === 0}
          >
            {pastImports.map((j) => (
              <ImportRow key={j.id} job={j} />
            ))}
          </Section>
        </div>
      )}

      <p className="note">
        Imports are incremental — only bars the cache does not already hold are
        fetched, so re-importing a pair tops it up rather than pulling the years
        again. While one runs the MT5 connector serialises on a single lock, so
        its own health check blocks too; that is the terminal being busy, not a
        hang.
      </p>
    </>
  );
}
