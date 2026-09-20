import { useMemo, useState } from 'react';
import type { Trade } from '../types';
import { SESSIONS, groupBy, monthKey, rHistogram, sessionOf, summarize, yearOf } from '../stats';
import { fmtR, moneyClass, MONTHS } from '../fmt';
import { MonthHeatmap, PairBars, RHistogram, SessionBars } from './AnatomyCharts';

interface Filters { session: string | null; pair: string | null; month: string | null }

/** Below this many trades a slice is noise, and the page says so. */
const SMALL_SAMPLE = 30;

/**
 * Where does the edge live? Ignore time and slice the results. Clicking a bar
 * or cell filters every other chart. This is the strongest overfitting trap on
 * the page, so the sample size of every slice is always on screen.
 */
export function AnatomyTab({ trades, initialBalance, activePair, activeSession, onPickPair, onPickSession }: {
  trades: Trade[];
  initialBalance: number;
  /** The page's filter, when it names exactly one — so the bar can show lit. */
  activePair: string | null;
  activeSession: string | null;
  onPickPair: (pair: string) => void;
  onPickSession: (session: string) => void;
}) {
  // Only the month stays here: the page's filter carries a date range, and a
  // month is a shorthand for one that the other tabs have no use for.
  const [f, setF] = useState<Filters>({ session: null, pair: null, month: null });

  // Each chart is filtered by every active filter except its own, so picking
  // "London" still shows all sessions — only the other charts narrow.
  const { base, bySession, byPair, byMonth } = useMemo(() => {
    const keep = (except?: keyof Filters) => trades.filter((t) =>
      (except === 'session' || !f.session || sessionOf(t.entryTime) === f.session) &&
      (except === 'pair' || !f.pair || t.symbol === f.pair) &&
      (except === 'month' || !f.month || monthKey(t.exitTime) === f.month));
    return {
      base: keep(),
      bySession: groupBy(keep('session'), (t) => sessionOf(t.entryTime)),
      byPair: groupBy(keep('pair'), (t) => t.symbol),
      byMonth: groupBy(keep('month'), (t) => monthKey(t.exitTime)),
    };
  }, [trades, f]);
  const years = useMemo(() => [...new Set(trades.map((t) => yearOf(t.exitTime)))].sort(), [trades]);
  const s = summarize(base, initialBalance);

  const toggle = (k: keyof Filters) => (v: string) => setF((cur) => ({ ...cur, [k]: cur[k] === v ? null : v }));
  const chips = (Object.keys(f) as (keyof Filters)[]).filter((k) => f[k]);
  const monthLabel = (k: string) => { const [y, m] = k.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };

  return (
    <div className="stack">
      <div className="inline" style={{ minHeight: 30, fontSize: 12.5, color: 'var(--fg-3)' }}>
        {chips.length === 0 && <span>Click a pair or a session to filter the whole report; click a month to slice these charts.</span>}
        {chips.map((k) => (
          <span key={k} className="fchip">
            {k === 'month' ? monthLabel(f[k]!) : f[k]}
            <button aria-label={`Remove ${f[k]} filter`} onClick={() => setF((cur) => ({ ...cur, [k]: null }))}>×</button>
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }} className="mono-sm">
          {base.length} trades · <span className={moneyClass(s.expR)}>{fmtR(s.expR)}</span> avg
          {base.length > 0 && base.length < SMALL_SAMPLE && <b style={{ color: 'var(--fg)', marginLeft: 8 }}>small sample</b>}
        </span>
      </div>

      <div className="grid g2" style={{ marginBottom: 0 }}>
        <Panel title="R-multiple distribution" note="two spikes at −1R and the target mean exits behave">
          <RHistogram counts={rHistogram(base)} />
        </Panel>
        <Panel title="Win rate by session" note="entry time, UTC · click to filter">
          <SessionBars groups={bySession} order={SESSIONS.map((x) => x.name)} active={activeSession} onPick={onPickSession} />
        </Panel>
        <Panel title="Net R by pair" note="click to filter">
          <PairBars groups={byPair} active={activePair} onPick={onPickPair} />
        </Panel>
        <Panel title="Net R by month" note="exit month · click to filter">
          <MonthHeatmap groups={byMonth} years={years} active={f.month} onPick={toggle('month')} />
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-h"><div><h3>{title}</h3><p>{note}</p></div></div>
      <div style={{ padding: '10px 12px 8px' }}>{children}</div>
    </div>
  );
}
