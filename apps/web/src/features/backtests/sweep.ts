import type { ParamSpec } from './types';

/**
 * How big a sweep of this strategy would be.
 *
 * Only the count — the gateway does the real expansion in
 * `backtest/sweep.ts`, and this exists so the button can say what it is about
 * to do before you press it rather than after.
 *
 * **This duplicates the gateway's rules**, which is the drift
 * `packages/contracts` is meant to stop. Both are TypeScript and neither can
 * import the other until that package exists. `checks/sweep.check.ts` pins the
 * numbers on this side; `test/sweep.spec.ts` pins them on the other, and the
 * two sets of expectations have to be changed together.
 *
 * Erasable TypeScript, no imports beyond types, so plain `node` can run it.
 */

/** Values per numeric setting, endpoints included. Mirrors DEFAULT_STEPS. */
export const SWEEP_STEPS = 5;

export function sweepValues(spec: ParamSpec, steps: number = SWEEP_STEPS): unknown[] {
  if (spec.kind === 'bool') return [false, true];
  if (spec.kind === 'choice') return (spec.options ?? []).map((o) => o.value);
  if (spec.min === undefined || spec.max === undefined || spec.max <= spec.min) return [];

  const n = Math.max(2, steps);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const raw = spec.min + ((spec.max - spec.min) * i) / (n - 1);
    out.push(spec.kind === 'int' ? Math.round(raw) : Math.round(raw * 1e6) / 1e6);
  }
  return [...new Set(out)];
}

export interface SweepSize {
  /** Every combination the sweep names. */
  total: number;
  /** How many are distinct questions — the rest are the settings already set. */
  distinct: number;
}

/**
 * Every axis includes a run sitting at the value the setting already has, so
 * the current configuration recurs once per axis. Those collapse to one stored
 * result, and the number on the button should be the one that will actually be
 * computed.
 */
export function sweepSize(
  specs: ParamSpec[],
  base: Record<string, unknown>,
  steps: number = SWEEP_STEPS,
): SweepSize {
  let total = 0;
  const seen = new Set<string>();

  for (const spec of specs) {
    for (const value of sweepValues(spec, steps)) {
      total++;
      const params: Record<string, unknown> = { ...base, [spec.key]: value };
      seen.add(
        JSON.stringify(
          Object.keys(params)
            .sort()
            .map((k) => [k, params[k]]),
        ),
      );
    }
  }

  return { total, distinct: seen.size };
}
