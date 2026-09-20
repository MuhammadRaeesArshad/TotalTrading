import { fmtDate } from '../fmt';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * The window to test over. Presets do the common spans in one click, and the
 * cached coverage is on screen so you cannot silently ask for years the
 * terminal never had — picking those would just produce an empty stretch at
 * the front of the equity curve.
 */
export function DateRange({
  from, to, min, max, onChange,
}: {
  from: string;
  to: string;
  /** First and last day actually cached across the chosen pairs. */
  min: string;
  max: string;
  onChange: (from: string, to: string) => void;
}) {
  const clamp = (day: string) => {
    if (min && day < min) return min;
    if (max && day > max) return max;
    return day;
  };

  const back = (years: number) => {
    const end = max ? ms(max) : Date.now();
    const start = new Date(end);
    start.setUTCFullYear(start.getUTCFullYear() - years);
    onChange(clamp(iso(Math.max(start.getTime(), min ? ms(min) : 0))), clamp(iso(end)));
  };

  const presets: [string, () => void][] = [
    ['All cached', () => onChange(min, max)],
    ['5 years', () => back(5)],
    ['3 years', () => back(3)],
    ['1 year', () => back(1)],
    ['YTD', () => {
      const end = max ? ms(max) : Date.now();
      const jan1 = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
      onChange(clamp(iso(Math.max(jan1, min ? ms(min) : 0))), clamp(iso(end)));
    }],
  ];

  const isAll = from === min && to === max;
  const span = from && to ? Math.max(0, Math.round((ms(to) - ms(from)) / DAY)) : 0;
  const years = (span / 365).toFixed(1);
  const tooEarly = Boolean(min && from && from < min);
  const invalid = Boolean(from && to && from >= to);

  return (
    <div className="f">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label style={{ margin: 0 }}>Window</label>
        <div className="inline" style={{ gap: 4 }}>
          {presets.map(([label, apply]) => (
            <button key={label} type="button" className="btn3"
              aria-pressed={label === 'All cached' && isAll}
              style={label === 'All cached' && isAll ? { background: 'var(--surface-3)', color: 'var(--fg)' } : undefined}
              onClick={apply} disabled={!min || !max}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="f2">
        <input type="date" value={from} min={min} max={max} aria-label="From"
          onChange={(e) => onChange(clamp(e.target.value), to)} />
        <input type="date" value={to} min={min} max={max} aria-label="To"
          onChange={(e) => onChange(from, clamp(e.target.value))} />
      </div>

      {min && max ? (
        <span className="hint">
          Cached: {fmtDate(`${min}T00:00:00Z`)} – {fmtDate(`${max}T00:00:00Z`)}
          {span > 0 && !invalid && <> · testing {years} years</>}
        </span>
      ) : (
        <span className="hint">Nothing cached for these pairs yet.</span>
      )}
      {invalid && <span className="field-err">The start must come before the end.</span>}
      {tooEarly && <span className="field-err">History starts {fmtDate(`${min}T00:00:00Z`)}; earlier dates have no bars.</span>}
    </div>
  );
}
