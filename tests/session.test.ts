import { describe, expect, it } from 'vitest';
import { signPairingSession, verifyPairingSession } from '../src/lib/session';

describe('pairing session', () => {
  const payload = { integrationId: 'integration-1', portalId: '24681012' };

  it('round-trips the portal and integration it was issued for', () => {
    const session = verifyPairingSession(signPairingSession(payload));
    expect(session).toMatchObject(payload);
    expect(session?.exp).toBeGreaterThan(Date.now());
  });

  it('rejects a token with a tampered payload', () => {
    const token = signPairingSession(payload);
    const [body, signature] = token.split('.') as [string, string];

    const forged = Buffer.from(
      JSON.stringify({ ...payload, portalId: '999', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url');

    expect(verifyPairingSession(`${forged}.${signature}`)).toBeNull();
    expect(verifyPairingSession(`${body}.${signature}`)).not.toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signPairingSession(payload);
    expect(verifyPairingSession(`${token}x`)).toBeNull();
  });

  it('rejects an expired token', () => {
    expect(verifyPairingSession(signPairingSession(payload, -1000))).toBeNull();
  });

  it('rejects missing and malformed tokens', () => {
    expect(verifyPairingSession(undefined)).toBeNull();
    expect(verifyPairingSession('')).toBeNull();
    expect(verifyPairingSession('no-separator')).toBeNull();
    expect(verifyPairingSession('.sig')).toBeNull();
    expect(verifyPairingSession('bm90LWpzb24.sig')).toBeNull();
  });
});
