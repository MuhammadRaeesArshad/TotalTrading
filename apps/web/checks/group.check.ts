// Pins how sweep runs fold into one row in the backtests list.
//
//   node apps/web/checks/group.check.ts

import assert from 'node:assert/strict';
import { groupBySweep, spread } from '../src/features/backtests/group.ts';
import type { Run, Sweep } from '../src/features/backtests/types.ts';

const run = (id: string, net: number | null): Run =>
  ({ _id: id, metrics: net === null ? null : { netProfit: net } }) as unknown as Run;
const sweep = (id: string, ...runIds: (string | null)[]): Sweep =>
  ({ _id: id, cells: runIds.map((runId) => ({ axis: 'x', value: 1, runId, run: null })) }) as unknown as Sweep;

const desc = (rows: ReturnType<typeof groupBySweep>) =>
  rows.map((r) => (r.kind === 'run' ? r.run._id : `[${r.sweep._id}:${r.runs.map((x) => x._id).join('')}]`)).join(' ');

const runs = [run('a', 1), run('b', 2), run('c', 3), run('d', 4)];

// A group lands where its first run is, and keeps the order it was given.
assert.equal(desc(groupBySweep(runs, [sweep('S', 'b', 'd')])), 'a [S:bd] c');

// One run on screen is not worth a fold.
assert.equal(desc(groupBySweep(runs, [sweep('S', 'b', 'zzz')])), 'a b c d');

// A run answering two sweeps stays with the first (newest) one, and the same
// run appearing under several axes of one sweep is counted once.
assert.equal(desc(groupBySweep(runs, [sweep('N', 'a', 'b', 'a'), sweep('O', 'a', 'c', 'd')])), '[N:ab] [O:cd]');

// Cells with no run yet, and no sweeps at all, change nothing.
assert.equal(desc(groupBySweep(runs, [sweep('S', null, null)])), 'a b c d');
assert.equal(desc(groupBySweep(runs, [])), 'a b c d');

// Range across the runs; a run with no result never sets an end.
const net = (r: Run) => r.metrics!.netProfit;
assert.deepEqual(spread([run('a', -5), run('b', 10), run('c', null), run('d', 3)], net), [-5, 10]);
assert.equal(spread([run('a', null)], net), null);
assert.deepEqual(spread([run('a', 2)], net), [2, 2]);

// An unbounded value (no losing trades) is still a value, not "no result".
assert.deepEqual(spread([run('a', 1)], () => Infinity), [Infinity, Infinity]);

console.log('group: ok');
