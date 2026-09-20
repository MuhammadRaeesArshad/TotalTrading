import { useMemo, useState } from 'react';
import { SESSIONS } from '../stats';
import { activeCount, EMPTY_FILTER, isEmptyFilter, TradeFilter } from '../filter';
import { fmtR, moneyClass } from '../fmt';
import type { Trade } from '../types';

/**
 * The filter, owned by the page and applied to every tab below it.
 *
 * Sessions and pairs are multi-select because the questions worth asking are
 * combinations — "London and the overlap", "the three majors" — and the old
 * one-at-a-time selects could not express them.
 *
 * What survives is stated on the bar itself. A filter that silently drops most
 * of the trades makes every number beneath it a different claim from the one
 * in the header, and that has to be visible without scrolling.
 */
export function FilterBar({
  all, shown, value, onChange,
}: {
  /** Every trade in the run, for the lists of what can be picked. */
  all: Trade[];
  /** What survived, for the count. */
  shown: Trade[];
  value: TradeFilter;
  onChange: (next: TradeFilter) => void;
}) {
  const [openPairs, setOpenPairs] = useState(false);
  const [openMonths, setOpenMonths] = useState(false);
  const pairs = useMemo(() => [...new Set(all.map((t) => t.symbol))].sort(), [all]);
  // Only months that exist: offering an empty one invites a filter that
  // silently matches nothing.
  const months = useMemo(
    () => [...new Set(all.map((t) => t.exitTime.slice(0, 7)))].sort(),
    [all],
  );
  const set = (patch: Partial<TradeFilter>) => onChange({ ...value, ...patch });

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const wins = shown.filter((t) => t.netProfit >= 0).length;
  const sumR = shown.reduce((a, t) => a + (t.rMultiple ?? 0), 0);
  const n = activeCount(value);
  const dropped = all.length - shown.length;

  return (
    <div className="filterbar">
      <div className="filterbar-row">
        <button className={`sel selbtn${value.pairs.length ? ' on' : ''}`}
          aria-expanded={openPairs} onClick={() => setOpenPairs((o) => !o)}>
          {value.pairs.length === 0 ? 'All pairs'
            : value.pairs.length === 1 ? value.pairs[0]
              : `${value.pairs.length} pairs`}
        </button>

        <button className={`sel selbtn${value.months.length ? ' on' : ''}`}
          aria-expanded={openMonths} onClick={() => setOpenMonths((o) => !o)}>
          {value.months.length === 0 ? 'All months'
            : `${value.months.length} month${value.months.length === 1 ? '' : 's'} ${value.monthsMode === 'exclude' ? 'excluded' : 'only'}`}
        </button>

        <select className="sel" aria-label="Side" value={value.side}
          onChange={(e) => set({ side: e.target.value as TradeFilter['side'] })}>
          <option value="">Long and short</option>
          <option value="long">Long only</option>
          <option value="short">Short only</option>
        </select>

        <select className="sel" aria-label="Result" value={value.result}
          onChange={(e) => set({ result: e.target.value as TradeFilter['result'] })}>
          <option value="">Wins and losses</option>
          <option value="win">Wins only</option>
          <option value="loss">Losses only</option>
        </select>

        <input className="sel" type="date" aria-label="From" value={value.from}
          onChange={(e) => set({ from: e.target.value })} />
        <input className="sel" type="date" aria-label="To" value={value.to}
          onChange={(e) => set({ to: e.target.value })} />

        {!isEmptyFilter(value) && (
          <button className="btn3" onClick={() => onChange(EMPTY_FILTER)}>
            Clear {n === 1 ? 'filter' : `all ${n}`}
          </button>
        )}
      </div>

      <div className="filterbar-row">
        <span className="chipset" role="group" aria-label="Sessions">
          {SESSIONS.map((s) => {
            const on = value.sessions.includes(s.name);
            return (
              <button key={s.name} className={`chip${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => set({ sessions: toggle(value.sessions, s.name) })}>
                {s.name}
              </button>
            );
          })}
        </span>

        <span className="filterbar-count">
          <strong>{shown.length.toLocaleString()}</strong> trades
          {dropped > 0 && <span className="dimmer"> of {all.length.toLocaleString()}</span>}
          {' · '}{shown.length ? Math.round((wins / shown.length) * 100) : 0}% won
          {' · '}<span className={moneyClass(sumR)}>{fmtR(sumR, 1)}</span>
        </span>
      </div>

      {openMonths && (
        <div className="filterbar-pairs">
          <button className="btn3" onClick={() => set({ months: [] })}>All</button>
          {/* Naming one bad month is easier than naming the thirty-five good
              ones around it, so the same list can mean keep or drop. */}
          <button className="btn3"
            onClick={() => set({ monthsMode: value.monthsMode === 'exclude' ? 'include' : 'exclude' })}>
            {value.monthsMode === 'exclude' ? 'excluding these' : 'only these'}
          </button>
          {months.map((m) => {
            const on = value.months.includes(m);
            return (
              <button key={m} className={`chip${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => set({ months: toggle(value.months, m) })}>
                {m}
              </button>
            );
          })}
        </div>
      )}

      {openPairs && (
        <div className="filterbar-pairs">
          <button className="btn3" onClick={() => set({ pairs: [] })}>All</button>
          {pairs.map((p) => {
            const on = value.pairs.includes(p);
            return (
              <button key={p} className={`chip${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => set({ pairs: toggle(value.pairs, p) })}>
                {p}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
