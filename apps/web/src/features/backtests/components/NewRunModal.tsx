import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { backtestApi } from '../api';
import type { CachedSeries, IntrabarPolicy, Run } from '../types';

const toDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const fromDay = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

/**
 * Starts a backtest over history already in the cache. Only what is cached is
 * offered, so a run cannot be pointed at data that does not exist.
 */
export function NewRunModal({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (run: Run) => void }) {
  const [detectors, setDetectors] = useState<{ name: string; version: number }[]>([]);
  const [series, setSeries] = useState<CachedSeries[]>([]);
  const [detector, setDetector] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [risk, setRisk] = useState(1);
  const [maxOpen, setMaxOpen] = useState(3);
  const [intrabar, setIntrabar] = useState<IntrabarPolicy>('pessimistic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    Promise.all([backtestApi.detectors(), backtestApi.cache()])
      .then(([d, c]) => {
        const list = d.detectors.map((name) => ({ name, version: d.versions[name] ?? 0 }));
        setDetectors(list);
        setDetector((cur) => cur || list[0]?.name || '');
        setSeries(c.series);
        const tfs = [...new Set(c.series.map((s) => s.timeframe))];
        setTimeframe((cur) => (cur && tfs.includes(cur) ? cur : tfs.includes('H1') ? 'H1' : tfs[0] ?? ''));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not reach the engine.'));
  }, [open]);

  const forTf = useMemo(() => series.filter((s) => s.timeframe === timeframe), [series, timeframe]);
  const timeframes = useMemo(() => [...new Set(series.map((s) => s.timeframe))].sort(), [series]);

  // Default to every cached pair on this timeframe, over the range they all cover.
  useEffect(() => {
    setSymbols(forTf.map((s) => s.symbol));
    const firsts = forTf.map((s) => s.first_ts).filter((v): v is number => v != null);
    const lasts = forTf.map((s) => s.last_ts).filter((v): v is number => v != null);
    if (firsts.length) setFrom(toDay(Math.max(...firsts)));
    if (lasts.length) setTo(toDay(Math.min(...lasts)));
  }, [forTf]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const run = await backtestApi.start({
        detector,
        symbols,
        timeframe,
        fromTs: fromDay(from),
        toTs: fromDay(to) + 86_399,
        sim: { riskPercent: risk, maxOpenPerSymbol: maxOpen, intrabar },
      });
      onStarted(run);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The backtest could not start.');
    } finally {
      setBusy(false);
    }
  }

  const noCache = series.length === 0;
  const valid = detector && timeframe && symbols.length && from && to && from < to;

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose}
      title="New backtest"
      description="Replays cached history through a detector. Costs are pessimistic: spread and slippage on every fill, ambiguous bars scored against the strategy."
      footer={<>
        <button className="btn2" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy || !valid}>{busy ? 'Starting…' : 'Run backtest'}</button>
      </>}>
      {error && <div className="alert err">{error}</div>}
      {noCache && !error && <div className="alert">No history is cached yet. Import some first.</div>}

      <div className="stack">
        <div className="f2">
          <div className="f">
            <label htmlFor="nr-det">Detector</label>
            <select id="nr-det" value={detector} onChange={(e) => setDetector(e.target.value)}>
              {detectors.map((d) => <option key={d.name} value={d.name}>{d.name} · v{d.version}</option>)}
            </select>
          </div>
          <div className="f">
            <label htmlFor="nr-tf">Timeframe</label>
            <select id="nr-tf" value={timeframe} onChange={(e) => setTimeframe(e.target.value)} disabled={noCache}>
              {timeframes.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div className="f">
          <label>Pairs · {symbols.length} of {forTf.length}</label>
          <div className="inline" style={{ gap: 6 }}>
            {forTf.map((s) => {
              const on = symbols.includes(s.symbol);
              return (
                <label key={s.symbol} className="tag" style={{ cursor: 'pointer', ...(on ? { color: 'var(--fg)', borderColor: 'var(--line-strong)', background: 'var(--surface-3)' } : {}) }}>
                  <input type="checkbox" checked={on} style={{ margin: 0 }}
                    onChange={() => setSymbols(on ? symbols.filter((x) => x !== s.symbol) : [...symbols, s.symbol])} />
                  {s.symbol}
                </label>
              );
            })}
          </div>
        </div>

        <div className="f2">
          <div className="f"><label htmlFor="nr-from">From</label><input id="nr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="f"><label htmlFor="nr-to">To</label><input id="nr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>

        <div className="f2">
          <div className="f">
            <label htmlFor="nr-risk">Risk per trade</label>
            <input id="nr-risk" type="number" min={0.1} max={5} step={0.1} value={risk} onChange={(e) => setRisk(Number(e.target.value))} />
            <span className="hint">Percent of current equity. Sizing compounds.</span>
          </div>
          <div className="f">
            <label htmlFor="nr-open">Open trades per pair</label>
            <input id="nr-open" type="number" min={1} max={10} step={1} value={maxOpen} onChange={(e) => setMaxOpen(Number(e.target.value))} />
            <span className="hint">At {risk}% each, up to {(risk * maxOpen).toFixed(1)}% exposed on one pair.</span>
          </div>
        </div>

        <div className="f">
          <label htmlFor="nr-ib">When stop and target are both inside one bar</label>
          <select id="nr-ib" value={intrabar} onChange={(e) => setIntrabar(e.target.value as IntrabarPolicy)}>
            <option value="pessimistic">Assume the stop hit first (trust this one)</option>
            <option value="optimistic">Assume the target hit first (only to measure the gap)</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
