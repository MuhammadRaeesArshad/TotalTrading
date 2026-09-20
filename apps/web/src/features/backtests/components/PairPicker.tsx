import { useMemo, useState } from 'react';

/** The seven pairs everyone means by "majors". */
export const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];

/**
 * Picks a handful of pairs out of a few dozen. Sorted, searchable, and with
 * the three selections that are actually common — all, none, the majors —
 * because choosing three pairs should not mean clicking twenty-five times.
 */
export function PairPicker({
  available, selected, onChange, disabled = false,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => [...available].sort(), [available]);
  const shown = useMemo(() => {
    const q = query.trim().toUpperCase();
    return q ? sorted.filter((s) => s.includes(q)) : sorted;
  }, [sorted, query]);

  const chosen = new Set(selected);
  const majors = sorted.filter((s) => MAJORS.includes(s));
  const toggle = (s: string) =>
    onChange(chosen.has(s) ? selected.filter((x) => x !== s) : [...selected, s]);

  return (
    <div className="f">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label style={{ margin: 0 }}>
          Pairs · <span className="mono-sm">{selected.length}</span> of {sorted.length}
        </label>
        <div className="inline" style={{ gap: 4 }}>
          <button type="button" className="btn3" disabled={disabled} onClick={() => onChange(sorted)}>All</button>
          <button type="button" className="btn3" disabled={disabled} onClick={() => onChange([])}>None</button>
          {majors.length > 0 && (
            <button type="button" className="btn3" disabled={disabled} onClick={() => onChange(majors)}>Majors</button>
          )}
        </div>
      </div>

      <input
        className="inp" style={{ width: '100%' }} type="search" value={query} disabled={disabled}
        placeholder={`Filter ${sorted.length} pairs — try "JPY" or "EUR"`}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Filter pairs"
      />

      <div className="picker">
        {shown.map((s) => {
          const on = chosen.has(s);
          return (
            <button key={s} type="button" className={`pairchip${on ? ' on' : ''}`} aria-pressed={on}
              disabled={disabled} onClick={() => toggle(s)}>
              {s}
            </button>
          );
        })}
        {shown.length === 0 && (
          <span className="dimmer" style={{ fontSize: 12 }}>
            {sorted.length === 0 ? 'Nothing cached for this timeframe.' : `No pair matches "${query}".`}
          </span>
        )}
      </div>

      {selected.length === 0 && <span className="field-err">Pick at least one pair.</span>}
    </div>
  );
}
