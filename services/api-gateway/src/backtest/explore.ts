import { Types } from 'mongoose';

/**
 * Slicing trades across many runs at once.
 *
 * A sweep produces dozens of runs and the question worth asking spans them:
 * over four years, in which session, on which pair, did this actually make
 * money — and would it have made more had I traded only one of them?
 * Answering that by opening runs one at a time is what this replaces.
 *
 * The grouping happens in Mongo. Folding 40,000 trades in Node to count them
 * would work and would also ship 40,000 trades over the wire to do it.
 */

export type Dimension = 'pair' | 'session' | 'year' | 'month' | 'direction' | 'setting';

export const DIMENSIONS: Dimension[] = [
  'pair', 'session', 'year', 'month', 'direction', 'setting',
];

/**
 * Session boundaries by entry hour, UTC.
 *
 * **This mirrors `SESSIONS` in `apps/web/src/features/backtests/stats.ts`.**
 * A third copy of the same rule, in a third language now that it is also a
 * Mongo expression — change one and change all of them, or the same trade
 * lands in different sessions depending on which screen you are looking at.
 * `packages/contracts` is the fix and does not exist yet.
 */
export const SESSION_BOUNDS: { name: string; from: number; to: number }[] = [
  { name: 'Asia', from: 0, to: 7 },
  { name: 'London', from: 7, to: 12 },
  { name: 'Overlap', from: 12, to: 16 },
  { name: 'New York', from: 16, to: 21 },
  { name: 'Late', from: 21, to: 24 },
];

/** A `$switch` that turns the entry hour into a session name. */
export function sessionExpr(): Record<string, unknown> {
  return {
    $switch: {
      branches: SESSION_BOUNDS.slice(0, -1).map((s) => ({
        case: {
          $and: [
            { $gte: [{ $hour: '$entryTime' }, s.from] },
            { $lt: [{ $hour: '$entryTime' }, s.to] },
          ],
        },
        then: s.name,
      })),
      // The last band runs to midnight, so anything left over belongs to it.
      default: SESSION_BOUNDS[SESSION_BOUNDS.length - 1].name,
    },
  };
}

/** What each dimension groups on. */
export function keyExpr(dim: Dimension): unknown {
  switch (dim) {
    case 'pair': return '$symbol';
    case 'session': return sessionExpr();
    case 'year': return { $toString: { $year: '$entryTime' } };
    case 'month': return {
      $dateToString: { format: '%Y-%m', date: '$entryTime' },
    };
    case 'direction': return '$direction';
    // Folded into its setting and value afterwards, from the sweep's cells.
    case 'setting': return { $toString: '$backtestId' };
  }
}

export interface ExploreRow {
  /** One value per requested dimension, in the order they were requested. */
  keys: string[];
  n: number;
  wins: number;
  /** Fraction, 0–1. */
  winRate: number;
  sumR: number;
  avgR: number;
  net: number;
  /** Best and worst single trade, in R — how much rests on one of them. */
  bestR: number;
  worstR: number;
}

export interface ExploreQuery {
  runIds: string[];
  by: Dimension[];
  /** Rows below this are dropped: a pair with one trade is not a finding. */
  minTrades: number;
  pairs?: string[];
  sessions?: string[];
  side?: 'long' | 'short';
  result?: 'win' | 'loss';
  from?: string;
  to?: string;
}

/**
 * The pipeline. Separated from the service so it can be read — and so the
 * shape of what comes back is obvious without running Mongo.
 */
