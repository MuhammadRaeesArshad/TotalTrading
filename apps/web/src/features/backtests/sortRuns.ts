/**
 * Ordering for the backtests table.
 *
 * Pure and dependency-free so `checks/sortRuns.check.ts` can run it under plain
 * Node. Erasable TypeScript only.
 */
import type { Run } from './types';

export type SortKey = 'run' | 'window' | 'status' | 'trades' | 'net' | 'pf' | 'expectancy';
export interface Sort { key: SortKey; dir: 'asc' | 'desc' }

/** Where a column starts: text reads A→Z, numbers read best-first. */
const FIRST: Record<SortKey, Sort['dir']> = {
  run: 'asc', window: 'desc', status: 'asc', trades: 'desc', net: 'desc', pf: 'desc', expectancy: 'desc',
};

/** Click cycle: the column's first direction, then the reverse, then unsorted. */
export function nextSort(cur: Sort | null, key: SortKey): Sort | null {
  if (!cur || cur.key !== key) return { key, dir: FIRST[key] };
  if (cur.dir === FIRST[key]) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return null;
}

/** A run with no result has no number; null sorts last in either direction. */
function value(r: Run, key: SortKey): number | string | null {
  const m = r.metrics;
  switch (key) {
    case 'run': return `${r.detector}\0${String(r.detectorVersion ?? 0).padStart(6, '0')}`;
    case 'window': return r.fromDate;
    case 'status': return r.status;
    case 'trades': return m ? m.totalTrades : null;
    case 'net': return m ? m.netProfit : null;
    // No losing trades: the ratio is unbounded, which is the best there is.
    case 'pf': return m ? (m.profitFactor ?? Infinity) : null;
    case 'expectancy': return m ? m.expectancyR : null;
  }
}

export function sortRuns(runs: Run[], sort: Sort | null): Run[] {
  if (!sort) return runs;
  const sign = sort.dir === 'asc' ? 1 : -1;
  // Array.sort is stable, so ties keep the server's (newest-first) order.
  return [...runs].sort((a, b) => {
    const x = value(a, sort.key);
    const y = value(b, sort.key);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sign;
  });
}
