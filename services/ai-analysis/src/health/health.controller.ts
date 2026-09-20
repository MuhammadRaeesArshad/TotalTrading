import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaClient } from '../ollama/ollama.client';

const VERSION = '0.1.0';

@Controller()
export class HealthController {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * Reports what is actually true, not what is configured. `degraded` means the
   * service is up but could not produce commentary if asked — which is the
   * answer the caller wants before it queues a report.
   */
  @Get('health')
  async health() {
    const installed = await this.ollama.installedModels();
    const reachable = installed.length > 0;
    const modelReady = reachable && (await this.ollama.isModelReady());
    const model = this.ollama.modelName;

    return {
      status: modelReady ? 'ok' : 'degraded',
      service: 'ai-analysis',
      version: VERSION,
      ollama_url: this.config.getOrThrow<string>('ollamaUrl'),
      ollama_reachable: reachable,
      model,
      model_ready: modelReady,
      detail: modelReady
        ? null
        : reachable
          ? `Ollama is up but '${model}' is not pulled. Run: ollama pull ${model}`
          : 'Ollama is not reachable. Is it running?',
    };
  }

  @Get('ready')
  ready() {
    return { status: 'ok' };
  }
}
