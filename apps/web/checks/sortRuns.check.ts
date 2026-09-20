// Pins the backtests table ordering.
//
//   node apps/web/checks/sortRuns.check.ts

import assert from 'node:assert/strict';
import { nextSort, sortRuns } from '../src/features/backtests/sortRuns.ts';
import type { Run } from '../src/features/backtests/types.ts';

const run = (id: string, net: number | null, pf: number | null = 1, detector = 'a'): Run =>
  ({
    _id: id, detector, detectorVersion: 1, status: 'completed', fromDate: '2022-01-01',
    metrics: net === null ? null : { totalTrades: 1, netProfit: net, profitFactor: pf, expectancyR: 0 },
  }) as unknown as Run;

const ids = (rs: Run[]) => rs.map((r) => r._id).join('');
const runs = [run('a', -5), run('b', 10), run('c', null), run('d', 3)];

assert.equal(ids(sortRuns(runs, { key: 'net', dir: 'desc' })), 'bdac');
assert.equal(ids(sortRuns(runs, { key: 'net', dir: 'asc' })), 'adbc', 'no-result run stays last ascending too');
assert.equal(ids(sortRuns(runs, null)), 'abcd', 'unsorted keeps the given order');

// No losing trades is an infinite profit factor — top of a best-first sort.
const pf = [run('a', 1, 1.5), run('b', 1, null), run('c', 1, 0.8)];
assert.equal(ids(sortRuns(pf, { key: 'pf', dir: 'desc' })), 'bac');

// Ties keep the server's order.
assert.equal(ids(sortRuns([run('a', 1), run('b', 1)], { key: 'net', dir: 'asc' })), 'ab');

// Click cycle: first direction, reverse, off.
const s1 = nextSort(null, 'net');
assert.deepEqual(s1, { key: 'net', dir: 'desc' });
const s2 = nextSort(s1, 'net');
assert.deepEqual(s2, { key: 'net', dir: 'asc' });
assert.equal(nextSort(s2, 'net'), null);
assert.deepEqual(nextSort(s2, 'run'), { key: 'run', dir: 'asc' });

console.log('sortRuns: ok');
