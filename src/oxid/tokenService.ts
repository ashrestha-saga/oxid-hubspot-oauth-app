import {
  integrationsRepo,
  oxidAccessToken,
  oxidApiKey,
  oxidBaseUrl,
  type IntegrationRow,
} from '../db/repositories/integrations';
import { ExternalApiError, NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';

/** Re-mint this far before expiry so an in-flight call can't be caught out. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * One in-flight mint per integration. OXID has no refresh token - the bearer is
 * re-derived from the stored API key - so a burst of jobs for the same shop
 * would otherwise all mint at once.
 */
const inFlight = new Map<string, Promise<string>>();

interface TokenResponse {
  access_token?: string;
  accessToken?: string;
  expires_in?: number;
  expiresIn?: number;
}

async function mint(row: IntegrationRow): Promise<string> {
  const response = await fetch(`${oxidBaseUrl(row)}/oxapi/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: oxidApiKey(row), grantType: 'client_credentials' }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ExternalApiError('OXID token request failed', {
      system: 'oxid',
      status: response.status,
      details: text.slice(0, 500),
    });
  }

  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new ExternalApiError('OXID token response was not JSON', {
      system: 'oxid',
      status: response.status,
      details: text.slice(0, 200),
    });
  }

  const accessToken = body.access_token ?? body.accessToken;
  const expiresIn = body.expires_in ?? body.expiresIn;
  if (!accessToken || !expiresIn) {
    throw new ExternalApiError('OXID token response missing access_token/expires_in', {
      system: 'oxid',
      status: response.status,
    });
  }

  await integrationsRepo.updateOxidToken(row.id, {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  });

  return accessToken;
}

/**
 * Returns a usable OXID bearer token, minting a new one only when the cached one
 * is missing or about to expire. Call this at the top of every function that
 * talks to OXID - the mirror image of `getValidAccessTokenForHub`.
 */
export async function getValidOxidToken(integrationId: string): Promise<string> {
  const row = await integrationsRepo.findById(integrationId);
  if (!row) throw new NotFoundError(`no integration ${integrationId}`);

  const cached = oxidAccessToken(row);
  const stillValid =
    cached &&
    row.oxidTokenExpiresAt &&
    row.oxidTokenExpiresAt.getTime() > Date.now() + EXPIRY_MARGIN_MS;

  if (stillValid) return cached;

  const existing = inFlight.get(row.id);
  if (existing) return existing;

  logger.debug({ integrationId: row.id }, 'minting OXID bearer token');
  const promise = mint(row).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, promise);
  return promise;
}

/** Test seam: clears the in-flight mint map. */
export function resetOxidTokenState(): void {
  inFlight.clear();
}
