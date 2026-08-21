import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationRow } from '../src/db/repositories/integrations';

const { attachOxidShop, findByOxidShopId, listAwaitingOxidPairing } = vi.hoisted(() => ({
  attachOxidShop: vi.fn(),
  findByOxidShopId: vi.fn(),
  listAwaitingOxidPairing: vi.fn(),
}));

vi.mock('../src/db/repositories/integrations', () => ({
  integrationsRepo: {
    attachOxidShop,
    findByOxidShopId,
    listAwaitingOxidPairing,
  },
}));

vi.mock('../src/config/env', () => ({
  env: {
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    DEV_BYPASS_PAIRING: true,
    DEV_OXID_SHOP_ID: '00000000-0000-0000-0000-000000000001',
    DEV_OXID_SHOP_URL: 'https://dev-shop.local',
    DEV_OXID_API_KEY: 'dev-oxid-api-key',
    DEV_WEBHOOK_SECRET: 'dev-webhook-secret-min-16-chars',
    BASE_URL: 'https://backend.test',
  },
}));

import {
  activateAllPendingDevIntegrations,
  applyDevOxidPairingIfNeeded,
  devBypassEnabled,
  getDevWebhookCredentials,
} from '../src/dev/devBypass';

function pendingIntegration(overrides: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: 'int-1',
    name: 'test',
    hubspotPortalId: 4242n,
    hubspotAccessToken: 'v1:enc',
    hubspotRefreshToken: 'v1:enc',
    hubspotTokenExpiresAt: new Date(),
    oxidShopId: null,
    oxidBaseUrl: null,
    oxidApiKey: null,
    oxidAccessToken: null,
    oxidTokenExpiresAt: null,
    oxidWebhookSecret: null,
    status: 'pending',
    lastReconciledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('devBypass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attachOxidShop.mockImplementation(async (_id: string, input: unknown) => ({
      ...pendingIntegration(),
      ...(input as object),
      status: 'active',
      oxidShopId: '00000000-0000-0000-0000-000000000001',
    }));
    findByOxidShopId.mockResolvedValue(null);
    listAwaitingOxidPairing.mockResolvedValue([pendingIntegration()]);
  });

  it('is enabled in development when the flag is on', () => {
    expect(devBypassEnabled()).toBe(true);
  });

  it('attaches the fixed dev OXID shop when none is paired', async () => {
    const row = pendingIntegration();
    const updated = await applyDevOxidPairingIfNeeded(row);

    expect(attachOxidShop).toHaveBeenCalledWith('int-1', {
      oxidShopId: '00000000-0000-0000-0000-000000000001',
      oxidBaseUrl: 'https://dev-shop.local',
      oxidApiKey: 'dev-oxid-api-key',
      oxidWebhookSecret: 'dev-webhook-secret-min-16-chars',
    });
    expect(updated.status).toBe('active');
  });

  it('skips integrations that already have an oxid_shop_id', async () => {
    const row = pendingIntegration({ oxidShopId: 'existing-shop', status: 'active' });
    const updated = await applyDevOxidPairingIfNeeded(row);

    expect(attachOxidShop).not.toHaveBeenCalled();
    expect(updated).toBe(row);
  });

  it('activates all awaiting integrations on startup helper', async () => {
    const count = await activateAllPendingDevIntegrations();
    expect(count).toBe(1);
    expect(attachOxidShop).toHaveBeenCalledTimes(1);
  });

  it('returns fixed webhook credentials for signing test payloads', async () => {
    findByOxidShopId.mockResolvedValue(
      pendingIntegration({
        oxidShopId: '00000000-0000-0000-0000-000000000001',
        status: 'active',
        hubspotPortalId: 42735556n,
      }),
    );

    const creds = await getDevWebhookCredentials();
    expect(creds).toMatchObject({
      oxidShopId: '00000000-0000-0000-0000-000000000001',
      webhookSecret: 'dev-webhook-secret-min-16-chars',
      webhookUrl:
        'https://backend.test/webhooks/oxid/00000000-0000-0000-0000-000000000001',
      hubspotPortalId: '42735556',
      status: 'active',
    });
  });
});
