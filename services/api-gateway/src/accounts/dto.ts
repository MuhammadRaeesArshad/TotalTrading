import {
  IsBoolean, IsEnum, IsInt, IsOptional, IsString,
  Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { Mt5AccountMode } from '../schemas';
import { Timeframe } from '../schemas/strategy.schema';

export class CreateAccountDto {
  @IsString() @MinLength(1) @MaxLength(60)
  label: string;

  @IsString() @MinLength(1) @MaxLength(32)
  login: string;

  @IsString() @MinLength(1) @MaxLength(64)
  server: string;

  @IsString() @MinLength(1) @MaxLength(128)
  password: string;

  @IsEnum(Mt5AccountMode)
  mode: Mt5AccountMode;

  @IsOptional() @IsString() @MaxLength(60)
  broker?: string;
}

export class UpdateAccountDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60)
  label?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  password?: string;

  @IsOptional() @IsEnum(Mt5AccountMode)
  mode?: Mt5AccountMode;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class CandlesQueryDto {
  @IsString()
  symbol: string;

  @IsEnum(Timeframe)
  timeframe: Timeframe;

  @IsOptional() @IsInt() @Min(1) @Max(5000)
  count?: number;
}
