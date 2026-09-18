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

export interface CachedSeries {
  symbol: string;
  timeframe: string;
  bars: number;
  first_ts: number | null;
  last_ts: number | null;
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
      .get<string>('backtestEngineUrl')!
      .replace(/\/$/, '');
  }

  health() {
    return this.request<Record<string, unknown>>('GET', '/health', undefined, 10_000);
  }

  cache() {
    return this.request<{ series: CachedSeries[] }>('GET', '/cache', undefined, 30_000);
  }

  /**
   * Backfills the bar cache. Deliberately long-running: importing years of M5
   * takes minutes against a real terminal, and the answer the caller wants is
   * how far back the data actually goes — which only exists once it is done.
   */
  importBars(payload: {
    credentials: Mt5Credentials;
    symbols: string[];
    timeframes: string[];
    from_ts: number;
    to_ts: number;
  }) {
    return this.request<ImportReport>('POST', '/import', payload, 30 * 60_000);
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
