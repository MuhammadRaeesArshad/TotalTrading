import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { backtestApi } from '../features/backtests/api';
import type { CachedSeries, Run } from '../features/backtests/types';
import type { Mt5Account, ServicesStatus } from '../lib/types';
import { PageHeader } from '../components/PageHeader';
import { fmtDate, fmtR, money0, moneyClass } from '../features/backtests/fmt';
import { ago } from '../lib/format';

/**
 * The front door: what this machine holds, and what it has found so far.
 *
 * Deliberately not "live performance across every bot". Nothing is scanning
 * and order execution is off, so a page promising open P&L would be promising
 * a number that cannot exist. What does exist is a bar cache, a set of
 * strategies, a pile of finished backtests and six services that are either up
 * or not — so that is what this answers.
 */

/** Years of history a series spans. */
const spanYears = (s: CachedSeries) =>
  s.first_ts && s.last_ts ? (s.last_ts - s.first_ts) / (365.25 * 24 * 3600) : 0;

function Tile({
  label,
  value,
  sub,
  to,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
  tone?: string;
}) {
  const body = (
    <div className="tile">
      <span className="hero-label">{label}</span>
      <span className={`hero-num ${tone ?? ''}`}>{value}</span>
      {sub && <span className="meta">{sub}</span>}
    </div>
  );
  return to ? (
    <Link to={to} className="link">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Reachability, straight from the gateway's own probe of each service. */
function Services({ status }: { status: ServicesStatus | null }) {
  if (!status) return <div className="skel" style={{ height: 60 }} />;
  const entries = Object.entries(status);

  return (
    <div className="chipset">
      {entries.map(([name, s]) => (
        <span
          key={name}
          className="tag"
          title={s.detail ?? (s.reachable ? 'Reachable' : 'Not reachable')}
          style={s.reachable ? undefined : { borderStyle: 'dashed', opacity: 0.7 }}
        >
          <span className={s.reachable ? 'd' : ''} />
          <b className="f-mono">{name}</b>
          {s.mode === 'mock' && ' · mock'}
          {!s.reachable && ' · down'}
        </span>
      ))}
    </div>
  );
}

export function SummaryPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [series, setSeries] = useState<CachedSeries[] | null>(null);
  const [accounts, setAccounts] = useState<Mt5Account[]>([]);
  const [strategies, setStrategies] = useState<number | null>(null);
  const [status, setStatus] = useState<ServicesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const set = <T,>(f: (v: T) => void) => (v: T) => {
      if (!cancelled) f(v);
    };
    // Each panel is independent: one service being down should cost its own
    // panel, not the whole page.
    backtestApi.runs().then(set(setRuns)).catch((e) => {
      if (!cancelled) {
        setRuns([]);
        setError(e instanceof ApiError ? e.message : 'Could not reach the gateway.');
      }
    });
    backtestApi.cache().then(set((d: { series: CachedSeries[] }) => setSeries(d.series))).catch(
      () => !cancelled && setSeries([]),
    );
    api.listAccounts().then(set(setAccounts)).catch(() => undefined);
    backtestApi
      .detectors()
      .then(set((d: { strategies: unknown[] }) => setStrategies(d.strategies.length)))
      .catch(() => undefined);
    api.services().then(set(setStatus)).catch(() => !cancelled && setStatus({}));
    return () => {
      cancelled = true;
    };
  }, []);

  const completed = runs?.filter((r) => r.status === 'completed' && r.metrics) ?? [];
  const best = completed.length
    ? completed.reduce((a, r) =>
        (r.metrics?.expectancyR ?? -Infinity) > (a.metrics?.expectancyR ?? -Infinity) ? r : a,
      )
    : null;
  const tradesTested = completed.reduce((a, r) => a + (r.metrics?.totalTrades ?? 0), 0);
  const profitable = completed.filter((r) => (r.metrics?.netProfit ?? 0) > 0).length;

  const pairs = new Set(series?.map((s) => s.symbol) ?? []);
  const bars = series?.reduce((a, s) => a + s.bars, 0) ?? 0;
  const deepest = series?.reduce((a, s) => Math.max(a, spanYears(s)), 0) ?? 0;
  const newest = series?.reduce<number | null>(
    (a, s) => (s.last_ts && (a === null || s.last_ts > a) ? s.last_ts : a),
    null,
  );
  const connected = accounts.filter((a) => a.connectionState === 'connected').length;

  return (
    <>
      <PageHeader
        title="Summary"
        lede="What this machine holds and what it has found. Everything here was computed locally — prices, strategies and the model never leave the box."
      />

      {error && <div className="alert">{error}</div>}

      <div className="tiles">
        <Tile
          label="Backtests completed"
          value={runs ? String(completed.length) : '—'}
          sub={
            completed.length
              ? `${profitable} finished in profit · ${tradesTested.toLocaleString('en-US')} trades simulated`
              : 'None yet'
          }
          to="/backtests"
        />
        <Tile
          label="Best expectancy"
          value={best ? fmtR(best.metrics?.expectancyR) : '—'}
          sub={best ? `${best.detector} v${best.detectorVersion ?? '?'} · ${best.symbols.length} pairs` : 'Run a backtest'}
          tone={best ? moneyClass(best.metrics?.expectancyR) : ''}
          to={best ? `/backtests/${best._id}` : '/backtests'}
        />
        <Tile
          label="History cached"
          value={series ? `${pairs.size} pairs` : '—'}
          sub={
            series?.length
              ? `${series.length} series · ${bars.toLocaleString('en-US')} bars · up to ${deepest.toFixed(1)} years`
              : 'Import history from an account'
          }
          to="/jobs"
        />
        <Tile
          label="Strategies"
          value={strategies !== null ? String(strategies) : '—'}
          sub={connected ? `${connected} account connected` : 'No account connected'}
          to="/strategies"
        />
      </div>

      <div className="g2">
        <div className="card">
          <div className="card-h">
            <div>
              <h3>Recent runs</h3>
              <span className="t-sub">Newest first.</span>
            </div>
          </div>
          <div className="card-b">
            {!runs && <div className="skel" style={{ height: 120 }} />}
            {runs?.length === 0 && (
              <div className="empty">
                No backtests yet. <Link className="link" to="/backtests">Run one</Link> once a pair
                has history cached.
              </div>
            )}
            {runs?.slice(0, 6).map((r) => (
              <div className="crow" key={r._id}>
                <div className="row">
                  <Link className="link f-mono" to={`/backtests/${r._id}`}>
                    <b>{r.detector}</b>
                  </Link>
                  <span className="meta">
                    {r.symbols.length} pair{r.symbols.length === 1 ? '' : 's'} ·{' '}
                    {r.timeframes.join('/')} · {ago(r.createdAt)}
                  </span>
                  {r.metrics ? (
                    <b className={moneyClass(r.metrics.netProfit)}>{money0(r.metrics.netProfit)}</b>
                  ) : (
                    <span className="tag">{r.status}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <div>
              <h3>Services</h3>
              <span className="t-sub">Probed by the gateway just now.</span>
            </div>
          </div>
          <div className="card-b">
            <Services status={status} />
            {newest && (
              <p className="meta">
                Newest bar in the cache is {fmtDate(new Date(newest * 1000).toISOString())}.
              </p>
            )}
            <p className="meta">
              The MT5 connector runs natively on Windows rather than in Docker — it drives a
              terminal over IPC. If it reads <b>down</b>, start it by hand with the terminal
              open and logged in.
            </p>
          </div>
        </div>
      </div>

      <p className="note">
        Live scanning is not built and order execution stays off until live and
        backtest results have been cross-checked on a demo account. Every figure
        on this page comes from simulated fills with spread, slippage and
        commission charged on every one, and ambiguous bars resolved against the
        strategy.
      </p>
    </>
  );
}
