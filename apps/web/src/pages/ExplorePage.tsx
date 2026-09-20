import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ApiError } from '../lib/api';
import { backtestApi } from '../features/backtests/api';
import { SESSIONS } from '../features/backtests/stats';
import { fmtMoney, fmtPct, fmtR, moneyClass } from '../features/backtests/fmt';
import type { Dimension, ExploreResult, Run, Sweep } from '../features/backtests/types';

const DIMS: { id: Dimension; label: string }[] = [
  { id: 'setting', label: 'Setting' },
  { id: 'pair', label: 'Pair' },
  { id: 'session', label: 'Session' },
  { id: 'year', label: 'Year' },
  { id: 'month', label: 'Month' },
  { id: 'direction', label: 'Side' },
];

type SortKey = 'sumR' | 'avgR' | 'net' | 'n' | 'winRate';

/**
 * What worked, across every run at once.
 *
 * A sweep answers "what does this setting do" one run at a time; the question
 * underneath it spans them — over four years, in which session, on which pair,
 * did this make money, and would it have made more traded in one session only.
 * Opening runs one by one cannot answer that, so this groups their trades
 * instead.
 *
 * The minimum-trades floor is the important control. A pair with one winning
 * trade tops a table sorted by average R and means nothing; setting the floor
 * to 30 is usually the difference between a finding and a coincidence.
 */
