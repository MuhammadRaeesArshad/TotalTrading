import { createHash } from 'node:crypto';

/**
 * A backtest is a pure function of its inputs, so it can be cached by them.
 *
 * Every input that can change the numbers goes into the hash, and nothing that
 * cannot. Get that wrong in one direction and a stale result is served for a
 * question nobody asked; wrong in the other and the cache never hits.
 *
 * Pure and dependency-free so `backtest.fingerprint.spec.ts` can pin it — the
 * whole design rests on two identical requests hashing identically, and on two
 * different ones never doing so.
 */

/** Everything that decides a result. */
export interface CellSpec {
  detector: string;
  /** Rule version. Bumped whenever detection changes (rule 6). */
  detectorVersion: number;
  /** The strategy's own settings. Key order must not matter. */
  params: Record<string, unknown>;
  symbols: string[];
  timeframe: string;
  higherTimeframes: string[];
  fromTs: number;
  toTs: number;
  sim: SimInputs;
  /**
   * The engine build. Fills, costs and exits can change without any detector's
   * version moving, and reusing a result across that would be quietly wrong —
   * so changing simulation semantics bumps the engine crate version.
   */
  engineVersion: string;
}

export interface SimInputs {
  initialBalance: number;
  riskPercent: number;
  maxOpenPerSymbol: number;
  intrabar: string;
  capital: string;
  commissionPerLot: number;
  extraSpreadPoints: number;
  slippagePoints: number;
}

/** What the engine uses when a caller says nothing. Must track `SimConfig::default`. */
export const SIM_DEFAULTS: SimInputs = {
  initialBalance: 10_000,
  riskPercent: 1,
  maxOpenPerSymbol: 3,
  intrabar: 'pessimistic',
  capital: 'shared',
  commissionPerLot: 7,
  extraSpreadPoints: 0,
  slippagePoints: 0,
};

/**
 * Fills in what a request left unsaid.
 *
 * An omitted setting and one sent at its default produce the same run, so they
 * have to produce the same hash — otherwise the cache misses on exactly the
 * repeat it exists to catch.
 */
export function withSimDefaults(sim: Partial<SimInputs> | undefined): SimInputs {
  const given = sim ?? {};
  const out = { ...SIM_DEFAULTS };
  for (const key of Object.keys(SIM_DEFAULTS) as (keyof SimInputs)[]) {
    const value = given[key];
    if (value !== undefined && value !== null) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * JSON with every object key sorted, at any depth.
 *
 * `{a:1,b:2}` and `{b:2,a:1}` are the same settings and must hash the same;
 * `JSON.stringify` alone preserves insertion order and would not.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // An absent setting and one set to undefined are the same thing.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The cache key. Hex, 32 characters — short enough to read in a log, wide
 * enough that a collision is not a thing that happens.
 */
export function fingerprint(spec: CellSpec): string {
  const normalized = {
    detector: spec.detector,
    detectorVersion: spec.detectorVersion,
    params: spec.params ?? {},
    // Order of the pair list is not part of the question being asked.
    symbols: [...new Set(spec.symbols)].sort(),
    timeframe: spec.timeframe,
    higherTimeframes: [...new Set(spec.higherTimeframes)].sort(),
    fromTs: spec.fromTs,
    toTs: spec.toTs,
    sim: withSimDefaults(spec.sim),
    engineVersion: spec.engineVersion,
  };
  return createHash('sha256').update(canonical(normalized)).digest('hex').slice(0, 32);
}
