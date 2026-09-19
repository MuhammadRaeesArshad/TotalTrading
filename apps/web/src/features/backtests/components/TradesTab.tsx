import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Run, Trade } from '../types';
import { SESSIONS, isWin, rOf, sessionOf } from '../stats';
import { fmtMoney, fmtR, fmtWhen, moneyClass } from '../fmt';
import { TradePanel } from './TradePanel';

type SortKey = 'entry' | 'r-desc' | 'r-asc';

function useNarrow(query = '(max-width: 1150px)') {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

/**
 * Every trade, and the selected one drawn beside it. On a wide screen the
 * chart panel stays in view while the list scrolls; on a narrow one it opens
 * under the selected row. Arrow keys step through trades.
 */
export function TradesTab({
  run, trades, selectedId, onSelect,
}: {
  run: Run;
  trades: Trade[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const narrow = useNarrow();
  const [pair, setPair] = useState('');
  const [side, setSide] = useState('');
  const [result, setResult] = useState('');
  const [session, setSession] = useState('');
  const [sort, setSort] = useState<SortKey>('entry');

  const pairs = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);

  const shown = useMemo(() => {
    const list = trades.filter((t) =>
      (!pair || t.symbol === pair) &&
      (!side || t.direction === side) &&
      (!result || (result === 'win' ? isWin(t) : !isWin(t))) &&
      (!session || sessionOf(t.entryTime) === session));
    if (sort === 'r-desc') list.sort((a, b) => rOf(b) - rOf(a));
    else if (sort === 'r-asc') list.sort((a, b) => rOf(a) - rOf(b));
    return list;
  }, [trades, pair, side, result, session, sort]);

  const selected = trades.find((t) => t._id === selectedId) ?? null;

  // Keep something selected so the panel is never empty on arrival.
  useEffect(() => {
    if (!selected && shown.length) onSelect(shown[0]._id);
  }, [selected, shown, onSelect]);

  const step = (dir: 1 | -1) => {
    const i = shown.findIndex((t) => t._id === selectedId);
    const next = shown[Math.min(Math.max(i + dir, 0), shown.length - 1)];
    if (next) {
      onSelect(next._id);
      document.getElementById(`trade-${next._id}`)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const wins = shown.filter(isWin).length;
  const sumR = shown.reduce((a, t) => a + rOf(t), 0);

  return (
    <div className="split">
      <div className="card">
        <div className="filters">
          <select className="sel" aria-label="Pair" value={pair} onChange={(e) => setPair(e.target.value)}>
            <option value="">All pairs</option>
            {pairs.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select className="sel" aria-label="Side" value={side} onChange={(e) => setSide(e.target.value)}>
            <option value="">Long and short</option>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
          <select className="sel" aria-label="Result" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">Wins and losses</option>
            <option value="win">Wins</option>
            <option value="loss">Losses</option>
          </select>
          <select className="sel" aria-label="Session" value={session} onChange={(e) => setSession(e.target.value)}>
            <option value="">All sessions</option>
            {SESSIONS.map((s) => <option key={s.name}>{s.name}</option>)}
          </select>
          <select className="sel" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="entry">By entry time</option>
            <option value="r-desc">Best first</option>
            <option value="r-asc">Worst first</option>
          </select>
          <span className="count">
            {shown.length} trades · {shown.length ? Math.round((wins / shown.length) * 100) : 0}% won ·{' '}
            <span className={moneyClass(sumR)}>{fmtR(sumR, 1)}</span>
          </span>
        </div>

        <div className="tw tl-scroll" tabIndex={0} aria-label="Trades. Use arrow keys to move between them."
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
            if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
          }}>
          <table className="tl">
            <thead>
              <tr>
                <th>Entered (UTC)</th><th>Pair</th><th>Side</th><th className="opt">Session</th>
                <th className="r opt">Held</th><th className="r opt">Against</th><th className="r">Result</th><th className="r">Net</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <Fragment key={t._id}>
                  <tr id={`trade-${t._id}`} className={t._id === selectedId ? 'sel' : ''}
                    aria-selected={t._id === selectedId} onClick={() => onSelect(t._id)}>
                    <td className="mono-sm">{fmtWhen(t.entryTime)}</td>
                    <td>{t.symbol}</td>
                    <td className="dir">{t.direction.toUpperCase()}</td>
                    <td className="dim opt">{sessionOf(t.entryTime)}</td>
                    <td className="r mono-sm dim opt">{t.barsHeld ?? '—'}</td>
                    <td className="r mono-sm dim opt">{t.maeR != null ? `${t.maeR.toFixed(2)}R` : '—'}</td>
                    <td className="r mono-sm">
                      <span className={`rg ${isWin(t) ? 'w' : 'l'}`} aria-hidden="true" />
                      <span className={moneyClass(t.netProfit)}>{fmtR(t.rMultiple)}</span>
                      {t.ambiguousExit && <span className="amb" title="Decided by the intrabar tie-break">AMB</span>}
                    </td>
                    <td className={`r mono-sm ${moneyClass(t.netProfit)}`}>{fmtMoney(t.netProfit)}</td>
                  </tr>
                  {narrow && t._id === selectedId && (
                    <tr className="inline-detail"><td colSpan={8}><TradePanel runId={run._id} trade={t} /></td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty"><p>No trades match these filters.</p></div>}
        </div>
      </div>

      {!narrow && (
        <div className="detail">
          {selected ? <TradePanel runId={run._id} trade={selected} /> : <div className="card empty"><p>Pick a trade to see how it was taken.</p></div>}
        </div>
      )}
    </div>
  );
}
