import { request } from '../../lib/api';
import type {
  Bars, CachedSeries, ExploreQuery, ExploreResult, ImportJob, PairRow, Run, StartRunInput,
  StartSweepInput, Strategy, Sweep, Trade,
} from './types';

export const backtestApi = {
  detectors: () =>
    request<{ detectors: string[]; versions: Record<string, number>; strategies: Strategy[] }>(
      '/backtest/detectors',
    ),

  cache: () => request<{ series: CachedSeries[] }>('/backtest/cache'),

  /** Starts pulling history from MT5 in the background; returns the job id at once. */
  importHistory: (
    accountId: string,
    body: { symbols: string[]; timeframes: string[]; fromTs: number; toTs: number },
  ) =>
    request<{ id: string; status: string }>(`/backtest/accounts/${accountId}/import`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  imports: () => request<ImportJob[]>('/backtest/imports'),

  importStatus: (id: string) => request<ImportJob>(`/backtest/imports/${id}`),

  runs: (archived = false) => request<Run[]>(`/backtest/runs${archived ? '?archived=true' : ''}`),

  run: (id: string) => request<Run>(`/backtest/runs/${id}`),

  start: (input: StartRunInput) =>
    request<Run>('/backtest/runs', { method: 'POST', body: JSON.stringify(input) }),

  remove: (id: string) => request<{ deleted: string }>(`/backtest/runs/${id}`, { method: 'DELETE' }),

  startSweep: (input: StartSweepInput) =>
    request<Sweep>('/backtest/sweeps', { method: 'POST', body: JSON.stringify(input) }),

  sweeps: () => request<Sweep[]>('/backtest/sweeps'),

  sweep: (id: string) => request<Sweep>(`/backtest/sweeps/${id}`),

  cancelSweep: (id: string) =>
    request<Sweep>(`/backtest/sweeps/${id}/cancel`, { method: 'PATCH' }),

  setArchived: (id: string, archived: boolean) =>
    request<Run>(`/backtest/runs/${id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived }) }),

  trades: (id: string) => request<Trade[]>(`/backtest/runs/${id}/trades`),

  byPair: (id: string) => request<PairRow[]>(`/backtest/runs/${id}/by-pair`),

  explore: (query: ExploreQuery) =>
    request<ExploreResult>('/backtest/explore', { method: 'POST', body: JSON.stringify(query) }),

  tradeBars: (id: string, tradeId: string) =>
    request<Bars>(`/backtest/runs/${id}/trades/${tradeId}/bars`),
};
