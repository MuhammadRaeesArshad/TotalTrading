import { request } from '../../lib/api';
import type {
  Bars, CachedSeries, ImportReport, Run, StartRunInput, Trade,
} from './types';

export const backtestApi = {
  detectors: () =>
    request<{ detectors: string[]; versions: Record<string, number> }>('/backtest/detectors'),

  cache: () => request<{ series: CachedSeries[] }>('/backtest/cache'),

  /** Pulls history from MT5 into the engine's bar cache. Can take minutes. */
  importHistory: (
    accountId: string,
    body: { symbols: string[]; timeframes: string[]; fromTs: number; toTs: number },
  ) =>
    request<ImportReport>(`/backtest/accounts/${accountId}/import`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  runs: () => request<Run[]>('/backtest/runs'),

  run: (id: string) => request<Run>(`/backtest/runs/${id}`),

  start: (input: StartRunInput) =>
    request<Run>('/backtest/runs', { method: 'POST', body: JSON.stringify(input) }),

  remove: (id: string) => request<{ deleted: string }>(`/backtest/runs/${id}`, { method: 'DELETE' }),

  trades: (id: string) => request<Trade[]>(`/backtest/runs/${id}/trades`),

  tradeBars: (id: string, tradeId: string) =>
    request<Bars>(`/backtest/runs/${id}/trades/${tradeId}/bars`),
};
