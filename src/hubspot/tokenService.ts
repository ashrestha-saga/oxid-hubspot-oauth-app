import {
  hubspotRefreshToken,
  hubspotAccessToken,
  integrationsRepo,
  type IntegrationRow,
} from '../db/repositories/integrations';
import { IntegrationNotReadyError, NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';
import { refreshAccessToken } from './oauthApi';

/** Refresh this far before actual expiry so in-flight requests never race it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * One in-flight refresh per integration. Without this, a burst of webhooks for
 * the same portal arriving just after expiry would all refresh at once and the
 * last writer would win with a token the others already replaced.
 */
const inFlight = new Map<string, Promise<string>>();

export interface ValidHubspotToken {
  accessToken: string;
  integrationId: string;
}

function isFresh(row: IntegrationRow, now: number): boolean {
  return (
    !!row.hubspotAccessToken &&
    !!row.hubspotTokenExpiresAt &&
    row.hubspotTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now
  );
}

async function refresh(row: IntegrationRow): Promise<string> {
  const existing = inFlight.get(row.id);
  if (existing) return existing;

  const promise = (async () => {
    logger.debug({ integrationId: row.id }, 'refreshing HubSpot access token');
    const tokens = await refreshAccessToken(hubspotRefreshToken(row));
    await integrationsRepo.updateHubspotTokens(row.id, tokens);
    return tokens.accessToken;
  })().finally(() => inFlight.delete(row.id));

  inFlight.set(row.id, promise);
  return promise;
}

export async function getValidAccessTokenForIntegration(
  row: IntegrationRow,
): Promise<ValidHubspotToken> {
  if (!row.hubspotRefreshToken) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no HubSpot credentials`);
  }

  if (isFresh(row, Date.now())) {
    return { accessToken: hubspotAccessToken(row), integrationId: row.id };
  }

  return { accessToken: await refresh(row), integrationId: row.id };
}

/** Primary entry point: everything talking to HubSpot starts here. */
export async function getValidAccessTokenForHub(
  hubId: string | number | bigint,
): Promise<ValidHubspotToken> {
  const row = await integrationsRepo.findByPortalId(hubId);
  if (!row) throw new NotFoundError(`no integration for HubSpot portal ${hubId}`);
  return getValidAccessTokenForIntegration(row);
}

export async function getValidAccessTokenForIntegrationId(
  integrationId: string,
): Promise<ValidHubspotToken> {
  const row = await integrationsRepo.findById(integrationId);
  if (!row) throw new NotFoundError(`no integration ${integrationId}`);
  return getValidAccessTokenForIntegration(row);
}

/** Test seam: clears the in-flight refresh map. */
export function resetTokenServiceState(): void {
  inFlight.clear();
}
