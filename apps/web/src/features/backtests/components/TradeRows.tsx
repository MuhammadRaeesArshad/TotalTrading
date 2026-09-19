import type { Trade } from '../types';
import { isWin, sessionOf } from '../stats';
import { fmtMoney, fmtR, fmtWhen, moneyClass } from '../fmt';

/**
 * A short trade table used inside the analysis tabs. Every row opens the trade
 * in the Trades tab, so any number on the page is one click from its evidence.
 */
export function TradeRows({
  groups, limit = 12, onOpen,
}: {
  groups: { label?: string; trades: Trade[] }[];
  limit?: number;
  onOpen: (id: string) => void;
}) {
  const per = Math.ceil(limit / groups.length);
  const total = groups.reduce((a, g) => a + g.trades.length, 0);
  const shown = groups.reduce((a, g) => a + Math.min(g.trades.length, per), 0);
  return (
    <div className="tw">
      <table className="tl">
        <thead>
          <tr><th>Entered (UTC)</th><th>Pair</th><th>Side</th><th className="opt">Session</th><th className="r">Result</th><th className="r">Net</th></tr>
        </thead>
        <tbody>
          {groups.map((g, gi) => [
            g.label ? (
              <tr key={`g${gi}`}>
                <td colSpan={6} style={{ background: 'var(--surface)', color: 'var(--fg-3)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', cursor: 'default' }}>
                  {g.label}
                </td>
              </tr>
            ) : null,
            ...g.trades.slice(0, per).map((t) => (
              <tr key={t._id} onClick={() => onOpen(t._id)} tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t._id); }}>
                <td className="mono-sm">{fmtWhen(t.entryTime)}</td>
                <td>{t.symbol}</td>
                <td className="dir">{t.direction.toUpperCase()}</td>
                <td className="dim opt">{sessionOf(t.entryTime)}</td>
                <td className="r mono-sm">
                  <span className={`rg ${isWin(t) ? 'w' : 'l'}`} aria-hidden="true" />
                  <span className={moneyClass(t.netProfit)}>{fmtR(t.rMultiple)}</span>
                </td>
                <td className={`r mono-sm ${moneyClass(t.netProfit)}`}>{fmtMoney(t.netProfit)}</td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
      {total > shown && <div style={{ padding: '9px 12px', fontSize: 12, color: 'var(--fg-3)' }}>+ {total - shown} more — open the Trades tab to see them all</div>}
    </div>
  );
}
