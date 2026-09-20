/**
 * Expanding a strategy into the runs that explore it.
 *
 * One setting at a time: each run moves a single setting across its declared
 * range and leaves the rest at their defaults. A full grid over nine settings
 * is 19,683 combinations before pairs, and it answers a question nobody asked.
 * This answers the one that matters — which knobs move the result, and where
 * does it fall apart — and stays legible on a chart.
 *
 * The bounds are not invented here. Every setting already declares `min`,
 * `max` and `step` in its strategy's own `params_schema`, which is what draws
 * the New backtest form; this reads the same numbers. No model is involved,
 * and by rule 9 none may ever be.
 *
 * Pure, so `sweep.spec.ts` can pin the expansion without an engine.
 */

export interface ParamSpec {
  key: string;
  label?: string;
  kind: 'int' | 'float' | 'bool' | 'choice';
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label?: string }[];
}

/** One run of a sweep: which setting it moves, and where to. */
export interface SweepCell {
  axis: string;
  value: unknown;
  params: Record<string, unknown>;
}

/** How many values a numeric setting is sampled at, endpoints included. */
export const DEFAULT_STEPS = 5;

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Values to try for one setting.
 *
 * Numeric settings are sampled evenly from `min` to `max` with both ends kept,
 * because the ends are where a strategy usually breaks and that is the most
 * informative part of the sweep. Integers are rounded and de-duplicated, so a
 * setting with a range narrower than the sample count yields each value once
 * rather than the same one repeatedly.
 */
export function valuesFor(spec: ParamSpec, steps = DEFAULT_STEPS): unknown[] {
  if (spec.kind === 'bool') return [false, true];
  if (spec.kind === 'choice') {
    return (spec.options ?? []).map((o) => o.value);
  }

  // Without both bounds there is no range to walk, and guessing one would be
  // inventing a rule. Such a setting simply is not swept.
  if (spec.min === undefined || spec.max === undefined || spec.max <= spec.min) return [];

  const n = Math.max(2, steps);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const raw = spec.min + ((spec.max - spec.min) * i) / (n - 1);
    out.push(spec.kind === 'int' ? Math.round(raw) : round(raw));
  }
  return [...new Set(out)];
}

/**
 * Every run a sweep of this strategy comes to.
 *
 * `base` is the starting point — whatever the form was showing — so a sweep
 * explores around the settings you were already looking at rather than around
 * the factory defaults.
 *
 * `only` narrows it to named settings; empty means all of them.
 */
export function expandSweep(
  specs: ParamSpec[],
  base: Record<string, unknown>,
  options: { steps?: number; only?: string[] } = {},
): SweepCell[] {
  const { steps = DEFAULT_STEPS, only } = options;
  const wanted = only?.length ? new Set(only) : null;

  const cells: SweepCell[] = [];
  for (const spec of specs) {
    if (wanted && !wanted.has(spec.key)) continue;
    for (const value of valuesFor(spec, steps)) {
      cells.push({ axis: spec.key, value, params: { ...base, [spec.key]: value } });
    }
  }
  return cells;
}

/**
 * How many of those are distinct questions.
 *
 * Every axis includes a run that happens to sit at the current value of that
 * setting, so the starting configuration recurs once per axis. Those collapse
 * to one stored result via the fingerprint, and the count shown before
 * launching should say so rather than promising work that will not happen.
 */
export function distinctCount(cells: SweepCell[]): number {
  const seen = new Set(cells.map((c) => stableKey(c.params)));
  return seen.size;
}

function stableKey(params: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  );
}
