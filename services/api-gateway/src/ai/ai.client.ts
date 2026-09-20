import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Talks to ai-analysis.
 *
 * Only a health probe for now — the service has nothing to describe until a
 * backtest has run. Report proxying lands with the backtest UI.
 */
@Injectable()
export class AiClient {
  private readonly log = new Logger(AiClient.name);
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('aiAnalysisUrl')!.replace(/\/$/, '');
  }

  async health(): Promise<Record<string, unknown>> {
    // Short on purpose. AI is optional (rule 9), so the settings page must not
    // sit for ten seconds waiting on a service the user has deliberately
    // turned off. Unreachable is a normal answer here, not an error.
    const res = await fetch(`${this.baseUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      throw new Error(`ai-analysis returned ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}
