import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Reversible encryption for broker credentials.
 *
 * MT5 needs the plaintext password to log in, so hashing isn't an option here.
 * The key lives in MT5_CRED_KEY (env / k8s Secret), never in Mongo — a dump of
 * the database on its own gets an attacker nothing.
 *
 * Rotating the key means re-encrypting every stored account. The `v1:` prefix
 * is there so a future key version can be told apart during that migration.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('credKey')!;
    const key = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');

    if (key.length !== 32) {
      throw new Error(
        'MT5_CRED_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -hex 32',
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, ivB64, tagB64, dataB64] = payload.split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
      throw new InternalServerErrorException(
        'Stored credential is malformed or was encrypted with a different key version.',
      );
    }
    try {
      const decipher = createDecipheriv(
        ALGO,
        this.key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key, or the ciphertext was tampered with. Both are the same failure to the caller.
      throw new InternalServerErrorException(
        'Could not decrypt stored credential. Has MT5_CRED_KEY changed?',
      );
    }
  }

  /** Refresh tokens are long and random already — SHA-256 is enough, and fast. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
