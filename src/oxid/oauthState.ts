import { createHmac } from 'node:crypto';
import { env } from '../config/env';
import { safeEqual } from '../lib/crypto';

/** Matches OXID auth code TTL (5 min) with a small buffer. */
export const OXID_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OxidOAuthState {
  integrationId: string;
  shopUrl: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  /** Epoch milliseconds. */
  exp: number;
}

function sign(data: string): string {
  return createHmac('sha256', Buffer.from(env.SESSION_SIGNING_KEY, 'base64'))
    .update(data)
    .digest('base64url');
}

export function signOxidOAuthState(
  input: Omit<OxidOAuthState, 'exp'>,
  ttlMs = OXID_OAUTH_STATE_TTL_MS,
): string {
  const payload: OxidOAuthState = { ...input, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyOxidOAuthState(token: string | undefined | null): OxidOAuthState | null {
  if (!token) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OxidOAuthState;
    if (
      typeof payload.integrationId !== 'string' ||
      typeof payload.shopUrl !== 'string' ||
      typeof payload.clientId !== 'string' ||
      typeof payload.clientSecret !== 'string' ||
      typeof payload.codeVerifier !== 'string' ||
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
