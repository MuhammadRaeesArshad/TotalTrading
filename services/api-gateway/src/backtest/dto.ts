import { ArrayNotEmpty, IsArray, IsEnum, IsInt, IsString, Min } from 'class-validator';
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
