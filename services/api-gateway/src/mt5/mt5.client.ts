import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Mt5AccountInfo,
  Mt5Candle,
  Mt5ConnectorHealth,
  Mt5SymbolInfo,
} from './mt5.types';

export interface Mt5Credentials {
  login: string;
  password: string;
  server: string;
}

/**
 * The only thing in the gateway that talks to mt5-connector.
 *
 * Nothing here knows about MetaTrader itself — it speaks the connector's HTTP
 * contract. Swapping brokers means reimplementing the connector against this
 * same contract, and this file stays as it is (spec §6.2).
 */
@Injectable()
export class Mt5Client {
  private readonly log = new Logger(Mt5Client.name);
  private readonly baseUrl: string;
  private readonly timeoutMs = 20_000;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('mt5ConnectorUrl')!.replace(/\/$/, '');
  }

  health(): Promise<Mt5ConnectorHealth> {
    return this.request<Mt5ConnectorHealth>('GET', '/health');
  }

  accountInfo(creds: Mt5Credentials): Promise<Mt5AccountInfo> {
    return this.request<Mt5AccountInfo>('POST', '/account', creds);
  }

  symbols(creds: Mt5Credentials, group?: string): Promise<Mt5SymbolInfo[]> {
    return this.request<Mt5SymbolInfo[]>('POST', '/symbols', { ...creds, group });
  }

  candles(
    creds: Mt5Credentials,
    symbol: string,
    timeframe: string,
    count: number,
  ): Promise<Mt5Candle[]> {
    return this.request<Mt5Candle[]>('POST', '/candles', {
      ...creds,
      symbol,
      timeframe,
      count,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await this.readDetail(res);
        // 4xx from the connector is usually a real credential or symbol problem —
        // pass it through so the user sees what MT5 actually said.
        if (res.status >= 400 && res.status < 500) {
          throw new HttpException(detail, res.status);
        }
        throw new BadGatewayException(`MT5 connector failed: ${detail}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpException) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new ServiceUnavailableException(
          'The MT5 connector did not respond in time. Is the terminal running?',
        );
      }

      this.log.error(`${method} ${path} failed`, err as Error);
      throw new ServiceUnavailableException(
        `Cannot reach the MT5 connector at ${this.baseUrl}. Start it on the Windows machine running MetaTrader 5.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readDetail(res: Response): Promise<string> {
    try {
      const data = (await res.json()) as { detail?: string };
      return data.detail ?? res.statusText;
    } catch {
      return res.statusText;
    }
  }
}
