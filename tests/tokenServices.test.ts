import './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt } from '../src/lib/crypto';
import { ExternalApiError } from '../src/lib/errors';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';

const refreshAccessToken = vi.hoisted(() => vi.fn());
const refreshOxidAccessToken = vi.hoisted(() => vi.fn());

vi.mock('../src/hubspot/oauthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hubspot/oauthApi')>();
  return { ...actual, refreshAccessToken };
});

vi.mock('../src/oxid/oauthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/oxid/oauthApi')>();
  return { ...actual, refreshOxidAccessToken };
});

const {
  getValidAccessTokenForHub,
  getValidAccessTokenForIntegrationId,
  resetTokenServiceState,
} = await import('../src/hubspot/tokenService');
const { getValidOxidToken, resetOxidTokenState } = await import('../src/oxid/tokenService');

beforeEach(() => {
  resetFakeDb();
  resetTokenServiceState();
  resetOxidTokenState();
  refreshAccessToken.mockReset();
  refreshAccessToken.mockResolvedValue({
    accessToken: 'refreshed-access-token',
    refreshToken: 'refreshed-refresh-token',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  refreshOxidAccessToken.mockReset();
  refreshOxidAccessToken.mockResolvedValue({
    accessToken: 'refreshed-oxid-access',
    refreshToken: 'refreshed-oxid-refresh',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    scope: 'profile address api',
  });
  vi.unstubAllGlobals();
});

describe('HubSpot token service', () => {
  it('returns the cached token while it is still fresh', async () => {
    addIntegration({ portalId: 1100, hubspotAccessToken: 'still-good' });

    const result = await getValidAccessTokenForHub(1100);

    expect(result.accessToken).toBe('still-good');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes a token that expires within the safety margin', async () => {
    const integration = addIntegration({
      portalId: 1101,
      hubspotAccessToken: 'about-to-expire',
      hubspotTokenExpiresAt: new Date(Date.now() + 60 * 1000),
    });

    const result = await getValidAccessTokenForHub(1101);

    expect(result.accessToken).toBe('refreshed-access-token');
    expect(refreshAccessToken).toHaveBeenCalledWith('test-refresh-token');

    const stored = fakeState.integrations.find((row) => row.id === integration.id);
    expect(decrypt(stored?.hubspotAccessToken as string)).toBe('refreshed-access-token');
    expect(decrypt(stored?.hubspotRefreshToken as string)).toBe('refreshed-refresh-token');
  });

  it('refreshes an already expired token', async () => {
    addIntegration({
      portalId: 1102,
      hubspotTokenExpiresAt: new Date(Date.now() - 60 * 1000),
    });

    expect((await getValidAccessTokenForHub(1102)).accessToken).toBe('refreshed-access-token');
  });

  it('refreshes only once when several calls race', async () => {
    const integration = addIntegration({
      portalId: 1103,
      hubspotTokenExpiresAt: new Date(Date.now() - 1000),
    });

    const results = await Promise.all([
      getValidAccessTokenForIntegrationId(integration.id),
      getValidAccessTokenForIntegrationId(integration.id),
      getValidAccessTokenForIntegrationId(integration.id),
    ]);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.accessToken)).toEqual([
      'refreshed-access-token',
      'refreshed-access-token',
      'refreshed-access-token',
    ]);
  });

  it('fails clearly for an unknown portal', async () => {
    await expect(getValidAccessTokenForHub(999999)).rejects.toThrow(/no integration/);
  });
});

describe('OXID token service', () => {
  it('returns the cached token while it is still fresh', async () => {
    const integration = addIntegration({
      portalId: 1200,
      oxidAccessToken: 'still-good',
      oxidTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    });

    expect(await getValidOxidToken(integration.id)).toBe('still-good');
    expect(refreshOxidAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes a token that expires within the safety margin', async () => {
    const integration = addIntegration({
      portalId: 1201,
      oxidAccessToken: 'about-to-expire',
      oxidTokenExpiresAt: new Date(Date.now() + 10 * 1000),
    });

    expect(await getValidOxidToken(integration.id)).toBe('refreshed-oxid-access');
    expect(refreshOxidAccessToken).toHaveBeenCalledWith('https://shop.example.com', {
      clientId: 'shop-client-id',
      clientSecret: 'shop-client-secret',
      refreshToken: 'shop-refresh-token',
    });

    const stored = fakeState.integrations.find((row) => row.id === integration.id);
    expect(decrypt(stored?.oxidAccessToken as string)).toBe('refreshed-oxid-access');
    expect(decrypt(stored?.oxidRefreshToken as string)).toBe('refreshed-oxid-refresh');
  });

  it('refreshes only once when several calls race', async () => {
    const integration = addIntegration({
      portalId: 1202,
      oxidTokenExpiresAt: new Date(Date.now() - 1000),
    });

    const tokens = await Promise.all([
      getValidOxidToken(integration.id),
      getValidOxidToken(integration.id),
    ]);

    expect(tokens).toEqual(['refreshed-oxid-access', 'refreshed-oxid-access']);
    expect(refreshOxidAccessToken).toHaveBeenCalledTimes(1);
  });

  it('surfaces a shop error as a retryable external error', async () => {
    const integration = addIntegration({
      portalId: 1203,
      oxidTokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshOxidAccessToken.mockRejectedValue(
      new ExternalApiError('OXID token request failed', { system: 'oxid', status: 503 }),
    );

    await expect(getValidOxidToken(integration.id)).rejects.toThrow(ExternalApiError);
  });

  it('refuses to refresh for a shop that was never OAuth connected', async () => {
    const integration = addIntegration({
      portalId: 1204,
      oxidRefreshToken: null,
      oxidAccessToken: null,
      oxidTokenExpiresAt: null,
    });

    await expect(getValidOxidToken(integration.id)).rejects.toThrow(/not connected/);
  });
});
