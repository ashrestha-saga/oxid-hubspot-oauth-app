import type { IntegrationRow } from '../db/repositories/integrations';
import {
  integrationsRepo,
  oxidAccessToken,
  oxidBaseUrl,
  oxidOAuthClientId,
  oxidOAuthClientSecret,
  oxidRefreshToken,
} from '../db/repositories/integrations';
import { ExternalApiError, NotFoundError, AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { refreshOxidAccessToken } from './oauthApi';

/** Re-mint this far before expiry so an in-flight call can't be caught out. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/** One in-flight refresh per integration. */
const inFlight = new Map<string, Promise<string>>();

async function refresh(row: IntegrationRow): Promise<string> {
  const tokens = await refreshOxidAccessToken(oxidBaseUrl(row), {
    clientId: oxidOAuthClientId(row),
    clientSecret: oxidOAuthClientSecret(row),
    refreshToken: oxidRefreshToken(row),
  });

  await integrationsRepo.updateOxidTokens(row.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });

  return tokens.accessToken;
}

/**
 * Returns a usable OXID bearer token, refreshing only when the cached one
 * is missing or about to expire. Mirror of `getValidAccessTokenForHub`.
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

  logger.debug({ integrationId: row.id }, 'refreshing OXID access token');
  const promise = refresh(row)
    .catch((error: unknown) => {
      if (error instanceof AppError) throw error;
      if (error instanceof ExternalApiError) throw error;
      throw new ExternalApiError('OXID token refresh failed', {
        system: 'oxid',
        cause: error,
      });
    })
    .finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, promise);
  return promise;
}

/** Test seam: clears the in-flight refresh map. */
export function resetOxidTokenState(): void {
  inFlight.clear();
}
