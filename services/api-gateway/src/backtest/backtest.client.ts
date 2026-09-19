import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Mt5Credentials } from '../mt5/mt5.client';

export interface ImportedSeries {
  symbol: string;
  timeframe: string;
  bars: number;
  first_ts: number | null;
  last_ts: number | null;
  duplicates_dropped: number;
  path: string;
  short_of_request: string | null;
}

export interface ImportReport {
  imported: ImportedSeries[];
  failed: { symbol: string; timeframe: string; error: string }[];
  total_bars: number;
  elapsed_ms: number;
}

/** A background import, as the engine reports it while it runs. */
export interface ImportJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  created_at: number;
  finished_at: number | null;
  series_total: number;
  series_done: number;
  bars_done: number;
  /** e.g. "EURUSD H1" while that series is being pulled. */
  current: string;
  report?: ImportReport;
}

export interface CachedSeries {
  symbol: string;
  timeframe: string;
  bars: number;
  first_ts: number | null;
  last_ts: number | null;
}

/** The engine's job states, exactly as it serialises them. */
export type EngineJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Body for `POST /runs`. Snake case because it is the engine's wire format. */
export interface EngineRunSpec {
  detector: string;
  symbols: string[];
  timeframe: string;
  higher_timeframes?: string[];
  from_ts: number;
  to_ts: number;
  sim?: {
    initial_balance?: number;
    risk_percent?: number;
    commission_per_lot?: number;
    extra_spread_points?: number;
    slippage_points?: number;
    max_open_per_symbol?: number;
    intrabar?: 'pessimistic' | 'optimistic';
  };
}

export interface EngineMetrics {
  total_trades: number;
  wins: number;
  losses: number;
  /** Percent, 0–100. */
  win_rate: number;
  net_profit: number;
  gross_profit: number;
  gross_loss: number;
  /** `null` when there were no losing trades — serde writes infinity as null. */
  profit_factor: number | null;
  expectancy: number;
  expectancy_r: number;
  max_drawdown: number;
  max_drawdown_pct: number;
  sharpe: number | null;
  avg_win: number;
  avg_loss: number;
  longest_losing_streak: number;
  longest_winning_streak: number;
  final_equity: number;
  ambiguous_exits: number;
}

export interface EngineTrade {
  symbol: string;
  direction: 'long' | 'short';
  volume: number;
  entry_time: number;
  entry_price: number;
  exit_time: number;
  exit_price: number;
  stop_loss: number;
  take_profit: number | null;
  exit_reason: 'stop_loss' | 'take_profit' | 'end_of_data';
  gross_profit: number;
  commission: number;
  net_profit: number;
  r_multiple: number;
  ambiguous_exit: boolean;
  bars_held: number;
  mae_r: number;
  mfe_r: number;
  detail: Record<string, number>;
}

export interface EngineSkipCounts {
  max_open: number;
  stop_gapped: number;
  target_passed: number;
  stop_inside_costs: number;
  below_min_volume: number;
  no_entry_bar: number;
}

export interface EngineRunResult {
  detector: string;
  detector_version: number;
  skipped: EngineSkipCounts;
  metrics: EngineMetrics;
  /** `t` is a trade's exit time in unix seconds; `drawdown` is in money. */
  equity_curve: { t: number; equity: number; drawdown: number }[];
  trades: EngineTrade[];
  bars_processed: number;
  signals_generated: number;
  elapsed_ms: number;
  engine_version: string;
}

export interface EngineJob {
  id: string;
  status: EngineJobStatus;
  progress_pct: number;
  error: string | null;
  result?: EngineRunResult;
}

export interface EngineBars {
  symbol: string;
  timeframe: string;
  count: number;
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
}

/**
 * Talks to the Rust backtest engine.
 *
 * The engine reaches mt5-connector itself during an import, so credentials
 * travel with the request. They are decrypted here, held for the length of the
 * call, and never logged on either side — the gateway stays the only place
 * they are stored.
 */
@Injectable()
export class BacktestClient {
  private readonly log = new Logger(BacktestClient.name);
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('engineUrl')!
      .replace(/\/$/, '');
  }

  health() {
    return this.request<Record<string, unknown>>('GET', '/health', undefined, 10_000);
  }

  cache() {
    return this.request<{ series: CachedSeries[] }>('GET', '/cache', undefined, 30_000);
  }

  detectors() {
    return this.request<{ detectors: string[]; versions: Record<string, number> }>(
      'GET', '/detectors', undefined, 10_000,
    );
  }

  /** Queues a run. Returns at once with the engine's job id. */
  startRun(spec: EngineRunSpec) {
    return this.request<{ id: string; status: EngineJobStatus }>('POST', '/runs', spec, 60_000);
  }

  /** Status and progress only — cheap enough to poll every second. */
  runProgress(id: string) {
    return this.request<EngineJob>('GET', `/runs/${encodeURIComponent(id)}/progress`, undefined, 10_000);
  }

  /** The full job including its result. Can be large: every trade of the run. */
  runResult(id: string) {
    return this.request<EngineJob>('GET', `/runs/${encodeURIComponent(id)}`, undefined, 120_000);
  }

  bars(symbol: string, timeframe: string, fromTs: number, toTs: number) {
    const q = `from_ts=${Math.floor(fromTs)}&to_ts=${Math.floor(toTs)}`;
    return this.request<EngineBars>(
      'GET',
      `/bars/${encodeURIComponent(symbol)}/${encodeURIComponent(timeframe)}?${q}`,
      undefined,
      30_000,
    );
  }

  /**
   * Starts backfilling the bar cache in the background and returns at once
   * with a job id. Years of history take minutes against a real terminal;
   * progress is read with `importStatus`.
   */
  importBars(payload: {
    credentials: Mt5Credentials;
    symbols: string[];
    timeframes: string[];
    from_ts: number;
    to_ts: number;
  }) {
    return this.request<{ id: string; status: string }>('POST', '/import', payload, 30_000);
  }

  importStatus(id: string) {
    return this.request<ImportJob>('GET', `/imports/${encodeURIComponent(id)}`, undefined, 10_000);
  }

  imports() {
    return this.request<ImportJob[]>('GET', '/imports', undefined, 10_000);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res
          .json()
          .then((d: { detail?: string }) => d.detail ?? res.statusText)
          .catch(() => res.statusText);

        if (res.status >= 400 && res.status < 500) {
          throw new HttpException(detail, res.status);
        }
        throw new BadGatewayException(`Backtest engine failed: ${detail}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpException) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceUnavailableException(
          'The backtest engine did not finish in time. A large import can take a while — check its logs before retrying.',
        );
      }

      // Never log the payload: it carries a broker password on the import path.
      this.log.error(`${method} ${path} failed`);
      throw new ServiceUnavailableException(
        `Cannot reach the backtest engine at ${this.baseUrl}.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
