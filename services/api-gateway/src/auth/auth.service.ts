import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { CryptoService } from '../common/crypto.service';
import { LoginDto, RegisterDto } from './dto';

const BCRYPT_ROUNDS = 12;

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existingCount = await this.users.count();
    const registrationOpen = this.config.get<boolean>('allowRegistration');

    // The first account always gets in — otherwise a fresh install with
    // registration closed would have no way to create its owner.
    if (existingCount > 0 && !registrationOpen) {
      throw new ForbiddenException(
        'Registration is closed on this instance. Set ALLOW_REGISTRATION=true to open it.',
      );
    }

    if (await this.users.findByEmail(dto.email)) {
      throw new ConflictException('An account already uses that email.');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const user = await this.users.create({
      email: dto.email,
      displayName: dto.displayName,
      passwordHash,
    });

    return this.issue(user._id.toString(), user.email, user.displayName, user.role);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmailWithSecrets(dto.email);

    // Same message and roughly the same work either way, so the response
    // doesn't reveal whether the email exists.
    const hash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(dto.password, hash);

    if (!user || !ok) {
      throw new UnauthorizedException('That email and password do not match.');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }

    await this.users.markLogin(user._id.toString());
    return this.issue(user._id.toString(), user.email, user.displayName, user.role);
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    let payload: { sub: string; email: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('That session has expired. Sign in again.');
    }

    const user = await this.users.findByIdWithSecrets(payload.sub);
    if (!user?.refreshTokenHash) {
      throw new UnauthorizedException('That session has expired. Sign in again.');
    }

    // Rotation: a token that doesn't match the stored hash has either been
    // replaced by a newer login or replayed. Either way, refuse it.
    const presented = this.crypto.hashToken(refreshToken);
    if (!this.crypto.safeCompare(presented, user.refreshTokenHash)) {
      await this.users.setRefreshTokenHash(user._id.toString(), null);
      throw new UnauthorizedException('That session has expired. Sign in again.');
    }

    return this.issue(user._id.toString(), user.email, user.displayName, user.role);
  }

  async logout(userId: string): Promise<void> {
    await this.users.setRefreshTokenHash(userId, null);
  }

  private async issue(
    id: string,
    email: string,
    displayName: string,
    role: string,
  ): Promise<AuthResult> {
    const payload = { sub: id, email };
    const jwtConf = this.config.get('jwt')!;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: jwtConf.accessSecret,
        expiresIn: jwtConf.accessTtl,
      }),
      this.jwt.signAsync(payload, {
        secret: jwtConf.refreshSecret,
        expiresIn: jwtConf.refreshTtl,
      }),
    ]);

    await this.users.setRefreshTokenHash(id, this.crypto.hashToken(refreshToken));

    return { accessToken, refreshToken, user: { id, email, displayName, role } };
  }
}
