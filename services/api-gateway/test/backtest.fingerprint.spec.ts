import {
  CellSpec, fingerprint, SIM_DEFAULTS, withSimDefaults,
} from '../src/backtest/backtest.fingerprint';

/**
 * The cache is only safe if this function is exactly right in both directions:
 * requests that mean the same thing must collide, and requests that would
 * produce different numbers must never collide.
 */
const base: CellSpec = {
  detector: 'trend_engulf',
  detectorVersion: 1,
  params: { ema_period: 21, atr_threshold: 0.5 },
  symbols: ['EURUSD'],
  timeframe: 'M15',
  higherTimeframes: ['H1', 'H4'],
  fromTs: 1_600_000_000,
  toTs: 1_700_000_000,
  sim: { ...SIM_DEFAULTS },
  engineVersion: 'rust-0.1.0',
};

describe('fingerprint', () => {
  it('is stable across repeated calls', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('ignores the order settings were written in', () => {
    const swapped = { ...base, params: { atr_threshold: 0.5, ema_period: 21 } };
    expect(fingerprint(swapped)).toBe(fingerprint(base));
  });

  it('ignores the order pairs and timeframes were listed in', () => {
    const shuffled: CellSpec = {
      ...base,
      symbols: ['GBPUSD', 'EURUSD'],
      higherTimeframes: ['H4', 'H1'],
    };
    const other: CellSpec = {
      ...base,
      symbols: ['EURUSD', 'GBPUSD'],
      higherTimeframes: ['H1', 'H4'],
    };
    expect(fingerprint(shuffled)).toBe(fingerprint(other));
  });

  it('ignores a repeated pair', () => {
    expect(fingerprint({ ...base, symbols: ['EURUSD', 'EURUSD'] })).toBe(fingerprint(base));
  });

  // Each of these changes the numbers, so each must change the key. A miss
  // here means a stale result served for a different question.
  const differs: [string, Partial<CellSpec>][] = [
    ['a different detector', { detector: 'smc_mtf' }],
    ['a rule version bump', { detectorVersion: 2 }],
    ['a changed setting', { params: { ema_period: 34, atr_threshold: 0.5 } }],
    ['an extra setting', { params: { ema_period: 21, atr_threshold: 0.5, sl_pips: 5 } }],
    ['another pair', { symbols: ['EURUSD', 'GBPUSD'] }],
    ['a different base timeframe', { timeframe: 'M30' }],
    ['one fewer higher timeframe', { higherTimeframes: ['H1'] }],
    ['a different start', { fromTs: 1_600_000_001 }],
    ['a different end', { toTs: 1_700_000_001 }],
    ['a new engine build', { engineVersion: 'rust-0.2.0' }],
    ['more risk', { sim: { ...SIM_DEFAULTS, riskPercent: 2 } }],
    ['per-pair capital', { sim: { ...SIM_DEFAULTS, capital: 'per_symbol' } }],
    ['the optimistic policy', { sim: { ...SIM_DEFAULTS, intrabar: 'optimistic' } }],
    ['a wider spread', { sim: { ...SIM_DEFAULTS, extraSpreadPoints: 2 } }],
    ['different commission', { sim: { ...SIM_DEFAULTS, commissionPerLot: 0 } }],
    ['more concurrent positions', { sim: { ...SIM_DEFAULTS, maxOpenPerSymbol: 1 } }],
    ['a different balance', { sim: { ...SIM_DEFAULTS, initialBalance: 50_000 } }],
  ];

  it.each(differs)('changes when %s', (_label, patch) => {
    expect(fingerprint({ ...base, ...patch })).not.toBe(fingerprint(base));
  });

  it('gives every one of those a distinct key', () => {
    const keys = new Set(differs.map(([, patch]) => fingerprint({ ...base, ...patch })));
    expect(keys.size).toBe(differs.length);
  });

  it('treats an omitted setting as its default', () => {
    // The form sends nothing for what it did not touch; the engine fills the
    // same blanks. Both are the same run and must be the same key.
    const sparse = fingerprint({ ...base, sim: withSimDefaults({ riskPercent: 1 }) });
    expect(sparse).toBe(fingerprint(base));
  });

  it('treats nested settings the same however they are ordered', () => {
    const a = { ...base, params: { outer: { b: 2, a: 1 }, list: [1, 2] } };
    const b = { ...base, params: { list: [1, 2], outer: { a: 1, b: 2 } } };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('does not confuse a list order that does matter', () => {
    const a = { ...base, params: { levels: [1, 2] } };
    const b = { ...base, params: { levels: [2, 1] } };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('withSimDefaults', () => {
  it('fills only what was left out', () => {
    const out = withSimDefaults({ riskPercent: 5 });
    expect(out.riskPercent).toBe(5);
    expect(out.maxOpenPerSymbol).toBe(SIM_DEFAULTS.maxOpenPerSymbol);
  });

  it('keeps a zero the caller meant', () => {
    // 0 is falsy and a legitimate setting: commission-free must not become 7.
    expect(withSimDefaults({ commissionPerLot: 0 }).commissionPerLot).toBe(0);
  });

  it('matches the engine defaults it mirrors', () => {
    expect(withSimDefaults(undefined)).toEqual(SIM_DEFAULTS);
  });
});
