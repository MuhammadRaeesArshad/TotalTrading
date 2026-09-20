/**
 * Self-check for the results page's derived numbers. No framework:
 *
 *   node apps/web/checks/stats.check.ts
 *
 * Node 22.6+ strips the types. Exits non-zero on the first wrong number.
 */
import assert from 'node:assert/strict';
import {
  deployedCapital, equityPath, groupBy, rHistogram, R_BINS, sessionOf, summarize, verdict,
} from '../src/features/backtests/stats.ts';
import type { Run, Trade } from '../src/features/backtests/types.ts';
import { moneyClass } from '../src/features/backtests/fmt.ts';

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

// Sessions are by UTC entry hour.
assert.equal(sessionOf('2024-03-05T03:00:00Z'), 'Asia');
assert.equal(sessionOf('2024-03-05T08:00:00Z'), 'London');
assert.equal(sessionOf('2024-03-05T13:00:00Z'), 'Overlap');
assert.equal(sessionOf('2024-03-05T17:30:00Z'), 'New York');
assert.equal(sessionOf('2024-03-05T22:00:00Z'), 'Late');

// A win, then two losses, in exit order.
const trades = [
  trade({ exitTime: '2024-03-05T12:00:00Z', netProfit: 200, rMultiple: 2 }),
  trade({ exitTime: '2024-03-06T12:00:00Z', netProfit: -100, rMultiple: -1 }),
  trade({ exitTime: '2024-03-07T12:00:00Z', netProfit: -100, rMultiple: -1, symbol: 'GBPUSD' }),
];
const s = summarize(trades, 10_000);
assert.equal(s.n, 3);
assert.equal(s.wins, 1);
assert.equal(s.winRate, 1 / 3);
assert.equal(s.profitFactor, 1, 'gross 200 over gross 200');
assert.equal(s.net, 0);
assert.equal(s.expR, 0);
assert.equal(s.avgLossR, 1, 'loss size is reported positive');
assert.ok(Math.abs(s.maxDrawdown - 200 / 10_200) < 1e-12, 'peak after the win, trough after both losses');
assert.equal(s.ddPeak, 0);
assert.equal(s.ddTrough, 2);

// Order must not matter to the caller: summarize sorts by exit itself.
assert.deepEqual(summarize([...trades].reverse(), 10_000), s);

// Breakeven counts as a win, matching the engine.
assert.equal(summarize([trade({ netProfit: 0 })], 10_000).wins, 1);

// No losses means no profit factor, not infinity on screen.
assert.equal(summarize([trade({ netProfit: 50, rMultiple: 0.5 })], 10_000).profitFactor, null);

// Equity path compounds from the start balance.
assert.deepEqual(equityPath(trades, 10_000).map((p) => p.equity), [10_200, 10_100, 10_000]);

// Histogram bins: -1 lands in [-1, -0.5), +2 in [2, 2.5).
const h = rHistogram(trades);
assert.equal(h.reduce((a, b) => a + b, 0), 3, 'every trade lands in exactly one bin');
assert.equal(h[R_BINS.findIndex(([lo]) => lo === -1)], 2);
assert.equal(h[R_BINS.findIndex(([lo]) => lo === 2)], 1);

// Grouping.
const pairs = groupBy(trades, (t) => t.symbol);
assert.equal(pairs.get('EURUSD')?.n, 2);
assert.equal(pairs.get('GBPUSD')?.sumR, -1);

// Verdict: without an optimistic twin, that criterion is unknown, never guessed.
const run = {
  initialBalance: 10_000,
  metrics: {
    totalTrades: 3, profitFactor: 1, expectancyR: 0, maxDrawdownPct: 1.96, ambiguousExits: 0,
  },
} as unknown as Run;
const v = verdict(run, trades);
assert.equal(v.find((c) => c.id === 'intrabar')?.status, 'unknown');
assert.equal(v.find((c) => c.id === 'sample')?.status, 'fail', '3 trades is not a sample');
assert.equal(v.find((c) => c.id === 'dd')?.status, 'pass');

const optimistic = { metrics: { profitFactor: 1.1 } } as unknown as Run;
assert.equal(verdict(run, trades, optimistic).find((c) => c.id === 'intrabar')?.status, 'pass');

console.log('stats.check: all assertions passed');

// --- capital deployed ------------------------------------------------------
// Per-pair runs give each pair its own balance, so every percentage the page
// recomputes has to be measured against the total, not against one pair's.
{
  const base = { initialBalance: 10_000, symbols: ['EURUSD', 'GBPUSD', 'AUDNZD'] };
  assert.equal(deployedCapital({ ...base, capital: 'shared' } as Run), 10_000);
  assert.equal(deployedCapital({ ...base, capital: 'per_symbol' } as Run), 30_000);
  // Runs stored before the field existed were shared.
  assert.equal(deployedCapital({ ...base } as Run), 10_000);
}

// --- colour follows the printed figure ------------------------------------
// A number that rounds to zero on screen must not be coloured as a gain: an
// expectancy of +0.0004 shows as "+0.00R", and green there read as a winning
// run on one that lost thousands.
{
  assert.equal(moneyClass(0.0004), '');
  assert.equal(moneyClass(-0.0004), '');
  assert.equal(moneyClass(0), '');
  assert.equal(moneyClass(null), '');
  assert.equal(moneyClass(0.02), 'gain');
  assert.equal(moneyClass(-0.02), 'loss');
}