export function pipelineFor(q: ExploreQuery): Record<string, unknown>[] {
  const match: Record<string, unknown> = {
    backtestId: { $in: q.runIds.map((id) => new Types.ObjectId(id)) },
  };
  if (q.pairs?.length) match.symbol = { $in: q.pairs };
  if (q.side) match.direction = q.side;
  if (q.from || q.to) {
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = new Date(`${q.from}T00:00:00Z`);
    // Inclusive of the whole closing day, not of its first instant.
    if (q.to) range.$lte = new Date(`${q.to}T23:59:59.999Z`);
    match.entryTime = range;
  }
  // Same rule as the engine: a trade that nets zero or better is a win.
  if (q.result === 'win') match.netProfit = { $gte: 0 };
  if (q.result === 'loss') match.netProfit = { $lt: 0 };

  const stages: Record<string, unknown>[] = [{ $match: match }];

  // Sessions are computed, so they can only be filtered after projection.
  if (q.sessions?.length) {
    stages.push({ $addFields: { _session: sessionExpr() } });
    stages.push({ $match: { _session: { $in: q.sessions } } });
  }

  const id: Record<string, unknown> = {};
  q.by.forEach((dim, i) => { id[`k${i}`] = keyExpr(dim); });

  stages.push({
    $group: {
      _id: id,
      n: { $sum: 1 },
      wins: { $sum: { $cond: [{ $gte: ['$netProfit', 0] }, 1, 0] } },
      sumR: { $sum: '$rMultiple' },
      net: { $sum: '$netProfit' },
      bestR: { $max: '$rMultiple' },
      worstR: { $min: '$rMultiple' },
    },
  });

  if (q.minTrades > 1) stages.push({ $match: { n: { $gte: q.minTrades } } });
  stages.push({ $sort: { sumR: -1 } });
  // A guard, not a page: 5,000 rows is already more than anyone reads, and it
  // stops a four-dimension grouping from returning the trade list itself.
  stages.push({ $limit: 5_000 });
  return stages;
}

/** Turns what Mongo returns into rows, in the order the dimensions were asked for. */
export function toRows(
  raw: { _id: Record<string, string>; n: number; wins: number; sumR: number; net: number; bestR: number; worstR: number }[],
  by: Dimension[],
): ExploreRow[] {
  return raw.map((r) => ({
    keys: by.map((_, i) => String(r._id[`k${i}`] ?? '—')),
    n: r.n,
    wins: r.wins,
    winRate: r.n ? r.wins / r.n : 0,
    sumR: r.sumR,
    avgR: r.n ? r.sumR / r.n : 0,
    net: r.net,
    bestR: r.bestR ?? 0,
    worstR: r.worstR ?? 0,
  }));
}

/** Totals across whatever survived the filter, for the "all of it" line. */
export function totalsOf(rows: ExploreRow[]) {
  const n = rows.reduce((a, r) => a + r.n, 0);
  const wins = rows.reduce((a, r) => a + r.wins, 0);
  const sumR = rows.reduce((a, r) => a + r.sumR, 0);
  return {
    rows: rows.length,
    n,
    wins,
    winRate: n ? wins / n : 0,
    sumR,
    avgR: n ? sumR / n : 0,
    net: rows.reduce((a, r) => a + r.net, 0),
  };
}

/**
 * A run's settings, said in as few words as carry the meaning.
 *
 * Grouping by setting and getting "trend_engulf" on every row says nothing —
 * the point of the column is which setting this run moved and where to. A
 * sweep knows that for its own cells; for anything else the only honest answer
 * is what differs from the strategy's defaults.
 */
export function describeParams(
  params: Record<string, unknown> | null | undefined,
  defaults: Record<string, unknown>,
  fallback: string,
): string {
  if (!params) return fallback;

  const changed = Object.entries(params)
    // A value equal to the default is not what makes this run different.
    .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k]))
    // An object-valued setting (a per-pair map) does not fit a table cell.
    .filter(([, v]) => v === null || typeof v !== 'object')
    .map(([k, v]) => `${k} = ${String(v)}`);

  if (!changed.length) return `${fallback} · defaults`;
  // Two is what fits; past that the cell is wider than the numbers beside it.
  if (changed.length <= 2) return changed.join(', ');
  return `${changed.slice(0, 2).join(', ')} +${changed.length - 2} more`;
}
