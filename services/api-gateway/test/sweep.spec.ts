import {
  distinctCount, expandSweep, ParamSpec, valuesFor,
} from '../src/backtest/sweep';

/** A cut-down version of what `GET /detectors` serves for trend_engulf. */
const specs: ParamSpec[] = [
  {
    key: 'trend_timeframe', kind: 'choice', default: 'H1',
    options: [{ value: 'H1' }, { value: 'H4' }],
  },
  { key: 'ema_period', kind: 'int', default: 21, min: 2, max: 200 },
  { key: 'atr_threshold', kind: 'float', default: 0.5, min: 0, max: 5, step: 0.1 },
  { key: 'entry_on_m30', kind: 'bool', default: true },
  // Declared without bounds: nothing says what range is sensible.
  { key: 'mystery', kind: 'int', default: 3 },
];

describe('valuesFor', () => {
  it('walks a numeric range end to end', () => {
    const v = valuesFor(specs[2], 5) as number[];
    expect(v[0]).toBe(0);
    expect(v[v.length - 1]).toBe(5);
    expect(v).toHaveLength(5);
  });

  it('keeps integers whole', () => {
    const v = valuesFor(specs[1], 5) as number[];
    expect(v.every((n) => Number.isInteger(n))).toBe(true);
    expect(v[0]).toBe(2);
    expect(v[v.length - 1]).toBe(200);
  });

  it('does not repeat a value when the range is narrower than the sample', () => {
    const tight: ParamSpec = { key: 'k', kind: 'int', default: 1, min: 1, max: 3 };
    expect(valuesFor(tight, 9)).toEqual([1, 2, 3]);
  });

  it('sweeps both states of a switch', () => {
    expect(valuesFor(specs[3])).toEqual([false, true]);
  });

  it('sweeps every option of a choice', () => {
    expect(valuesFor(specs[0])).toEqual(['H1', 'H4']);
  });

  it('refuses to guess a range that was never declared', () => {
    // Inventing bounds would be inventing a rule about the strategy.
    expect(valuesFor(specs[4])).toEqual([]);
  });

  it('refuses a backwards or empty range', () => {
    expect(valuesFor({ key: 'k', kind: 'int', default: 1, min: 5, max: 5 })).toEqual([]);
    expect(valuesFor({ key: 'k', kind: 'int', default: 1, min: 9, max: 2 })).toEqual([]);
  });
});

describe('expandSweep', () => {
  const base = { trend_timeframe: 'H1', ema_period: 21, atr_threshold: 0.5, entry_on_m30: true, mystery: 3 };

  it('moves exactly one setting per run', () => {
    for (const cell of expandSweep(specs, base)) {
      const changed = Object.keys(base).filter(
        (k) => cell.params[k] !== (base as Record<string, unknown>)[k],
      );
      // Either it moved its own axis, or it landed on the value already there.
      expect(changed.every((k) => k === cell.axis)).toBe(true);
      expect(cell.params[cell.axis]).toBe(cell.value);
    }
  });

  it('carries the other settings through untouched', () => {
    const cells = expandSweep(specs, base);
    const onEma = cells.filter((c) => c.axis === 'ema_period');
    expect(onEma.length).toBeGreaterThan(0);
    for (const c of onEma) {
      expect(c.params.atr_threshold).toBe(0.5);
      expect(c.params.trend_timeframe).toBe('H1');
    }
  });

  it('explores around what the form was showing, not the factory defaults', () => {
    const changed = { ...base, atr_threshold: 1.5 };
    for (const c of expandSweep(specs, changed, { only: ['ema_period'] })) {
      expect(c.params.atr_threshold).toBe(1.5);
    }
  });

  it('skips a setting with no declared range', () => {
    expect(expandSweep(specs, base).some((c) => c.axis === 'mystery')).toBe(false);
  });

  it('narrows to named settings when asked', () => {
    const cells = expandSweep(specs, base, { only: ['ema_period', 'entry_on_m30'] });
    expect(new Set(cells.map((c) => c.axis))).toEqual(new Set(['ema_period', 'entry_on_m30']));
  });

  it('counts 2 + 5 + 5 + 2 for this strategy', () => {
    expect(expandSweep(specs, base)).toHaveLength(14);
  });
});

describe('distinctCount', () => {
  it('collapses the starting configuration that every axis repeats', () => {
    const base = { trend_timeframe: 'H1', ema_period: 2, atr_threshold: 0, entry_on_m30: false, mystery: 3 };
    const cells = expandSweep(specs, base);
    // Each axis includes a run sitting at the value already set, and those are
    // the same question asked four times. The fingerprint collapses them, so
    // the estimate shown before launching has to as well.
    expect(distinctCount(cells)).toBeLessThan(cells.length);
  });

  it('equals the total when nothing repeats', () => {
    const one: ParamSpec[] = [{ key: 'a', kind: 'int', default: 1, min: 1, max: 3 }];
    const cells = expandSweep(one, { a: 99 });
    expect(distinctCount(cells)).toBe(cells.length);
  });
});
