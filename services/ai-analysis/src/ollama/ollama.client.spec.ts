import { ConfigService } from '@nestjs/config';
import { OllamaClient, normaliseTag } from './ollama.client';

function clientFor(model: string, installed: string[]): OllamaClient {
  const config = {
    getOrThrow: (key: string) =>
      ({
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: model,
        ollamaTimeoutMs: 1_000,
      })[key],
  } as unknown as ConfigService;

  const client = new OllamaClient(config);
  // Stub the network call; the readiness comparison is what is under test.
  client.installedModels = async () => installed;
  return client;
}

describe('normaliseTag', () => {
  it('appends :latest to a tagless name, as Ollama does', () => {
    expect(normaliseTag('qwen2.5')).toBe('qwen2.5:latest');
  });

  it('leaves an explicit tag alone', () => {
    expect(normaliseTag('qwen2.5:14b')).toBe('qwen2.5:14b');
  });
});

describe('OllamaClient.isModelReady', () => {
  it('is ready on an exact match', async () => {
    const client = clientFor('qwen2.5:14b', ['qwen2.5:14b', 'qwen2.5:7b']);
    await expect(client.isModelReady()).resolves.toBe(true);
  });

  // The bug this replaced: comparing only the part before the colon reported
  // ready for a different size, and the failure surfaced as a 503 on the first
  // real request instead of in the health check.
  it('is not ready when only a different size of the same family is installed', async () => {
    const client = clientFor('qwen2.5:14b', ['qwen2.5:7b']);
    await expect(client.isModelReady()).resolves.toBe(false);
  });

  it('is not ready when only a different variant is installed', async () => {
    const client = clientFor('qwen2.5:14b-instruct', ['qwen2.5:14b']);
    await expect(client.isModelReady()).resolves.toBe(false);
  });

  it('is not ready when nothing is installed', async () => {
    const client = clientFor('qwen2.5:14b', []);
    await expect(client.isModelReady()).resolves.toBe(false);
  });

  it('matches a tagless config against an installed :latest', async () => {
    const client = clientFor('qwen2.5', ['qwen2.5:latest']);
    await expect(client.isModelReady()).resolves.toBe(true);
  });
});
