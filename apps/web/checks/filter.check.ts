// The page-wide trade filter.
//
//   node apps/web/checks/filter.check.ts

import assert from 'node:assert/strict';
import {
  activeCount, applyFilter, capitalFor, EMPTY_FILTER, fromParams, isEmptyFilter, toParams,
} from '../src/features/backtests/filter.ts';
import type { TradeFilter } from '../src/features/backtests/filter.ts';
import type { Run, Trade } from '../src/features/backtests/types.ts';

function trade(over: Partial<Trade>): Trade {
  return {
    _id: Math.random().toString(36).slice(2), symbol: 'EURUSD', direction: 'long', volume: 1,
    entryPrice: 1.1, entryTime: '2024-03-05T08:00:00Z', exitPrice: 1.1,
    exitTime: '2024-03-05T12:00:00Z', stopLoss: 1.099, takeProfit: 1.102,
    grossProfit: 0, commission: 0, netProfit: 0, rMultiple: 0,
    exitReason: 'stop_loss', ambiguousExit: false, barsHeld: 4, maeR: 0, mfeR: 0,
    detail: {}, ...over,
  };
}

const trades: Trade[] = [
  trade({ symbol: 'EURUSD', direction: 'long', netProfit: 10, entryTime: '2024-01-10T08:00:00Z' }),
  trade({ symbol: 'EURUSD', direction: 'short', netProfit: -5, entryTime: '2024-02-10T13:00:00Z' }),
  trade({ symbol: 'GBPUSD', direction: 'long', netProfit: -7, entryTime: '2024-03-10T03:00:00Z' }),
  trade({ symbol: 'USDJPY', direction: 'short', netProfit: 3, entryTime: '2024-04-10T17:00:00Z' }),
];

const f = (over: Partial<TradeFilter> = {}): TradeFilter => ({ ...EMPTY_FILTER, ...over });

// Nothing set keeps everything.
assert.equal(applyFilter(trades, f()).length, 4);
assert.ok(isEmptyFilter(f()));
assert.equal(activeCount(f()), 0);

// Pairs are a set, not one value — that is the point of the rewrite.
assert.equal(applyFilter(trades, f({ pairs: ['EURUSD'] })).length, 2);
assert.equal(applyFilter(trades, f({ pairs: ['EURUSD', 'USDJPY'] })).length, 3);

// Sessions likewise: London plus the overlap is a question a dropdown could
// not ask.
assert.equal(applyFilter(trades, f({ sessions: ['London'] })).length, 1);
assert.equal(applyFilter(trades, f({ sessions: ['London', 'Overlap'] })).length, 2);

assert.equal(applyFilter(trades, f({ side: 'long' })).length, 2);
assert.equal(applyFilter(trades, f({ result: 'win' })).length, 2);
// A trade that nets exactly zero is a win, same rule as the engine.
assert.equal(applyFilter([trade({ netProfit: 0 })], f({ result: 'win' })).length, 1);

// Dates bound the entry, inclusive at both ends.
assert.equal(applyFilter(trades, f({ from: '2024-02-10' })).length, 3);
assert.equal(applyFilter(trades, f({ to: '2024-02-10' })).length, 2);
assert.equal(applyFilter(trades, f({ from: '2024-02-10', to: '2024-03-10' })).length, 2);

// Filters combine rather than replace one another.
assert.equal(applyFilter(trades, f({ pairs: ['EURUSD'], side: 'long' })).length, 1);
assert.equal(activeCount(f({ pairs: ['EURUSD'], side: 'long', from: '2024-01-01' })), 3);

// --- capital -------------------------------------------------------------
// Narrowing a per-pair run to three pairs means three balances. Measuring
// against the twenty-nine the run deployed is wrong by the pair count.
const run = { initialBalance: 10_000, symbols: ['A', 'B', 'C', 'D'], capital: 'per_symbol' } as Run;
assert.equal(capitalFor(run, f()), 40_000);
assert.equal(capitalFor(run, f({ pairs: ['A', 'B'] })), 20_000);
// A shared account cannot be split, so it never scales.
const shared = { ...run, capital: 'shared' } as Run;
assert.equal(capitalFor(shared, f({ pairs: ['A'] })), 10_000);

// --- the URL -------------------------------------------------------------
const full = f({ pairs: ['EURUSD', 'GBPUSD'], sessions: ['London'], side: 'short', result: 'loss', from: '2024-01-01', to: '2024-12-31' });
const params = toParams(full);
assert.deepEqual(fromParams((k) => params[k] ?? null), full);
// Nothing set writes nothing, so a clean URL stays clean.
assert.deepEqual(toParams(f()), {});
// A hand-edited link narrows nothing rather than filtering by a value no
// trade can have.
assert.equal(fromParams((k) => (k === 'side' ? 'sideways' : null)).side, '');

console.log('filter.check: all assertions passed');

// --- months, kept or dropped ----------------------------------------------
// By exit month, matching the heatmap. Excluding is the useful direction:
// naming one catastrophic month beats naming the thirty-five around it.
{
  const m = (exitTime: string) => trade({ exitTime });
  const across = [m('2024-01-15T00:00:00Z'), m('2024-02-15T00:00:00Z'), m('2024-03-15T00:00:00Z')];

  assert.equal(applyFilter(across, f({ months: ['2024-02'] })).length, 1);
  assert.equal(
    applyFilter(across, f({ months: ['2024-02'], monthsMode: 'exclude' })).length,
    2,
    'excluding one month keeps the other two',
  );
  assert.equal(applyFilter(across, f({ months: ['2024-01', '2024-03'] })).length, 2);
  // An empty list means every month, whichever mode it is in.
  assert.equal(applyFilter(across, f({ months: [], monthsMode: 'exclude' })).length, 3);

  assert.equal(activeCount(f({ months: ['2024-02'] })), 1);
  assert.ok(!isEmptyFilter(f({ months: ['2024-02'] })));

  // Round-trips through the URL, mode included.
  const withMonths = f({ months: ['2024-01', '2024-02'], monthsMode: 'exclude' });
  const p2 = toParams(withMonths);
  assert.deepEqual(fromParams((k) => p2[k] ?? null), withMonths);
  // The mode is only written when it changes what the list means.
  assert.equal(toParams(f({ months: ['2024-01'] })).monthsMode, undefined);
}

console.log('filter.check: months ok');
