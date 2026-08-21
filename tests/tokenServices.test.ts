import './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt } from '../src/lib/crypto';
import { ExternalApiError } from '../src/lib/errors';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';

const refreshAccessToken = vi.hoisted(() => vi.fn());

vi.mock('../src/hubspot/oauthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hubspot/oauthApi')>();
  return { ...actual, refreshAccessToken };
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
  function stubTokenEndpoint(
    response: { status?: number; body: unknown },
    onCall?: () => void,
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => {
      onCall?.();
      return {
        ok: (response.status ?? 200) < 400,
        status: response.status ?? 200,
        text: async () => JSON.stringify(response.body),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('mints a token from the stored API key and caches it', async () => {
    const integration = addIntegration({ portalId: 1200 });
    const fetchMock = stubTokenEndpoint({
      body: { access_token: 'oxid-bearer', expires_in: 3600 },
    });

    expect(await getValidOxidToken(integration.id)).toBe('oxid-bearer');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://shop.example.com/oxapi/token');
    expect(JSON.parse(init.body as string)).toEqual({
      apiKey: 'shop-api-key',
      grantType: 'client_credentials',
    });

    const stored = fakeState.integrations.find((row) => row.id === integration.id);
    expect(decrypt(stored?.oxidAccessToken as string)).toBe('oxid-bearer');
    expect(stored?.oxidTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('reuses the cached token instead of minting again', async () => {
    const integration = addIntegration({ portalId: 1201 });
    const fetchMock = stubTokenEndpoint({
      body: { access_token: 'cached-bearer', expires_in: 3600 },
    });

    await getValidOxidToken(integration.id);
    const second = await getValidOxidToken(integration.id);

    expect(second).toBe('cached-bearer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token is inside the expiry margin', async () => {
    const integration = addIntegration({ portalId: 1202 });
    const fetchMock = stubTokenEndpoint({
      body: { access_token: 'first-bearer', expires_in: 3600 },
    });
    await getValidOxidToken(integration.id);

    const row = fakeState.integrations.find((entry) => entry.id === integration.id);
    if (row) row.oxidTokenExpiresAt = new Date(Date.now() + 10 * 1000);

    stubTokenEndpoint({ body: { access_token: 'second-bearer', expires_in: 3600 } });
    expect(await getValidOxidToken(integration.id)).toBe('second-bearer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mints only once when several calls race', async () => {
    const integration = addIntegration({ portalId: 1203 });
    let calls = 0;
    stubTokenEndpoint({ body: { access_token: 'raced-bearer', expires_in: 3600 } }, () => {
      calls += 1;
    });

    const tokens = await Promise.all([
      getValidOxidToken(integration.id),
      getValidOxidToken(integration.id),
    ]);

    expect(tokens).toEqual(['raced-bearer', 'raced-bearer']);
    expect(calls).toBe(1);
  });

  it('surfaces a shop error as a retryable external error', async () => {
    const integration = addIntegration({ portalId: 1204 });
    stubTokenEndpoint({ status: 503, body: { error: 'maintenance' } });

    await expect(getValidOxidToken(integration.id)).rejects.toThrow(ExternalApiError);
  });

  it('rejects a token response that is missing the fields we need', async () => {
    const integration = addIntegration({ portalId: 1205 });
    stubTokenEndpoint({ body: { token: 'wrong-shape' } });

    await expect(getValidOxidToken(integration.id)).rejects.toThrow(/missing access_token/);
  });

  it('refuses to mint for a shop that was never paired', async () => {
    const integration = addIntegration({ portalId: 1206 });
    const row = fakeState.integrations.find((entry) => entry.id === integration.id);
    if (row) row.oxidApiKey = null;

    await expect(getValidOxidToken(integration.id)).rejects.toThrow(/not paired/);
  });
});
