import {
  keyExpr, pipelineFor, SESSION_BOUNDS, toRows, totalsOf,
} from '../src/backtest/explore';

import type { ExploreQuery } from '../src/backtest/explore';

const base: ExploreQuery = {
  runIds: ['6aae4f0c00dac5c84109d807'], by: ['pair'], minTrades: 1,
};

const stage = (p: Record<string, unknown>[], name: string) =>
  p.filter((s) => Object.keys(s)[0] === name);

describe('pipelineFor', () => {
  it('scopes to the runs it was given', () => {
    const [match] = stage(pipelineFor({ ...base, by: ['pair'] }), '$match');
    expect(match.$match).toHaveProperty('backtestId');
  });

  it('drops thin rows only when a floor was asked for', () => {
    // One trade on a pair is not a finding, but the floor has to be opt-in or
    // an unfiltered view silently hides the tail.
    expect(stage(pipelineFor({ ...base, minTrades: 1 }), '$match')).toHaveLength(1);
    const withFloor = stage(pipelineFor({ ...base, minTrades: 30 }), '$match');
    expect(withFloor).toHaveLength(2);
    expect(withFloor[1].$match).toEqual({ n: { $gte: 30 } });
  });

  it('closes the date range on the whole final day', () => {
    // A `to` of 2024-03-05 must include that day's trades, not stop at midnight.
    const [match] = stage(pipelineFor({ ...base, from: '2024-01-01', to: '2024-03-05' }), '$match');
    const range = (match.$match as Record<string, { $gte: Date; $lte: Date }>).entryTime;
    expect(range.$gte.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(range.$lte.toISOString()).toBe('2024-03-05T23:59:59.999Z');
  });

  it('filters sessions after computing them, since they are not stored', () => {
    const p = pipelineFor({ ...base, sessions: ['London'] });
    const added = p.findIndex((s) => '$addFields' in s);
    const filtered = p.findIndex((s) => JSON.stringify(s).includes('_session'));
    expect(added).toBeGreaterThan(-1);
    expect(filtered).toBeGreaterThanOrEqual(added);
  });

  it('treats a zero-profit trade as a win, like the engine', () => {
    const [match] = stage(pipelineFor({ ...base, result: 'win' }), '$match');
    expect((match.$match as Record<string, unknown>).netProfit).toEqual({ $gte: 0 });
  });

  it('groups on every dimension asked for, in order', () => {
    const [group] = stage(pipelineFor({ ...base, by: ['session', 'year'] }), '$group');
    const id = (group.$group as { _id: Record<string, unknown> })._id;
    expect(Object.keys(id)).toEqual(['k0', 'k1']);
    expect(id.k0).toEqual(keyExpr('session'));
    expect(id.k1).toEqual(keyExpr('year'));
  });

  it('caps what comes back', () => {
    expect(stage(pipelineFor(base), '$limit')).toHaveLength(1);
  });
});

describe('session bands', () => {
  it('covers the whole day with no gap and no overlap', () => {
    // A trade landing in two sessions, or none, would double-count or vanish.
    expect(SESSION_BOUNDS[0].from).toBe(0);
    expect(SESSION_BOUNDS[SESSION_BOUNDS.length - 1].to).toBe(24);
    for (let i = 1; i < SESSION_BOUNDS.length; i++) {
      expect(SESSION_BOUNDS[i].from).toBe(SESSION_BOUNDS[i - 1].to);
    }
  });
});

describe('toRows and totals', () => {
  const raw = [
    { _id: { k0: 'EURUSD' }, n: 10, wins: 6, sumR: 4, net: 400, bestR: 2, worstR: -1 },
    { _id: { k0: 'GBPUSD' }, n: 5, wins: 1, sumR: -3, net: -300, bestR: 1, worstR: -1 },
  ];

  it('names the columns in the order they were requested', () => {
    expect(toRows(raw, ['pair'])[0].keys).toEqual(['EURUSD']);
  });

  it('derives the rates rather than trusting them', () => {
    const rows = toRows(raw, ['pair']);
    expect(rows[0].winRate).toBeCloseTo(0.6);
    expect(rows[0].avgR).toBeCloseTo(0.4);
  });

  it('adds up across rows, not across trades twice', () => {
    const t = totalsOf(toRows(raw, ['pair']));
    expect(t.n).toBe(15);
    expect(t.sumR).toBeCloseTo(1);
    expect(t.net).toBe(100);
    expect(t.winRate).toBeCloseTo(7 / 15);
  });

  it('survives an empty result', () => {
    const t = totalsOf([]);
    expect(t.n).toBe(0);
    expect(t.winRate).toBe(0);
    expect(t.avgR).toBe(0);
  });
});
