import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const ANALYSIS_KINDS = ['backtest', 'signal', 'session'] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

/** A scalar. Deliberately not `unknown` — see `facts` below. */
export type Fact = number | string | boolean;

export class AnalyzeDto {
  @IsIn(ANALYSIS_KINDS)
  kind!: AnalysisKind;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  /**
   * Already-computed figures, as flat scalars.
   *
   * Flat is the point. Rule 7 says the model narrates and never detects, and a
   * map of scalars cannot carry an OHLC series — so the rule is enforced by the
   * shape of the input rather than by a reviewer noticing. Nested objects and
   * arrays are rejected in the service.
   */
  @IsObject()
  facts!: Record<string, Fact>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;
}

export interface AnalysisResult {
  kind: AnalysisKind;
  title: string;
  model: string;
  commentary: string;
  generatedAt: string;
}
