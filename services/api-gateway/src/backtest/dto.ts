import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsObject,
  IsOptional, IsString,
  Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { Timeframe } from '../schemas/strategy.schema';

export class ImportBarsDto {
  /** Broker symbols exactly as the account lists them. */
  @IsArray()
  @ArrayNotEmpty({ message: 'Pick at least one symbol to import.' })
  @IsString({ each: true })
  symbols: string[];

  @IsArray()
  @ArrayNotEmpty({ message: 'Pick at least one timeframe to import.' })
  @IsEnum(Timeframe, { each: true })
  timeframes: Timeframe[];

  /** Unix seconds. */
  @IsInt()
  @Min(0)
  fromTs: number;

  @IsInt()
  @Min(0)
  toTs: number;
}

export class SimOverridesDto {
  @IsOptional() @IsNumber() @Min(1)
  initialBalance?: number;

  /** Percent of equity risked per trade. */
  @IsOptional() @IsNumber() @Min(0.01) @Max(10)
  riskPercent?: number;

  @IsOptional() @IsInt() @Min(1) @Max(20)
  maxOpenPerSymbol?: number;

  @IsOptional() @IsIn(['pessimistic', 'optimistic'])
  intrabar?: 'pessimistic' | 'optimistic';

  /** One balance for the whole run, or `initialBalance` per pair. */
  @IsOptional() @IsIn(['shared', 'per_symbol'])
  capital?: 'shared' | 'per_symbol';

  /** `fixed` risks a percent of the starting balance, so a run cannot stop
   *  answering; `compound` risks a percent of equity and can be wiped out. */
  @IsOptional() @IsIn(['fixed', 'compound'])
  sizing?: 'fixed' | 'compound';

  @IsOptional() @IsNumber() @Min(0)
  commissionPerLot?: number;

  @IsOptional() @IsNumber() @Min(0)
  extraSpreadPoints?: number;

  @IsOptional() @IsNumber() @Min(0)
  slippagePoints?: number;
}

export class StartBacktestDto {
  /** Registry name of the detector, e.g. `smc_ob`. */
  @IsString()
  @Matches(/^[a-z0-9_]{1,40}$/, { message: 'detector must be a registered detector name.' })
  detector: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Pick at least one symbol to test.' })
  @ArrayMaxSize(60)
  @IsString({ each: true })
  symbols: string[];

  /** The timeframe the detector runs on. */
  @IsEnum(Timeframe)
  timeframe: Timeframe;

  /** Closed bars of these are available to the detector alongside the base. */
  @IsOptional()
  @IsArray()
  @IsEnum(Timeframe, { each: true })
  higherTimeframes?: Timeframe[];

  /** Unix seconds. */
  @IsInt() @Min(0)
  fromTs: number;

  @IsInt() @Min(0)
  toTs: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => SimOverridesDto)
  sim?: SimOverridesDto;

  /**
   * The strategy's own settings, keyed as its schema declares. Left untyped
   * here on purpose: each detector owns its parameters and validates them,
   * so the gateway would only be duplicating that check badly.
   */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

export class ArchiveRunDto {
  /** True puts the run aside, false brings it back. */
  @IsBoolean()
  archived: boolean;
}

/**
 * A sweep is a backtest request plus how widely to explore around it. The
 * settings in `params` are the centre, not the factory defaults.
 */
export class StartSweepDto extends StartBacktestDto {
  /** Values per numeric setting, endpoints included. */
  @IsOptional() @IsInt() @Min(2) @Max(21)
  steps?: number;

  /** Sweep only these settings. Empty means every one that declares a range. */
  @IsOptional() @IsArray() @IsString({ each: true })
  only?: string[];
}

/** What to slice, and how finely. */
export class ExploreDto {
  @IsOptional() @IsArray() @IsString({ each: true })
  runIds?: string[];

  /** Every answered cell of this sweep, instead of naming runs. */
  @IsOptional() @IsString()
  sweepId?: string;

  /** One or two dimensions; more rows than anyone reads beyond that. */
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(3)
  @IsIn(['pair', 'session', 'year', 'month', 'direction', 'setting'], { each: true })
  by: ('pair' | 'session' | 'year' | 'month' | 'direction' | 'setting')[];

  /** Rows with fewer trades than this are dropped, not greyed out. */
  @IsOptional() @IsInt() @Min(1) @Max(100_000)
  minTrades?: number;

  @IsOptional() @IsArray() @IsString({ each: true }) pairs?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) sessions?: string[];
  @IsOptional() @IsIn(['long', 'short']) side?: 'long' | 'short';
  @IsOptional() @IsIn(['win', 'loss']) result?: 'win' | 'loss';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}
