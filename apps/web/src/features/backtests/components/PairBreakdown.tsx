import { useEffect, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { backtestApi } from '../api';
import type { PairRow } from '../types';
import { fmtMoney, fmtPct, fmtR, moneyClass } from '../fmt';

/**
 * How one run's result splits across its pairs, shown without leaving the list.
 *
 * A run's headline figure hides that a few pairs usually carry it and a few
 * usually wreck it — the point of looking is to see which. Loaded when the row
 * is opened rather than with the list, because most rows are never opened.
 */
export function PairBreakdown({ runId }: { runId: string }) {
  const [rows, setRows] = useState<PairRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    backtestApi
      .byPair(runId)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError(e instanceof ApiError ? e.message : 'Could not load the pair split.'));
    return () => { alive = false; };
  }, [runId]);

  if (error) return <div className="alert err" style={{ margin: 0 }}>{error}</div>;
  if (!rows) return <div className="skel" style={{ width: '40%' }} />;
  if (!rows.length) return <p className="dim" style={{ margin: 0 }}>This run took no trades.</p>;

  // One scale across every pair, so bar lengths compare within the run.
  const widest = Math.max(...rows.map((r) => Math.abs(r.sumR)), 1);

  return (
    <div className="pairsplit">
      {rows.map((r) => {
        const pct = (Math.abs(r.sumR) / widest) * 100;
        const up = r.sumR >= 0;
        return (
          <div className="pairsplit-row" key={r.symbol}>
            <span className="mono-sm">{r.symbol}</span>
            <span className="pairsplit-track">
              <span className={`pairsplit-bar ${up ? 'up' : 'down'}`}
                style={{ width: `${pct / 2}%`, [up ? 'left' : 'right']: '50%' }} />
            </span>
            <span className={`mono-sm r ${moneyClass(r.sumR)}`}>{fmtR(r.sumR, 1)}</span>
            <span className="mono-sm r dim">{r.n}</span>
            <span className="mono-sm r dim">{fmtPct(r.winRate, 0)}</span>
            <span className={`mono-sm r ${moneyClass(r.net)}`}>{fmtMoney(r.net)}</span>
          </div>
        );
      })}
    </div>
  );
}