export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [result, setResult] = useState<ExploreResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const scope = params.get('scope') ?? '';
  const by = (params.get('by')?.split(',').filter(Boolean) ?? ['pair']) as Dimension[];
  const minTrades = Number(params.get('min') ?? 30);
  const sessions = params.get('sessions')?.split(',').filter(Boolean) ?? [];
  const side = (params.get('side') ?? '') as '' | 'long' | 'short';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sort = (params.get('sort') ?? 'sumR') as SortKey;

  const set = (patch: Record<string, string>) => setParams((p) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    return p;
  });

  useEffect(() => {
    Promise.all([backtestApi.sweeps(), backtestApi.runs()])
      .then(([s, r]) => {
        setSweeps(s);
        setRuns(r);
        // Land on something rather than an empty screen.
        if (!params.get('scope')) {
          const first = s[0] ? `sweep:${s[0]._id}` : r.length ? 'all' : '';
          if (first) set({ scope: first });
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load what there is to explore.'));
    // Runs once: the picker's contents, not the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!scope || !by.length) return;
    setBusy(true);
    setError(null);
    try {
      const query = {
        by,
        minTrades,
        sessions: sessions.length ? sessions : undefined,
        side: side || undefined,
        from: from || undefined,
        to: to || undefined,
        ...(scope.startsWith('sweep:')
          ? { sweepId: scope.slice(6) }
          : { runIds: runs.filter((r) => r.status === 'completed').map((r) => r._id) }),
      };
      setResult(await backtestApi.explore(query));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not slice these trades.');
    } finally {
      setBusy(false);
    }
  }, [scope, by.join(','), minTrades, sessions.join(','), side, from, to, runs]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const list = [...(result?.rows ?? [])];
    list.sort((a, b) => b[sort] - a[sort]);
    return list;
  }, [result, sort]);

  const toggleDim = (d: Dimension) => {
    const next = by.includes(d) ? by.filter((x) => x !== d) : [...by, d];
    // Three is already a lot of rows; past it the table is the trade list.
    if (next.length && next.length <= 3) set({ by: next.join(',') });
  };

  const best = rows[0];
  const worst = rows[rows.length - 1];

  return (
    <>
      <PageHeader
        title="Explore"
        lede="Every run's trades at once, sliced by setting, pair, session and year. What actually made money, and what only looked like it did."
      />

      {error && <div className="alert err">{error}</div>}

      <div className="filterbar">
        <div className="filterbar-row">
          <select className="sel" aria-label="Which runs" value={scope}
            onChange={(e) => set({ scope: e.target.value })}>
            {sweeps.map((s) => (
              <option key={s._id} value={`sweep:${s._id}`}>
                {s.label} · {s.cells.length} runs
              </option>
            ))}
            <option value="all">Every completed backtest</option>
          </select>

          <span className="chipset" role="group" aria-label="Group by">
            {DIMS.map((d) => (
              <button key={d.id} className={`chip${by.includes(d.id) ? ' on' : ''}`}
                aria-pressed={by.includes(d.id)} onClick={() => toggleDim(d.id)}>
                {d.label}
              </button>
            ))}
          </span>

          <label className="inline" style={{ gap: 6, fontSize: 12.5 }}>
            <span className="dim">at least</span>
            <input className="sel" type="number" min={1} step={5} style={{ width: 78 }}
              aria-label="Minimum trades" value={minTrades}
              onChange={(e) => set({ min: e.target.value })} />
            <span className="dim">trades</span>
          </label>
        </div>

        <div className="filterbar-row">
          <span className="chipset" role="group" aria-label="Sessions">
            {SESSIONS.map((s) => {
              const on = sessions.includes(s.name);
              return (
                <button key={s.name} className={`chip${on ? ' on' : ''}`} aria-pressed={on}
                  onClick={() => set({
                    sessions: (on ? sessions.filter((x) => x !== s.name) : [...sessions, s.name]).join(','),
                  })}>
                  {s.name}
                </button>
              );
            })}
          </span>

          <select className="sel" aria-label="Side" value={side}
            onChange={(e) => set({ side: e.target.value })}>
            <option value="">Long and short</option>
            <option value="long">Long only</option>
            <option value="short">Short only</option>
          </select>
          <input className="sel" type="date" aria-label="From" value={from}
            onChange={(e) => set({ from: e.target.value })} />
          <input className="sel" type="date" aria-label="To" value={to}
            onChange={(e) => set({ to: e.target.value })} />

          {result && (
            <span className="filterbar-count">
              <strong>{result.totals.n.toLocaleString()}</strong> trades over {result.runs} runs
              {' · '}{fmtPct(result.totals.winRate, 0)} won
              {' · '}<span className={moneyClass(result.totals.sumR)}>{fmtR(result.totals.sumR, 1)}</span>
              {' · '}<span className={moneyClass(result.totals.net)}>{fmtMoney(result.totals.net)}</span>
            </span>
          )}
        </div>
      </div>

      {/* The answer to "if I only traded this slice, what would it have made". */}
      {result && rows.length > 0 && (
        <div className="grid g2" style={{ marginBottom: 12 }}>
          <div className="card card-b">
            <div className="dim" style={{ fontSize: 11.5 }}>BEST SLICE</div>
            <div className="t-name">{best.keys.join(' · ')}</div>
            <div className="mono-sm">
              <span className={moneyClass(best.sumR)}>{fmtR(best.sumR, 1)}</span> over {best.n} trades
              {' · '}{fmtPct(best.winRate, 0)} won
              {' · '}<span className={moneyClass(best.net)}>{fmtMoney(best.net)}</span>
            </div>
          </div>
          <div className="card card-b">
            <div className="dim" style={{ fontSize: 11.5 }}>WORST SLICE</div>
            <div className="t-name">{worst.keys.join(' · ')}</div>
            <div className="mono-sm">
              <span className={moneyClass(worst.sumR)}>{fmtR(worst.sumR, 1)}</span> over {worst.n} trades
              {' · '}{fmtPct(worst.winRate, 0)} won
              {' · '}<span className={moneyClass(worst.net)}>{fmtMoney(worst.net)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        {busy && <div className="card-b"><div className="skel" style={{ width: '45%' }} /></div>}
        {!busy && result && rows.length === 0 && (
          <div className="empty">
            <h3>Nothing clears the bar</h3>
            <p>
              No slice has {minTrades} trades or more. Lower the floor, group more coarsely, or
              widen the dates — but a slice below about 30 trades is usually a coincidence.
            </p>
          </div>
        )}
        {!busy && rows.length > 0 && (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  {by.map((d) => <th key={d}>{DIMS.find((x) => x.id === d)?.label ?? d}</th>)}
                  {([['n', 'Trades'], ['winRate', 'Win rate'], ['sumR', 'Net R'],
                    ['avgR', 'Avg R'], ['net', 'Money']] as [SortKey, string][]).map(([k, label]) => (
                    <th key={k} className="r">
                      <button className="th-sort" aria-pressed={sort === k} onClick={() => set({ sort: k })}>
                        {label}
                      </button>
                    </th>
                  ))}
                  <th className="r">Best / worst</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.keys.join('|')}>
                    {r.keys.map((k, i) => <td key={i} className={i === 0 ? 't-name' : 'mono-sm'}>{k}</td>)}
                    <td className="r mono-sm">{r.n.toLocaleString()}</td>
                    <td className="r mono-sm">{fmtPct(r.winRate, 0)}</td>
                    <td className={`r mono-sm ${moneyClass(r.sumR)}`}>{fmtR(r.sumR, 1)}</td>
                    <td className={`r mono-sm ${moneyClass(r.avgR)}`}>{fmtR(r.avgR)}</td>
                    <td className={`r mono-sm ${moneyClass(r.net)}`}>{fmtMoney(r.net)}</td>
                    <td className="r mono-sm dim">{fmtR(r.bestR, 1)} / {fmtR(r.worstR, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
