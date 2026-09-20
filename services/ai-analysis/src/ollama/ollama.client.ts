import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GenerateResponse {
  response?: string;
  error?: string;
}

interface TagsResponse {
  models?: Array<{ name?: string }>;
}

/** Ollama resolves a tagless name to `:latest`, so compare on that footing. */
export function normaliseTag(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

/**
 * Talks to a local Ollama. Nothing leaves the machine.
 *
 * Uses `fetch` rather than an HTTP client dependency — Node 22 has it, and this
 * service makes exactly two kinds of call.
 */
@Injectable()
export class OllamaClient {
  private readonly log = new Logger(OllamaClient.name);
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('ollamaUrl');
    this.model = config.getOrThrow<string>('ollamaModel');
    this.timeoutMs = config.getOrThrow<number>('ollamaTimeoutMs');
  }

  get modelName(): string {
    return this.model;
  }

  /** Which models the local Ollama actually has pulled. Empty when unreachable. */
  async installedModels(): Promise<string[]> {
    try {
      const res = await this.request('/api/tags', undefined, 5_000);
      if (!res.ok) return [];
      const body = (await res.json()) as TagsResponse;
      return (body.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => typeof n === 'string');
    } catch {
      return [];
    }
  }

  async isModelReady(): Promise<boolean> {
    const installed = await this.installedModels();
    const want = normaliseTag(this.model);
    // Exact match on the normalised tag. Comparing only the part before the
    // colon would report ready for a different size or variant of the same
    // family — `qwen2.5:7b` standing in for `qwen2.5:14b` — and the failure
    // then surfaces as a 503 on the first real request instead of here.
    return installed.some((n) => normaliseTag(n) === want);
  }

  /**
   * One non-streamed completion. `temperature` is low by default: this service
   * describes numbers that already exist, and invention is the failure mode.
   */
  async generate(prompt: string, system: string, temperature = 0.2): Promise<string> {
    const res = await this.request(
      '/api/generate',
      {
        model: this.model,
        prompt,
        system,
        stream: false,
        options: { temperature },
      },
      this.timeoutMs,
    ).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.error(`Ollama unreachable at ${this.baseUrl}: ${reason}`);
      throw new ServiceUnavailableException(
        `Could not reach Ollama at ${this.baseUrl}. Is it running?`,
      );
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ServiceUnavailableException(
        `Ollama returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }

    const body = (await res.json()) as GenerateResponse;
    if (body.error) {
      throw new ServiceUnavailableException(`Ollama error: ${body.error}`);
    }
    const text = body.response?.trim();
    if (!text) {
      throw new ServiceUnavailableException('Ollama returned an empty response.');
    }
    return text;
  }

  private async request(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    // AbortSignal.timeout rather than a manual controller — same thing, less code.
    return fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}
