import type { ImportJob } from '../types';
import { fmtDate } from '../fmt';

/** Identical errors across many series collapse into one line listing the series. */
function groupFailures(failed: NonNullable<ImportJob['report']>['failed']) {
  const groups = new Map<string, string[]>();
  for (const f of failed) {
    const list = groups.get(f.error) ?? [];
    list.push(`${f.symbol} ${f.timeframe}`);
    groups.set(f.error, list);
  }
  return [...groups.entries()].map(([error, series]) => ({ error, series }));
}

/**
 * A history import running in the background, or the last one's result. Lives
 * on the Backtests page so progress is visible without holding a dialog open.
 */
export function ImportStatus({ job, onDismiss }: { job: ImportJob; onDismiss: () => void }) {
  const pct = job.series_total ? Math.round((job.series_done / job.series_total) * 100) : 0;

  if (job.status === 'running') {
    return (
      <div className="card card-b stack mb16" role="status" aria-live="polite">
        <div className="spread">
          <span><b style={{ fontWeight: 600 }}>Importing history</b> <span className="dim">· runs in the background, you can leave this page</span></span>
          <span className="mono-sm">{job.series_done} / {job.series_total}</span>
        </div>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        <div className="spread" style={{ fontSize: 12, color: 'var(--fg-3)' }}>
          <span>{job.current ? `Pulling ${job.current}…` : 'Starting…'}</span>
          <span className="mono-sm">{job.bars_done.toLocaleString()} bars so far</span>
        </div>
      </div>
    );
  }

  const report = job.report;
  const groups = report ? groupFailures(report.failed) : [];
  const nothing = !report || report.imported.length === 0;

  return (
    <div className="card mb16">
      <div className="card-h">
        <div>
          <h3>{job.status === 'failed' ? 'The import stopped unexpectedly' : nothing ? 'Nothing was imported' : 'History imported'}</h3>
          {report && (
            <p>
              {report.imported.reduce((a, s) => a + (s.added ?? s.bars), 0).toLocaleString()} new bars across {report.imported.length} series in {(report.elapsed_ms / 1000).toFixed(0)}s
              {report.failed.length > 0 && ` · ${report.failed.length} failed`}
            </p>
          )}
        </div>
        <button className="btn3" onClick={onDismiss}>Dismiss</button>
      </div>
      {groups.length > 0 && (
        <div className="card-b stack" style={{ gap: 8 }}>
          {groups.map((g) => (
            <div key={g.error} className="alert err" style={{ margin: 0 }}>
              <b>{g.series.length} series:</b> {g.error}
              <div style={{ marginTop: 4, opacity: 0.85 }}>{g.series.length > 8 ? `${g.series.slice(0, 8).join(', ')} and ${g.series.length - 8} more` : g.series.join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {report && report.imported.length > 0 && (
        <div className="tw" style={{ maxHeight: 280, overflowY: 'auto' }}>
          <table className="tl">
            <thead><tr><th>Pair</th><th>TF</th><th className="r">New</th><th className="r">In cache</th><th>From</th><th className="opt">Note</th></tr></thead>
            <tbody>
              {report.imported.map((s) => (
                <tr key={`${s.symbol}${s.timeframe}`} style={{ cursor: 'default' }}>
                  <td>{s.symbol}</td>
                  <td className="mono-sm">{s.timeframe}</td>
                  <td className="r mono-sm">{(s.added ?? s.bars) > 0 ? `+${(s.added ?? s.bars).toLocaleString()}` : 'up to date'}</td>
                  <td className="r mono-sm dim">{s.bars.toLocaleString()}</td>
                  <td className="mono-sm">{s.first_ts ? fmtDate(new Date(s.first_ts * 1000).toISOString()) : '—'}</td>
                  <td className="dim opt" style={{ fontSize: 11.5 }}>{s.short_of_request ? 'history starts later than asked' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
