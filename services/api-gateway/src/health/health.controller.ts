import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Mt5Client } from '../mt5/mt5.client';

@Controller()
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly mt5: Mt5Client,
  ) {}

  /** Liveness: is the process up? Kept dependency-free so k8s won't restart
   *  the pod just because Mongo blipped. */
  @Get('health')
  health() {
    return { status: 'ok', service: 'api-gateway', uptime: process.uptime() };
  }

  /** Readiness: can this pod actually serve traffic? */
  @Get('ready')
  async ready() {
    const mongoUp = this.mongo.readyState === 1;
    return {
      status: mongoUp ? 'ok' : 'degraded',
      mongo: mongoUp ? 'connected' : 'disconnected',
    };
  }

  /** Surfaced on the Settings page so the user can see which services are alive. */
  @Get('status/services')
  async services() {
    const mt5 = await this.mt5
      .health()
      .then((h) => ({ reachable: true, ...h }))
      .catch((e: Error) => ({ reachable: false, detail: e.message }));

    return {
      'api-gateway': { reachable: true, status: 'ok' },
      mongodb: {
        reachable: this.mongo.readyState === 1,
        status: this.mongo.readyState === 1 ? 'ok' : 'disconnected',
      },
      'mt5-connector': mt5,
      'strategy-engine': { reachable: false, status: 'not_implemented' },
      // The engine is built and running; it has no rules to execute yet.
      'backtest-engine': { reachable: false, status: 'awaiting_strategy' },
      'ai-analysis': { reachable: false, status: 'not_implemented' },
    };
  }
}
