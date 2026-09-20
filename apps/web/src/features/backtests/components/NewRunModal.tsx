import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { Modal } from '../../../components/Modal';
import { backtestApi } from '../api';
import type { CachedSeries, CapitalMode, IntrabarPolicy, ParamSpec, Run, SizingMode, Strategy, Sweep } from '../types';
import { sweepSize } from '../sweep';
import { PairPicker } from './PairPicker';
import { DateRange } from './DateRange';

const toDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const fromDay = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

const defaults = (specs: ParamSpec[]): Record<string, unknown> =>
  Object.fromEntries(specs.map((p) => [p.key, p.default]));

/**
 * Starts a backtest. Everything below the pair list comes from the strategy
 * itself — its description, the timeframes it reads and its own settings — so
 * a new strategy needs no change here.
 */
export function NewRunModal({ open, onClose, onStarted, onSwept }: {
  open: boolean;
  onClose: () => void;
  onStarted: (run: Run) => void;
  onSwept: (sweep: Sweep) => void;
}) {
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
  const [capital, setCapital] = useState<CapitalMode>('per_symbol');
  const [sizing, setSizing] = useState<SizingMode>('fixed');
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
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
  }, [forTf]);

  // The window every selected pair can actually cover: the latest start and
  // the earliest end, so no pair contributes an empty stretch.
  const coverage = useMemo(() => {
    const chosen = forTf.filter((s) => symbols.includes(s.symbol));
    const firsts = chosen.map((s) => s.first_ts).filter((v): v is number => v != null);
    const lasts = chosen.map((s) => s.last_ts).filter((v): v is number => v != null);
    if (!firsts.length || !lasts.length) return { min: '', max: '' };
    return { min: toDay(Math.max(...firsts)), max: toDay(Math.min(...lasts)) };
  }, [forTf, symbols]);

  // Default to everything covered, and follow the coverage as pairs change
  // unless the window was narrowed by hand.
  useEffect(() => {
    if (!coverage.min || !coverage.max) return;
    setFrom((cur) => (!cur || cur < coverage.min ? coverage.min : cur));
    setTo((cur) => (!cur || cur > coverage.max ? coverage.max : cur));
  }, [coverage]);

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
        sim: { riskPercent: risk, maxOpenPerSymbol: maxOpen, intrabar, capital, sizing },
        params,
      });
      onStarted(run);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The backtest could not start.');
    } finally {
      setBusy(false);
    }
  }

  async function submitSweep() {
    setSweeping(true);
    setError(null);
    try {
      const sweep = await backtestApi.startSweep({
        detector,
        symbols,
        timeframe,
        higherTimeframes: strategy?.higher_timeframes ?? [],
        fromTs: fromDay(from),
        toTs: fromDay(to) + 86_399,
        sim: { riskPercent: risk, maxOpenPerSymbol: maxOpen, intrabar, capital, sizing },
        params,
      });
      onSwept(sweep);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The sweep could not start.');
    } finally {
      setSweeping(false);
    }
  }

  const valid = detector && timeframe && symbols.length && from && to && from < to && missing.length === 0;
  // What a sweep of this strategy would actually cost, worked out here rather
  // than promised vaguely — the repeats collapse, so the honest number is the
  // distinct one.
  const sweep = useMemo(() => sweepSize(strategy?.params ?? [], params), [strategy, params]);

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose}
      title="New backtest"
      description="Replays cached history through a strategy. Costs are pessimistic: spread and slippage on every fill, ambiguous bars scored against the strategy."
      footer={<>
        <button className="btn2" onClick={onClose} disabled={busy || sweeping}>Cancel</button>
        <button className="btn2" onClick={submitSweep} disabled={busy || sweeping || !valid || sweep.distinct === 0}
          title={sweep.distinct === 0 ? 'This strategy declares no settings with a range' : undefined}>
          {sweeping ? 'Queueing…' : `Sweep all settings · ${sweep.distinct} runs`}
        </button>
        <button className="btn" onClick={submit} disabled={busy || sweeping || !valid}>{busy ? 'Starting…' : 'Run backtest'}</button>
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

        <DateRange from={from} to={to} min={coverage.min} max={coverage.max}
          onChange={(f, t) => { setFrom(f); setTo(t); }} />

        {strategy && strategy.params.length > 0 && (
          <div className="f">
            <div className="spread">
              <label style={{ margin: 0 }}>{strategy.name} settings</label>
              <button type="button" className="btn3" onClick={() => setParams(defaults(strategy.params))}>reset</button>
            </div>
            <div className="f2">
              {strategy.params.map((p) => (
                <ParamField key={p.key} spec={p} value={params[p.key]} pairs={symbols}
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

        <div className="f">
          <label htmlFor="nr-size">Risk is a percent of</label>
          <select id="nr-size" value={sizing} onChange={(e) => setSizing(e.target.value as SizingMode)}>
            <option value="fixed">The starting balance — every signal gets tested</option>
            <option value="compound">Equity as it stands — the account can be wiped out</option>
          </select>
          <span className="hint">
            {sizing === 'fixed'
              ? 'The account cannot run out, so a losing stretch never silently stops the run answering. Money is linear in R here, so read the R figures.'
              : 'What a real account does. Once the balance reaches zero every later signal is skipped for being under the minimum lot while the metrics keep reporting — a bad result may be measuring how fast it died.'}
          </span>
        </div>

        <div className="f">
          <label htmlFor="nr-cap">Capital</label>
          <select id="nr-cap" value={capital} onChange={(e) => setCapital(e.target.value as CapitalMode)}>
            <option value="shared">One $10,000 account, shared by every pair</option>
            <option value="per_symbol">$10,000 per pair, kept separate</option>
          </select>
          <span className="hint">
            {capital === 'shared'
              ? `What you actually trade: ${symbols.length} pairs competing for one balance, and a drawdown on one shrinking the next position on another.`
              : `${symbols.length} pairs × $10,000 = $${(symbols.length * 10_000).toLocaleString()} deployed. Each pair's result is its own, so it does not change when you add or drop other pairs.`}
          </span>
        </div>

        {sweep.distinct > 0 && (
          <div className="alert" style={{ margin: 0 }}>
            <strong>Sweep all settings</strong> runs this same window {sweep.distinct} times, moving
            one setting at a time across the range it declares and leaving the rest where they are
            above. It is {sweep.total} combinations, of which {sweep.total - sweep.distinct} are the
            settings you already have and are not recomputed. Runs go one at a time, and you can
            stop it part way — whatever finished is kept.
          </div>
        )}

        {risk * maxOpen > 5 && (
          <div className="alert err" style={{ margin: 0 }}>
            {(risk * maxOpen).toFixed(1)}% of the account on one pair
            {capital === 'shared' && ', and every pair trades the same account'}. At this size a normal
            losing streak wipes it out, and once the balance is gone the rest of the run is skipped
            rather than traded — the result then says more about the sizing than the strategy.
            Around 1% per trade is the usual choice.
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
function ParamField({ spec, value, pairs, onChange }: {
  spec: ParamSpec;
  value: unknown;
  /** The pairs this run covers, for a per-pair setting. */
  pairs: string[];
  onChange: (v: unknown) => void;
}) {
  const id = `param-${spec.key}`;

  // A setting that can differ per pair: one row per pair, blank meaning "use
  // the run's value". Only pairs actually named are sent, so the map stays
  // small and a pair dropped from the run leaves nothing behind.
  if (spec.kind === 'pair_choice') {
    const map = (value ?? {}) as Record<string, string>;
    const set = (pair: string, v: string) => {
      const next = { ...map };
      if (v) next[pair] = v;
      else delete next[pair];
      onChange(next);
    };
    const named = Object.keys(map).length;
    return (
      <div className="f" style={{ gridColumn: '1 / -1' }}>
        <div className="spread">
          <label style={{ margin: 0 }}>{spec.label}</label>
          <span className="hint" style={{ margin: 0 }}>
            {named === 0 ? 'every pair uses the setting above' : `${named} set individually`}
          </span>
        </div>
        {spec.help && <span className="hint">{spec.help}</span>}
        <div className="perpair">
          {pairs.map((pair) => (
            <label key={pair} className="perpair-row">
              <span className="mono-sm">{pair}</span>
              <select value={map[pair] ?? ''} onChange={(e) => set(pair, e.target.value)}>
                <option value="">Use the setting above</option>
                {(spec.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          ))}
          {pairs.length === 0 && <span className="hint">Pick some pairs first.</span>}
        </div>
      </div>
    );
  }
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
