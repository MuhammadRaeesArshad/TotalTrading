import { BadRequestException, Injectable } from '@nestjs/common';
import { OllamaClient } from '../ollama/ollama.client';
import type { AnalysisResult, AnalyzeDto, Fact } from './dto';

/**
 * The model describes numbers that already exist. It is never asked what the
 * market is doing, never shown raw bars, and never asked to find anything —
 * detection happens in the Rust engine (rule 7).
 */
const SYSTEM_PROMPT = [
  'You are a trading-results analyst. You are given figures that have already been',
  'computed by a backtesting engine. Your only job is to describe them in clear prose.',
  '',
  'Rules you must follow:',
  '- Only discuss figures present in the data. Never estimate, extrapolate or invent one.',
  '- If the data is insufficient to answer something, say so plainly.',
  '- Do not predict future performance, and do not give trading advice.',
  '- Do not identify chart patterns or setups. You cannot see price data, only results.',
  '- Be concise and specific. Quote the numbers you are describing.',
  // qwen2.5 code-switches into Chinese mid-sentence without this.
  '- Write in English only.',
  '',
  // Without this the model reads an R value as a currency amount, which is
  // wrong in a way that reads as authoritative. R is the unit the whole system
  // reports in, so it is worth spelling out.
  'Units:',
  '- "R" means a multiple of the risk taken on a trade, never a currency amount.',
  '  An expectancy of 0.18R means the average trade returns 0.18 times what it risked.',
  '- A field ending in `_pct` is a percentage. A field ending in `_r` is in R.',
  '- Profit factor is gross profit divided by gross loss. Above 1.0 is profitable.',
].join('\n');

/** Cheap guard against a caller flattening bars into the map anyway. */
const MAX_FACTS = 200;

@Injectable()
export class AnalysisService {
  constructor(private readonly ollama: OllamaClient) {}

  async analyze(dto: AnalyzeDto): Promise<AnalysisResult> {
    const facts = this.validateFacts(dto.facts);

    const prompt = [
      `Kind: ${dto.kind}`,
      `Subject: ${dto.title}`,
      '',
      'Computed figures:',
      ...facts.map(([key, value]) => `- ${key}: ${String(value)}`),
      '',
      dto.question
        ? `Question to answer from the figures above: ${dto.question}`
        : 'Write a short analysis of these results.',
      '',
      // Repeated here on purpose. qwen2.5 drops Chinese words into English prose,
      // and the system prompt alone does not hold it — the last instruction does.
      'Write your entire response in English. Do not use any other language.',
    ].join('\n');

    const commentary = await this.ollama.generate(prompt, SYSTEM_PROMPT, 0);

    return {
      kind: dto.kind,
      title: dto.title,
      model: this.ollama.modelName,
      commentary,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Rejects anything that is not a flat scalar. An OHLC series reaching the
   * model would break rule 7, so it is refused at the boundary rather than
   * trusted to be well-formed upstream.
   */
  private validateFacts(facts: Record<string, Fact>): Array<[string, Fact]> {
    const entries = Object.entries(facts);

    if (entries.length === 0) {
      throw new BadRequestException('`facts` is empty — there is nothing to describe.');
    }
    if (entries.length > MAX_FACTS) {
      throw new BadRequestException(
        `\`facts\` has ${entries.length} entries, over the limit of ${MAX_FACTS}. ` +
          'Send computed figures, not a series.',
      );
    }

    for (const [key, value] of entries) {
      const type = typeof value;
      if (type !== 'number' && type !== 'string' && type !== 'boolean') {
        throw new BadRequestException(
          `\`facts.${key}\` is ${Array.isArray(value) ? 'an array' : type}. ` +
            'Only numbers, strings and booleans are accepted — the model narrates ' +
            'computed figures, never raw series.',
        );
      }
      if (type === 'number' && !Number.isFinite(value)) {
        throw new BadRequestException(`\`facts.${key}\` is not a finite number.`);
      }
    }

    return entries;
  }
}
