// Pins the sweep-size estimate shown on the button.
//
// These are the same expectations as the gateway's `test/sweep.spec.ts`, and
// they have to be changed together — the two implementations cannot import one
// another until `packages/contracts` exists. If you change one, change both.
//
//   node apps/web/checks/sweep.check.ts

import assert from 'node:assert/strict';
import { sweepSize, sweepValues } from '../src/features/backtests/sweep.ts';
import type { ParamSpec } from '../src/features/backtests/types.ts';

const specs: ParamSpec[] = [
  { key: 'trend_timeframe', label: 'Direction from', kind: 'choice', default: 'H1',
    options: [{ value: 'H1', label: 'H1' }, { value: 'H4', label: 'H4' }] },
  { key: 'ema_period', label: 'EMA period', kind: 'int', default: 21, min: 2, max: 200 },
  { key: 'atr_threshold', label: 'Slope', kind: 'float', default: 0.5, min: 0, max: 5, step: 0.1 },
  { key: 'entry_on_m30', label: 'M30', kind: 'bool', default: true },
  { key: 'mystery', label: 'No range', kind: 'int', default: 3 },
];

// A numeric range keeps both ends — that is where a strategy breaks.
const ema = sweepValues(specs[1]) as number[];
assert.equal(ema[0], 2);
assert.equal(ema[ema.length - 1], 200);
assert.ok(ema.every((n) => Number.isInteger(n)), 'integers stay whole');

// A range narrower than the sample yields each value once, not repeats.
assert.deepEqual(sweepValues({ key: 'k', label: 'k', kind: 'int', default: 1, min: 1, max: 3 }, 9), [1, 2, 3]);

assert.deepEqual(sweepValues(specs[3]), [false, true]);
assert.deepEqual(sweepValues(specs[0]), ['H1', 'H4']);
// Bounds that were never declared are not invented.
assert.deepEqual(sweepValues(specs[4]), []);

// 2 choice + 5 int + 5 float + 2 bool, and nothing for the unbounded one.
const base = { trend_timeframe: 'H1', ema_period: 21, atr_threshold: 0.5, entry_on_m30: true, mystery: 3 };
assert.equal(sweepSize(specs, base).total, 14);

// Every axis repeats whatever is already set, so distinct is lower whenever
// the current settings sit on a swept value.
const onGrid = { trend_timeframe: 'H1', ema_period: 2, atr_threshold: 0, entry_on_m30: false, mystery: 3 };
const size = sweepSize(specs, onGrid);
assert.ok(size.distinct < size.total, 'repeats of the current settings collapse');

// Settings off the sampled values repeat nothing.
const offGrid = { trend_timeframe: 'XX', ema_period: 999, atr_threshold: 9.9, entry_on_m30: 'x', mystery: 3 };
const off = sweepSize(specs, offGrid);
assert.equal(off.distinct, off.total);

console.log('sweep.check: all assertions passed');
