import { env } from '../config/env';
import {
  integrationsRepo,
  type IntegrationRow,
} from '../db/repositories/integrations';
import { logger } from '../lib/logger';

/** True when stub OXID pairing is auto-applied (never in production). */
export function devBypassEnabled(): boolean {
  return env.NODE_ENV !== 'production' && env.DEV_BYPASS_PAIRING;
}

export interface DevWebhookCredentials {
  oxidShopId: string;
  webhookSecret: string;
  webhookUrl: string;
  oxidShopUrl: string;
  hubspotPortalId: string | null;
  integrationId: string | null;
  status: string | null;
}

/**
 * Attaches fixed dev OXID credentials so webhooks work without the pairing UI.
 * Skips integrations that already have an oxid_shop_id (real pairing wins).
 */
export async function applyDevOxidPairingIfNeeded(
  integration: IntegrationRow,
): Promise<IntegrationRow> {
  if (!devBypassEnabled() || integration.oxidShopId) {
    return integration;
  }

  const updated = await integrationsRepo.attachOxidShop(integration.id, {
    oxidShopId: env.DEV_OXID_SHOP_ID,
    oxidBaseUrl: env.DEV_OXID_SHOP_URL,
    oxidApiKey: env.DEV_OXID_API_KEY,
    oxidWebhookSecret: env.DEV_WEBHOOK_SECRET,
  });

  logger.warn(
    {
      integrationId: integration.id,
      oxidShopId: env.DEV_OXID_SHOP_ID,
      portalId: integration.hubspotPortalId?.toString(),
    },
    'DEV_BYPASS_PAIRING: auto-attached stub OXID shop',
  );

  return updated;
}

/** Activates every HubSpot-connected integration that is not yet paired. */
export async function activateAllPendingDevIntegrations(): Promise<number> {
  if (!devBypassEnabled()) return 0;

  const rows = await integrationsRepo.listAwaitingOxidPairing();
  let count = 0;
  for (const row of rows) {
    await applyDevOxidPairingIfNeeded(row);
    count += 1;
  }
  return count;
}

export async function getDevWebhookCredentials(): Promise<DevWebhookCredentials> {
  const byShop = await integrationsRepo.findByOxidShopId(env.DEV_OXID_SHOP_ID);

  return {
    oxidShopId: env.DEV_OXID_SHOP_ID,
    webhookSecret: env.DEV_WEBHOOK_SECRET,
    webhookUrl: `${env.BASE_URL}/webhooks/oxid/${env.DEV_OXID_SHOP_ID}`,
    oxidShopUrl: env.DEV_OXID_SHOP_URL,
    hubspotPortalId: byShop?.hubspotPortalId?.toString() ?? null,
    integrationId: byShop?.id ?? null,
    status: byShop?.status ?? null,
  };
}
