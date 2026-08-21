import { describe, expect, it } from 'vitest';
import { DecryptionError, decrypt, encrypt, safeEqual } from '../src/lib/crypto';

describe('crypto', () => {
  it('round-trips a secret', () => {
    const secret = 'CO1abc-def-hubspot-refresh-token';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('round-trips unicode and empty strings', () => {
    for (const value of ['', 'Ärger mit Umlauten 日本語 🙂', 'a'.repeat(4096)]) {
      expect(decrypt(encrypt(value))).toBe(value);
    }
  });

  it('produces a different ciphertext each time (fresh IV)', () => {
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it('emits the versioned four-part envelope', () => {
    const parts = encrypt('x').split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1] as string, 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[2] as string, 'base64')).toHaveLength(16);
  });

  it('rejects a tampered ciphertext body', () => {
    const parts = encrypt('sensitive').split(':');
    const body = Buffer.from(parts[3] as string, 'base64');
    body[0] = (body[0] as number) ^ 0xff;
    parts[3] = body.toString('base64');

    expect(() => decrypt(parts.join(':'))).toThrow(DecryptionError);
  });

  it('rejects a swapped authentication tag', () => {
    const mine = encrypt('mine').split(':');
    const theirs = encrypt('theirs').split(':');
    mine[2] = theirs[2] as string;

    expect(() => decrypt(mine.join(':'))).toThrow(DecryptionError);
  });

  it('rejects malformed input instead of returning garbage', () => {
    for (const bad of ['', 'plaintext', 'v1:only:three', 'v2:a:b:c']) {
      expect(() => decrypt(bad)).toThrow(DecryptionError);
    }
  });

  it('compares strings in constant time without leaking on length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
