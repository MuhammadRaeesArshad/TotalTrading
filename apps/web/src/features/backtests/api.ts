import { request } from '../../lib/api';
import type {
  Bars, CachedSeries, ImportJob, Run, StartRunInput, Trade,
} from './types';

export const backtestApi = {
  detectors: () =>
    request<{ detectors: string[]; versions: Record<string, number> }>('/backtest/detectors'),

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

  runs: () => request<Run[]>('/backtest/runs'),

  run: (id: string) => request<Run>(`/backtest/runs/${id}`),

  start: (input: StartRunInput) =>
    request<Run>('/backtest/runs', { method: 'POST', body: JSON.stringify(input) }),

  remove: (id: string) => request<{ deleted: string }>(`/backtest/runs/${id}`, { method: 'DELETE' }),

  trades: (id: string) => request<Trade[]>(`/backtest/runs/${id}/trades`),

  tradeBars: (id: string, tradeId: string) =>
    request<Bars>(`/backtest/runs/${id}/trades/${tradeId}/bars`),
};
