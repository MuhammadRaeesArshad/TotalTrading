import { BadRequestException } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import type { OllamaClient } from '../ollama/ollama.client';
import type { AnalyzeDto } from './dto';

/** Records the prompt it was given so the tests can assert on it. */
function stubOllama() {
  const calls: Array<{ prompt: string; system: string }> = [];
  const client = {
    modelName: 'test-model',
    generate: async (prompt: string, system: string) => {
      calls.push({ prompt, system });
      return 'commentary';
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

function dto(facts: Record<string, unknown>): AnalyzeDto {
  return {
    kind: 'backtest',
    title: 'EURUSD H1',
    facts: facts as AnalyzeDto['facts'],
  };
}

describe('AnalysisService', () => {
  it('describes flat scalar facts', async () => {
    const { client, calls } = stubOllama();
    const service = new AnalysisService(client);

    const result = await service.analyze(dto({ trades: 128, win_rate: 0.41, profitable: true }));

    expect(result.commentary).toBe('commentary');
    expect(result.model).toBe('test-model');
    expect(calls[0]!.prompt).toContain('win_rate: 0.41');
  });

  // Rule 7: the model narrates computed figures and never sees a price series.
  it('rejects an array of bars', async () => {
    const { client } = stubOllama();
    const service = new AnalysisService(client);

    await expect(service.analyze(dto({ highs: [1.1, 1.2, 1.3] }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a nested object', async () => {
    const { client } = stubOllama();
    const service = new AnalysisService(client);

    await expect(service.analyze(dto({ metrics: { win_rate: 0.4 } }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects empty facts', async () => {
    const { client } = stubOllama();
    const service = new AnalysisService(client);

    await expect(service.analyze(dto({}))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-finite number', async () => {
    const { client } = stubOllama();
    const service = new AnalysisService(client);

    await expect(service.analyze(dto({ sharpe: Number.NaN }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('tells the model not to invent figures', async () => {
    const { client, calls } = stubOllama();
    const service = new AnalysisService(client);

    await service.analyze(dto({ trades: 1 }));

    expect(calls[0]!.system).toContain('Never estimate, extrapolate or invent');
  });
});
