import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { backtestApi } from '../features/backtests/api';
import type { ParamSpec, Run, Strategy } from '../features/backtests/types';
import { PageHeader } from '../components/PageHeader';
import { fmtR, money0, moneyClass } from '../features/backtests/fmt';

/**
 * What the engine can actually run, read from the engine.
 *
 * `GET /detectors` is already the single source of truth for the New backtest
 * form — description, timeframes and a schema per setting. This page shows the
 * same answer without making you open the form to see it, so "what is
 * `trend_engulf` and what can I turn on it" has a place to be asked.
 *
 * Nothing here is hand-written per strategy. A fourth one appears the moment
 * its factory is registered.
 */

/** How a setting's default reads on screen. */
function defaultOf(p: ParamSpec): string {
  const v = p.default;
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'object') return 'per pair';
  const label = p.options?.find((o) => o.value === String(v))?.label;
  return label ?? String(v);
}

/** The range a sweep would walk, when the setting declares one. */
function rangeOf(p: ParamSpec): string {
  if (p.kind === 'choice' || p.kind === 'pair_choice') {
    return p.options?.map((o) => o.label).join(' · ') ?? '—';
  }
  if (p.kind === 'bool') return 'on / off';
  if (p.min === undefined || p.max === undefined) return '—';
  return `${p.min} – ${p.max}${p.step ? ` step ${p.step}` : ''}`;
}

const KIND_LABEL: Record<ParamSpec['kind'], string> = {
  int: 'whole number',
  float: 'decimal',
  bool: 'on/off',
  choice: 'one of',
  pair_choice: 'one of, per pair',
};

function Timeframes({ s }: { s: Strategy }) {
  // An empty `timeframe` means the strategy runs on whatever it is handed.
  const base = s.timeframe || 'any';
  return (
    <div className="kv">
      <span>Runs on</span>
      <b className="f-mono">{base}</b>
      {s.higher_timeframes.length > 0 && (
        <>
          <span>Reads for context</span>
          <b className="f-mono">{s.higher_timeframes.join(', ')}</b>
        </>
      )}
    </div>
  );
}

/** A strategy's runs, folded into one line. */
function RunSummary({ runs, name }: { runs: Run[]; name: string }) {
  const mine = runs.filter((r) => r.detector === name && r.status === 'completed');
  if (!mine.length) {
    return <p className="meta">No completed backtests on this strategy yet.</p>;
  }

  // Versions are not comparable (rule 6), so they are counted apart rather
  // than averaged into one misleading figure.
  const versions = [...new Set(mine.map((r) => r.detectorVersion ?? 0))].sort((a, b) => b - a);
  const best = mine.reduce((a, r) =>
    (r.metrics?.expectancyR ?? -Infinity) > (a.metrics?.expectancyR ?? -Infinity) ? r : a,
  );

  return (
    <p className="meta">
      {mine.length} completed run{mine.length === 1 ? '' : 's'}
      {versions.length > 1 && ` across v${versions.join(', v')}`}. Best expectancy{' '}
      <Link className="link" to={`/backtests/${best._id}`}>
        <b className={moneyClass(best.metrics?.expectancyR)}>
          {fmtR(best.metrics?.expectancyR)}
        </b>
      </Link>{' '}
      on {best.symbols.length} pair{best.symbols.length === 1 ? '' : 's'}
      {best.metrics && <> · {money0(best.metrics.finalEquity)} final equity</>}.
    </p>
  );
}

function StrategyCard({ s, runs }: { s: Strategy; runs: Run[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3 className="t-name f-mono">{s.name}</h3>
          <span className="t-sub">{s.description}</span>
        </div>
        <span className="tag">v{s.version}</span>
      </div>

      <div className="card-b">
        <Timeframes s={s} />
        <RunSummary runs={runs} name={s.name} />

        <button className="btn3 disclose" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'} {s.params.length} setting
          {s.params.length === 1 ? '' : 's'}
        </button>

        {open && (
          <table className="rep">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Type</th>
                <th>Default</th>
                <th>Range</th>
              </tr>
            </thead>
            <tbody>
              {s.params.map((p) => (
                <tr key={p.key}>
                  <td>
                    <b>{p.label}</b>
                    <div className="f-mono mono-sm">{p.key}</div>
                    {p.help && <div className="meta">{p.help}</div>}
                  </td>
                  <td className="meta">{KIND_LABEL[p.kind]}</td>
                  <td className="f-mono">{defaultOf(p)}</td>
                  <td className="f-mono mono-sm">{rangeOf(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card-f">
        <Link className="btn btn-sm" to={`/backtests?detector=${s.name}`}>
          Backtest this
        </Link>
      </div>
    </div>
  );
}

export function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    backtestApi
      .detectors()
      .then((d) => !cancelled && setStrategies(d.strategies))
      .catch(
        (e) =>
          !cancelled &&
          setError(
            e instanceof ApiError
              ? e.message
              : 'Could not reach the engine. Is it running on port 8004?',
          ),
      );
    // Runs only decorate the cards, so failing to load them costs a line of
    // detail rather than the page.
    backtestApi.runs().then((r) => !cancelled && setRuns(r)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <PageHeader
        title="Strategies"
        lede="Every rule set the engine can run, with the settings each one exposes. Read straight from the engine — this is the same schema the New backtest form builds itself from."
      />

      {error && <div className="alert">{error}</div>}

      {!strategies && !error && <div className="skel" style={{ height: 200 }} />}

      {strategies?.length === 0 && (
        <div className="empty">The engine has no strategies registered.</div>
      )}

      <div className="stack">
        {strategies?.map((s) => (
          <StrategyCard key={s.name} s={s} runs={runs} />
        ))}
      </div>

      {strategies && strategies.length > 0 && (
        <p className="note">
          Changing what a rule means bumps the version beside it, and stored
          backtests keep the version that produced them. Results from different
          versions are not comparable and are never charted together.
        </p>
      )}
    </>
  );
}
