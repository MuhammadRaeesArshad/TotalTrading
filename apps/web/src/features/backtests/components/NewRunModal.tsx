import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { backtestApi } from '../api';
import type { CachedSeries, IntrabarPolicy, ParamSpec, Run, Strategy } from '../types';
import { PairPicker } from './PairPicker';

const toDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const fromDay = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

const defaults = (specs: ParamSpec[]): Record<string, unknown> =>
  Object.fromEntries(specs.map((p) => [p.key, p.default]));

/**
 * Starts a backtest. Everything below the pair list comes from the strategy
 * itself — its description, the timeframes it reads and its own settings — so
 * a new strategy needs no change here.
 */
export function NewRunModal({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: (run: Run) => void }) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [series, setSeries] = useState<CachedSeries[]>([]);
  const [detector, setDetector] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [symbols, setSymbols] = useState<string[]>([]);
  const [params, setParams] = useState<Record<string, unknown>>({});
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
        setStrategies(d.strategies);
        setDetector((cur) => cur || d.strategies[0]?.name || '');
        setSeries(c.series);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not reach the engine.'));
  }, [open]);

  const strategy = strategies.find((s) => s.name === detector) ?? null;
  const cachedTimeframes = useMemo(() => [...new Set(series.map((s) => s.timeframe))].sort(), [series]);

  // A strategy that names its own timeframes decides them; otherwise pick one.
  useEffect(() => {
    if (!strategy) return;
    setParams(defaults(strategy.params));
    setTimeframe(strategy.timeframe || (cachedTimeframes.includes('H1') ? 'H1' : cachedTimeframes[0] ?? ''));
  }, [strategy, cachedTimeframes]);

  const forTf = useMemo(() => series.filter((s) => s.timeframe === timeframe), [series, timeframe]);
  const missing = (strategy?.higher_timeframes ?? []).filter((tf) => !cachedTimeframes.includes(tf));

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
        higherTimeframes: strategy?.higher_timeframes ?? [],
        fromTs: fromDay(from),
        toTs: fromDay(to) + 86_399,
        sim: { riskPercent: risk, maxOpenPerSymbol: maxOpen, intrabar },
        params,
      });
      onStarted(run);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The backtest could not start.');
    } finally {
      setBusy(false);
    }
  }

  const valid = detector && timeframe && symbols.length && from && to && from < to && missing.length === 0;

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose}
      title="New backtest"
      description="Replays cached history through a strategy. Costs are pessimistic: spread and slippage on every fill, ambiguous bars scored against the strategy."
      footer={<>
        <button className="btn2" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy || !valid}>{busy ? 'Starting…' : 'Run backtest'}</button>
      </>}>
      {error && <div className="alert err">{error}</div>}
      {series.length === 0 && !error && <div className="alert">No history is cached yet. Import some first.</div>}

      <div className="stack">
        <div className="f">
          <label htmlFor="nr-det">Strategy</label>
          <select id="nr-det" value={detector} onChange={(e) => setDetector(e.target.value)}>
            {strategies.map((s) => <option key={s.name} value={s.name}>{s.name} · v{s.version}</option>)}
          </select>
          {strategy?.description && <span className="hint" style={{ lineHeight: 1.5 }}>{strategy.description}</span>}
        </div>

        <div className="f">
          <label>Timeframes</label>
          {strategy?.timeframe ? (
            <div className="inline" style={{ gap: 6 }}>
              <span className="tag hot">{strategy.timeframe} · entries</span>
              {strategy.higher_timeframes.map((tf) => (
                <span key={tf} className={`tag${missing.includes(tf) ? ' bad' : ''}`}>{tf}</span>
              ))}
              <span className="hint" style={{ width: '100%' }}>Set by the strategy.</span>
            </div>
          ) : (
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} disabled={!series.length}>
              {cachedTimeframes.map((t) => <option key={t}>{t}</option>)}
            </select>
          )}
          {missing.length > 0 && (
            <div className="alert err" style={{ marginTop: 8 }}>
              {missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not cached. Import {missing.length === 1 ? 'it' : 'them'} before running this strategy.
            </div>
          )}
        </div>

        <PairPicker available={forTf.map((s) => s.symbol)} selected={symbols} onChange={setSymbols} />

        <div className="f2">
          <div className="f"><label htmlFor="nr-from">From</label><input id="nr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="f"><label htmlFor="nr-to">To</label><input id="nr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>

        {strategy && strategy.params.length > 0 && (
          <div className="f">
            <div className="spread">
              <label style={{ margin: 0 }}>{strategy.name} settings</label>
              <button type="button" className="btn3" onClick={() => setParams(defaults(strategy.params))}>reset</button>
            </div>
            <div className="f2">
              {strategy.params.map((p) => (
                <ParamField key={p.key} spec={p} value={params[p.key]}
                  onChange={(v) => setParams((cur) => ({ ...cur, [p.key]: v }))} />
              ))}
            </div>
          </div>
        )}

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

        {risk * maxOpen > 5 && (
          <div className="alert err" style={{ margin: 0 }}>
            {(risk * maxOpen).toFixed(1)}% of the account on one pair, and every pair trades the same
            account. At this size a normal losing streak wipes it out, and once the balance is gone the
            rest of the run is skipped rather than traded — the result then says more about the sizing
            than the strategy. Around 1% per trade is the usual choice.
          </div>
        )}

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

/** One setting, rendered from its declared kind. */
function ParamField({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const id = `param-${spec.key}`;
  if (spec.kind === 'bool') {
    return (
      <div className="f">
        <label htmlFor={id}>{spec.label}</label>
        <label className="inline" style={{ gap: 8, cursor: 'pointer' }}>
          <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span className="dim" style={{ fontSize: 12.5 }}>{value ? 'on' : 'off'}</span>
        </label>
        {spec.help && <span className="hint">{spec.help}</span>}
      </div>
    );
  }
  if (spec.kind === 'choice') {
    return (
      <div className="f">
        <label htmlFor={id}>{spec.label}</label>
        <select id={id} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {spec.help && <span className="hint">{spec.help}</span>}
      </div>
    );
  }
  return (
    <div className="f">
      <label htmlFor={id}>{spec.label}</label>
      <input id={id} type="number" value={Number(value ?? 0)} min={spec.min} max={spec.max}
        step={spec.step ?? (spec.kind === 'int' ? 1 : 0.1)}
        onChange={(e) => onChange(spec.kind === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value))} />
      {spec.help && <span className="hint">{spec.help}</span>}
    </div>
  );
}
