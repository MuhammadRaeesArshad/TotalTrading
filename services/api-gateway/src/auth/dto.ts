import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email: string;

  @IsString()
  @MinLength(2, { message: 'Your name needs at least 2 characters.' })
  @MaxLength(80)
  displayName: string;

  @IsString()
  @MinLength(10, { message: 'Use at least 10 characters. This unlocks broker credentials.' })
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password.' })
  password: string;
}

export class RefreshDto {
  @IsString()
  refreshToken: string;
}
