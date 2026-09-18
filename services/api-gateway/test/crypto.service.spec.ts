import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { CryptoService } from '../src/common/crypto.service';

function serviceWith(key: string) {
  return new CryptoService({ get: () => key } as unknown as ConfigService);
}

const KEY = randomBytes(32).toString('hex');

describe('CryptoService', () => {
  it('round-trips a password', () => {
    const svc = serviceWith(KEY);
    const secret = 'S0me-Br0ker-P@ssw0rd';
    expect(svc.decrypt(svc.encrypt(secret))).toBe(secret);
  });

  it('produces different ciphertext each time for the same input', () => {
    // A fresh IV per encryption — otherwise two accounts sharing a password
    // would be visibly identical in the database.
    const svc = serviceWith(KEY);
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('accepts a base64 key as well as hex', () => {
    const svc = serviceWith(randomBytes(32).toString('base64'));
    expect(svc.decrypt(svc.encrypt('ok'))).toBe('ok');
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => serviceWith('tooshort')).toThrow(/32 bytes/);
  });

  it('refuses to decrypt with the wrong key', () => {
    const written = serviceWith(KEY).encrypt('secret');
    expect(() => serviceWith(randomBytes(32).toString('hex')).decrypt(written)).toThrow();
  });

  it('refuses tampered ciphertext', () => {
    // GCM's auth tag is the point: a flipped byte must fail, not decrypt to garbage.
    const svc = serviceWith(KEY);
    const [v, iv, tag, data] = svc.encrypt('secret').split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(() => svc.decrypt([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => serviceWith(KEY).decrypt('not-a-real-payload')).toThrow();
  });

  it('compares tokens without leaking length mismatches as exceptions', () => {
    const svc = serviceWith(KEY);
    expect(svc.safeCompare('abc', 'abc')).toBe(true);
    expect(svc.safeCompare('abc', 'abcd')).toBe(false);
    expect(svc.safeCompare('abc', 'abd')).toBe(false);
  });
});
