import type { Run, Trade } from './types';
import { isWin, sessionOf } from './stats.ts';

/**
 * One filter over a run's trades, shared by every tab.
 *
 * It used to live inside the Trades tab, so narrowing to London told you
 * nothing about what the Verdict or the Ledger would say — you had to re-run
 * the backtest to ask. The filter belongs to the page, and every figure on it
 * recomputes from whatever survives.
 *
 * Pure and dependency-free (types aside) so `checks/filter.check.ts` runs it
 * under plain Node. Erasable TypeScript only.
 */

export interface TradeFilter {
  /** Empty means every pair. */
  pairs: string[];
  /** Empty means every session. */
  sessions: string[];
  side: '' | 'long' | 'short';
  result: '' | 'win' | 'loss';
  /** Inclusive ISO dates on the trade's entry, or empty for open-ended. */
  from: string;
  to: string;
  /**
   * Calendar months, `YYYY-MM`, by exit month — the same month the heatmap
   * colours. Empty means every month.
   */
  months: string[];
  /**
   * Whether `months` names what to keep or what to drop. Dropping is the more
   * useful direction in practice: one catastrophic month is easier to name
   * than the thirty-five ordinary ones around it.
   */
  monthsMode: 'include' | 'exclude';
}

export const EMPTY_FILTER: TradeFilter = {
  pairs: [], sessions: [], side: '', result: '', from: '', to: '',
  months: [], monthsMode: 'include',
};

export function isEmptyFilter(f: TradeFilter): boolean {
  return !f.pairs.length && !f.sessions.length && !f.side && !f.result
    && !f.from && !f.to && !f.months.length;
}

/** How many of the six are doing something — for the "3 filters" badge. */
export function activeCount(f: TradeFilter): number {
  return (f.pairs.length ? 1 : 0) + (f.sessions.length ? 1 : 0)
    + (f.side ? 1 : 0) + (f.result ? 1 : 0) + (f.from ? 1 : 0) + (f.to ? 1 : 0)
    + (f.months.length ? 1 : 0);
}

const day = (iso: string) => iso.slice(0, 10);

export function applyFilter(trades: Trade[], f: TradeFilter): Trade[] {
  // Sets rather than includes(): a 28-pair filter over 1,700 trades is walked
  // on every keystroke of the date box.
  const pairs = f.pairs.length ? new Set(f.pairs) : null;
  const sessions = f.sessions.length ? new Set(f.sessions) : null;
  const months = f.months.length ? new Set(f.months) : null;

  return trades.filter((t) => {
    if (pairs && !pairs.has(t.symbol)) return false;
    if (sessions && !sessions.has(sessionOf(t.entryTime))) return false;
    if (f.side && t.direction !== f.side) return false;
    if (f.result && (f.result === 'win') !== isWin(t)) return false;
    // Dates bound the entry, not the exit: a trade belongs to when it was taken.
    if (f.from && day(t.entryTime) < f.from) return false;
    if (f.to && day(t.entryTime) > f.to) return false;
    // By exit month, matching the heatmap: a trade belongs to the month it
    // was resolved in, which is the month its result landed.
    if (months) {
      const inList = months.has(t.exitTime.slice(0, 7));
      if (f.monthsMode === 'include' ? !inList : inList) return false;
    }
    return true;
  });
}

/**
 * What the filtered view started with.
 *
 * Under per-pair capital each pair brought its own balance, so narrowing to
 * three pairs means three balances — not the twenty-nine the run deployed.
 * Percentages measured against the wrong figure are off by the pair count,
 * which is the bug this generalises away.
 */
export function capitalFor(run: Run, f: TradeFilter): number {
  if (run.capital !== 'per_symbol') return run.initialBalance;
  const n = f.pairs.length ? f.pairs.length : Math.max(1, run.symbols.length);
  return run.initialBalance * n;
}

// ---------------------------------------------------------------- the URL

/**
 * The filter lives in the query string, so a filtered view is a link and the
 * back button walks through what you looked at.
 */
export function toParams(f: TradeFilter): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.pairs.length) out.pairs = f.pairs.join(',');
  if (f.sessions.length) out.sessions = f.sessions.join(',');
  if (f.months.length) {
    out.months = f.months.join(',');
    // Only worth writing when it changes the meaning of the list.
    if (f.monthsMode === 'exclude') out.monthsMode = 'exclude';
  }
  if (f.side) out.side = f.side;
  if (f.result) out.result = f.result;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  return out;
}

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const oneOf = <T extends string>(v: string | null, allowed: T[]): T | '' =>
  allowed.includes(v as T) ? (v as T) : '';

export function fromParams(get: (key: string) => string | null): TradeFilter {
  return {
    pairs: list(get('pairs')),
    sessions: list(get('sessions')),
    months: list(get('months')),
    monthsMode: get('monthsMode') === 'exclude' ? 'exclude' : 'include',
    // Anything else in the URL is ignored rather than trusted — a hand-edited
    // link should narrow nothing rather than filter by a value no trade has.
    side: oneOf(get('side'), ['long', 'short']),
    result: oneOf(get('result'), ['win', 'loss']),
    from: (get('from') ?? '').slice(0, 10),
    to: (get('to') ?? '').slice(0, 10),
  };
}
