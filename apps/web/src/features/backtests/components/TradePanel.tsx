import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { backtestApi } from '../api';
import type { Bars, Trade } from '../types';
import { sessionOf } from '../stats';
import {
  DETAIL_LABELS, fmtMoney, fmtR, fmtWhen, moneyClass, priceDp,
} from '../fmt';
import { CandleChart } from './CandleChart';

const EXIT_LABEL: Record<string, string> = {
  stop_loss: 'stopped out',
  take_profit: 'target hit',
  end_of_data: 'still open at the end of the data',
};

/**
 * One trade: its chart with the detector's reasoning, and a quality card —
 * the result, how far it went against and for you before exit, and every
 * condition the detector recorded. Detail keys are rendered generically, so a
 * new strategy's fields show up without a UI change.
 */
export function TradePanel({ runId, trade }: { runId: string; trade: Trade }) {
  const cache = useRef(new Map<string, Bars>());
  const [bars, setBars] = useState<Bars | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hit = cache.current.get(trade._id);
    if (hit) { setBars(hit); setError(null); return; }
    let cancelled = false;
    setBars(null);
    setError(null);
    backtestApi
      .tradeBars(runId, trade._id)
      .then((b) => { if (!cancelled) { cache.current.set(trade._id, b); setBars(b); } })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Could not load bars for this trade.'));
    return () => { cancelled = true; };
  }, [runId, trade._id]);

  const dp = priceDp(trade.symbol);
  const r = trade.rMultiple ?? 0;
  const detailKeys = Object.keys(trade.detail ?? {}).sort((a, b) =>
    (DETAIL_LABELS[a] ? 0 : 1) - (DETAIL_LABELS[b] ? 0 : 1) || a.localeCompare(b));

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{trade.symbol} <span className="dir">{trade.direction.toUpperCase()}</span></h3>
          <p>{fmtWhen(trade.entryTime)} UTC · {sessionOf(trade.entryTime)} · held {trade.barsHeld ?? '—'} bars</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={`big-r ${moneyClass(trade.netProfit)}`}>{fmtR(trade.rMultiple)}</div>
          <div className={`mono-sm ${moneyClass(trade.netProfit)}`}>{fmtMoney(trade.netProfit)}</div>
        </div>
      </div>

      <div style={{ padding: '10px 6px 2px' }}>
        {error && <div className="alert err" style={{ margin: 10 }}>{error}</div>}
        {!error && !bars && <div style={{ height: 250, display: 'grid', placeItems: 'center' }}><div className="skel" style={{ width: '60%' }} /></div>}
        {bars && <CandleChart bars={bars} trade={trade} />}
      </div>

      <div className="card-b stack" style={{ gap: 16 }}>
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          {trade.exitReason ? EXIT_LABEL[trade.exitReason] : 'closed'}
          {trade.ambiguousExit && <> · <span className="amb" title="Stop and target were both inside the exit bar; scored against the strategy">AMB</span> decided by the tie-break</>}
        </p>

        <div className="stack" style={{ gap: 8 }}>
          <Excursion label="Went against you" value={trade.maeR} kind="loss"
            hint="Worst point before exit. About 1R on a stopped trade." />
          <Excursion label="Went in your favour" value={trade.mfeR} kind="gain"
            hint={r < 0 && (trade.mfeR ?? 0) >= 1 ? 'Reached 1R+ before losing — right direction, wrong exit.' : 'Best point before exit.'} />
        </div>

        <dl className="kv">
          <dt>Fill</dt><dd>{trade.entryPrice.toFixed(dp)}</dd>
          <dt>Stop</dt><dd>{trade.stopLoss.toFixed(dp)}</dd>
          <dt>Target</dt><dd>{trade.takeProfit != null ? trade.takeProfit.toFixed(dp) : '—'}</dd>
          <dt>Exit</dt><dd>{trade.exitPrice.toFixed(dp)} · {fmtWhen(trade.exitTime)}</dd>
          <dt>Size</dt><dd>{trade.volume.toFixed(2)} lots</dd>
          <dt>Commission</dt><dd>${trade.commission.toFixed(2)}</dd>
          <dt>Swap</dt>
          <dd className={moneyClass(trade.swap)}>
            {trade.swap ? fmtMoney(trade.swap) : <span className="dimmer">none charged</span>}
          </dd>
        </dl>

        {detailKeys.length > 0 && (
          <div>
            <p className="plabel" style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>
              Why it fired
            </p>
            <dl className="kv">
              {detailKeys.map((k) => (
                <DetailRow key={k} k={k} v={trade.detail[k]} dp={dp} />
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ k, v, dp }: { k: string; v: number; dp: number }) {
  let shown: string;
  if (k === 'trend_dir') shown = v > 0 ? 'bullish' : v < 0 ? 'bearish' : 'none';
  else if (k === 'fvg_present') shown = v ? 'yes' : 'no';
  else if (k.endsWith('_bars') || k === 'detector_version') shown = String(Math.round(v));
  else if (k.endsWith('_price') || k.startsWith('zone_')) shown = v.toFixed(dp);
  else shown = Number.isInteger(v) ? String(v) : v.toFixed(4);
  return (
    <>
      <dt>{DETAIL_LABELS[k] ?? k}</dt>
      <dd>{shown}</dd>
    </>
  );
}

/** A horizontal bar to 3R, so excursions are comparable at a glance. */
function Excursion({ label, value, kind, hint }: { label: string; value: number | null; kind: 'gain' | 'loss'; hint: string }) {
  const v = value ?? 0;
  const pct = Math.min(v / 3, 1) * 100;
  return (
    <div>
      <div className="spread" style={{ fontSize: 12.5 }}>
        <span className="dim">{label}</span>
        <span className="mono-sm">{value == null ? '—' : `${v.toFixed(2)}R`}</span>
      </div>
      <div className="xbar" style={{ marginTop: 5 }} aria-hidden="true">
        {kind === 'gain'
          ? <i style={{ left: 0, width: `${pct}%`, background: 'var(--gain)' }} />
          : <i style={{ left: 0, width: `${pct}%`, background: 'transparent', border: '1.5px solid var(--loss)' }} />}
      </div>
      <p style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 4 }}>{hint}</p>
    </div>
  );
}
