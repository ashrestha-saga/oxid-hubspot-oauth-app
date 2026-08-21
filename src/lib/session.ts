import { createHmac } from 'node:crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { safeEqual } from './crypto';

export const PAIRING_COOKIE = 'hs_oxid_pairing';
export const PAIRING_SESSION_TTL_MS = 30 * 60 * 1000;

export interface PairingSession {
  integrationId: string;
  portalId: string;
  /** Epoch milliseconds. */
  exp: number;
}

function sign(data: string): string {
  return createHmac('sha256', Buffer.from(env.SESSION_SIGNING_KEY, 'base64'))
    .update(data)
    .digest('base64url');
}

/**
 * Issues a stateless signed session. This is what proves that whoever calls
 * `/oxid/pair/start` actually completed the OAuth install for that portal, so a
 * caller can never mint a pairing token for someone else's portal.
 */
export function signPairingSession(
  input: { integrationId: string; portalId: string },
  ttlMs = PAIRING_SESSION_TTL_MS,
): string {
  const payload: PairingSession = { ...input, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyPairingSession(token: string | undefined | null): PairingSession | null {
  if (!token) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PairingSession;
    if (
      typeof payload.integrationId !== 'string' ||
      typeof payload.portalId !== 'string' ||
      typeof payload.exp !== 'number' ||
      payload.exp < Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function setPairingCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(PAIRING_COOKIE, token, {
      httpOnly: true,
      secure: env.BASE_URL.startsWith('https://'),
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(PAIRING_SESSION_TTL_MS / 1000),
    }),
  );
}

export function clearPairingCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(PAIRING_COOKIE, '', {
      httpOnly: true,
      secure: env.BASE_URL.startsWith('https://'),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    }),
  );
}

export function readPairingSession(req: Request): PairingSession | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const cookies = parseCookie(header);
  return verifyPairingSession(cookies[PAIRING_COOKIE]);
}
