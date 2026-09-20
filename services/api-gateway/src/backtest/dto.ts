import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString,
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
