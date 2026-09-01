import './helpers/mocks';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { oxidSignatureFor, hubspotSignedPayload } from '../src/lib/hmac';
import { signPairingSession, PAIRING_COOKIE } from '../src/lib/session';
import { resetStubOxidStore } from '../src/oxid/adapters/stubOxidClient';
import { resetOxidClientFactory } from '../src/oxid/client';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';
import { resetFakeHubspot, seedFakeHubspotContact } from './helpers/fakeHubspot';

vi.mock('../src/hubspot/oauthApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hubspot/oauthApi')>();
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn().mockResolvedValue({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    }),
    getTokenInfo: vi.fn().mockResolvedValue({
      portalId: '4242',
      hubDomain: 'merchant.hubspot.test',
      appId: 1234567,
      scopes: ['crm.objects.contacts.read'],
      user: 'admin@merchant.test',
    }),
  };
});

const CLIENT_SECRET = 'test-client-secret';
const BASE_URL = 'https://backend.test';
const SHOP_SECRET = 'shop-webhook-secret';

let app: Express;

function oxidBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'customer.updated',
    customer: {
      id: 'oxid-1',
      email: 'kunde@example.com',
      firstName: 'Anna',
      lastName: 'Beispiel',
      phone: '030 123',
    },
    ...overrides,
  });
}

/** Raw OXID `users` object (see user.json) — no normalization in the module required. */
function oxidRawUsersBody(): string {
  return JSON.stringify({
    users: {
      oxusername: 'j.smith02@merzljak.de',
      oxfname: 'Jane02',
      oxlname: 'Smith02',
      mcustnr: '66666692',
      oxcreate: '2026-07-31T17:28:36+02:00',
      oxstreet: 'In der Raste',
      oxstreetnr: '14',
      oxzip: '53129',
      oxcity: 'Bonn',
      oxcountryid: 'a7c40f631fc920687.20179984',
      child_ids: [
        {
          oxcompany: 'MWV',
          oxfon: '+49 30 12345678',
        },
      ],
    },
  });
}

function postOxidWebhook(
  shopId: string,
  body: string,
  options: { secret?: string; timestamp?: string; signature?: string } = {},
) {
  const timestamp = options.timestamp ?? String(Date.now());
  const signature =
    options.signature ?? oxidSignatureFor(body, timestamp, options.secret ?? SHOP_SECRET);

  return request(app)
    .post(`/webhooks/oxid/${shopId}`)
    .set('Content-Type', 'application/json')
    .set('X-Oxid-Timestamp', timestamp)
    .set('X-Oxid-Signature', signature)
    .send(body);
}

async function postHubspotWebhook(events: unknown, options: { signed?: boolean } = {}) {
  const body = JSON.stringify(events);
  const timestamp = String(Date.now());
  const { createHmac } = await import('node:crypto');
  const signature = createHmac('sha256', options.signed === false ? 'wrong' : CLIENT_SECRET)
    .update(hubspotSignedPayload('POST', `${BASE_URL}/webhooks/hubspot`, body, timestamp), 'utf8')
    .digest('base64');

  return request(app)
    .post('/webhooks/hubspot')
    .set('Content-Type', 'application/json')
    .set('X-HubSpot-Request-Timestamp', timestamp)
    .set('X-HubSpot-Signature-v3', signature)
    .send(body);
}

function sessionCookie(integrationId: string, portalId: string): string {
  return `${PAIRING_COOKIE}=${signPairingSession({ integrationId, portalId })}`;
}

beforeEach(() => {
  resetFakeDb();
  resetFakeHubspot();
  resetStubOxidStore();
  resetOxidClientFactory();
  app = createApp();
});

describe('GET /healthz', () => {
  it('reports ok with queue counts', async () => {
    const response = await request(app).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(response.body.queue).toEqual([]);
  });
});

describe('unknown routes', () => {
  it('answer with a JSON 404', async () => {
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');
  });
});

describe('POST /webhooks/oxid/:oxidShopId', () => {
  it('queues a job for a correctly signed request', async () => {
    const integration = addIntegration({ portalId: 500, oxidShopId: 'shop-500' });

    const response = await postOxidWebhook('shop-500', oxidBody());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'queued', deduped: false });
    expect(fakeState.jobs).toHaveLength(1);
    expect(fakeState.jobs[0]).toMatchObject({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      dedupeKey: 'oxid_to_hubspot:oxid-1',
      status: 'pending',
    });
  });

  it('accepts a raw OXID users payload and maps fields before enqueueing', async () => {
    const integration = addIntegration({ portalId: 512, oxidShopId: 'shop-512' });

    const response = await postOxidWebhook('shop-512', oxidRawUsersBody());

    expect(response.status).toBe(202);
    expect(fakeState.jobs).toHaveLength(1);
    expect(fakeState.jobs[0]).toMatchObject({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      dedupeKey: 'oxid_to_hubspot:66666692',
      payload: {
        id: '66666692',
        fields: {
          email: 'j.smith02@merzljak.de',
          firstName: 'Jane02',
          lastName: 'Smith02',
          phone: '+493012345678',
          company: 'MWV',
          address: 'In der Raste 14',
          city: 'Bonn',
          zip: '53129',
          country: 'a7c40f631fc920687.20179984',
        },
      },
    });
  });

  it('folds a repeat delivery into the pending job', async () => {
    addIntegration({ portalId: 501, oxidShopId: 'shop-501' });

    await postOxidWebhook('shop-501', oxidBody());
    const second = await postOxidWebhook('shop-501', oxidBody());

    expect(second.body.deduped).toBe(true);
    expect(fakeState.jobs).toHaveLength(1);
  });

  it('returns 404 for an unknown shop id', async () => {
    addIntegration({ portalId: 502, oxidShopId: 'shop-502' });

    const response = await postOxidWebhook('shop-does-not-exist', oxidBody());

    expect(response.status).toBe(404);
    expect(fakeState.jobs).toHaveLength(0);
  });

  it('returns 401 for a wrong signature', async () => {
    addIntegration({ portalId: 503, oxidShopId: 'shop-503' });

    const response = await postOxidWebhook('shop-503', oxidBody(), { secret: 'not-the-secret' });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_signature');
    expect(fakeState.jobs).toHaveLength(0);
  });

  it('returns 401 when the signature headers are missing', async () => {
    addIntegration({ portalId: 504, oxidShopId: 'shop-504' });

    const response = await request(app)
      .post('/webhooks/oxid/shop-504')
      .set('Content-Type', 'application/json')
      .send(oxidBody());

    expect(response.status).toBe(401);
  });

  it('returns 401 when the body was altered after signing', async () => {
    addIntegration({ portalId: 505, oxidShopId: 'shop-505' });

    const signed = oxidBody();
    const timestamp = String(Date.now());
    const signature = oxidSignatureFor(signed, timestamp, SHOP_SECRET);

    const response = await request(app)
      .post('/webhooks/oxid/shop-505')
      .set('Content-Type', 'application/json')
      .set('X-Oxid-Timestamp', timestamp)
      .set('X-Oxid-Signature', signature)
      .send(signed.replace('Anna', 'Bert'));

    expect(response.status).toBe(401);
  });

  it('returns 401 for a replayed request', async () => {
    addIntegration({ portalId: 506, oxidShopId: 'shop-506' });

    const response = await postOxidWebhook('shop-506', oxidBody(), {
      timestamp: String(Date.now() - 10 * 60 * 1000),
    });

    expect(response.status).toBe(401);
  });

  it("rejects one tenant's signature against another tenant's shop", async () => {
    addIntegration({ portalId: 507, oxidShopId: 'shop-a', oxidWebhookSecret: 'secret-a' });
    addIntegration({ portalId: 508, oxidShopId: 'shop-b', oxidWebhookSecret: 'secret-b' });

    const response = await postOxidWebhook('shop-b', oxidBody(), { secret: 'secret-a' });

    expect(response.status).toBe(401);
    expect(fakeState.jobs).toHaveLength(0);
  });

  it('rejects a payload whose shopId contradicts the URL', async () => {
    addIntegration({ portalId: 509, oxidShopId: 'shop-509' });

    const response = await postOxidWebhook('shop-509', oxidBody({ shopId: 'shop-other' }));

    expect(response.status).toBe(400);
  });

  it('rejects a payload without a customer id', async () => {
    addIntegration({ portalId: 510, oxidShopId: 'shop-510' });

    const response = await postOxidWebhook(
      'shop-510',
      JSON.stringify({ customer: { email: 'x@example.com' } }),
    );

    expect(response.status).toBe(400);
  });

  it('returns 409 while the integration is not active', async () => {
    addIntegration({ portalId: 511, oxidShopId: 'shop-511', status: 'paused' });

    const response = await postOxidWebhook('shop-511', oxidBody());

    expect(response.status).toBe(409);
    expect(fakeState.jobs).toHaveLength(0);
  });
});

describe('POST /webhooks/hubspot', () => {
  it('queues one job per changed contact', async () => {
    const integration = addIntegration({ portalId: 600 });

    const response = await postHubspotWebhook([
      { portalId: 600, objectId: 12345, subscriptionType: 'contact.propertyChange' },
      { portalId: 600, objectId: 12345, subscriptionType: 'contact.propertyChange' },
      { portalId: 600, objectId: 67890, subscriptionType: 'contact.propertyChange' },
    ]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ received: 3, queued: 3, ignored: 0 });
    // Three events, two contacts: the repeat folds into the pending job.
    expect(fakeState.jobs).toHaveLength(2);
    expect(fakeState.jobs.map((job) => job.dedupeKey).sort()).toEqual([
      'hubspot_to_oxid:12345',
      'hubspot_to_oxid:67890',
    ]);
    expect(fakeState.jobs[0]?.integrationId).toBe(integration.id);
  });

  it('returns 401 for an invalid signature', async () => {
    addIntegration({ portalId: 601 });

    const response = await postHubspotWebhook([{ portalId: 601, objectId: 1 }], { signed: false });

    expect(response.status).toBe(401);
    expect(fakeState.jobs).toHaveLength(0);
  });

  it('acknowledges but ignores events for unknown or inactive portals', async () => {
    addIntegration({ portalId: 602, status: 'paused' });

    const response = await postHubspotWebhook([
      { portalId: 602, objectId: 1 },
      { portalId: 999999, objectId: 2 },
      { objectId: 3 },
    ]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ queued: 0, ignored: 3 });
  });

  it('rejects a body that is not an event array', async () => {
    const response = await postHubspotWebhook({ not: 'an array' });
    expect(response.status).toBe(400);
  });
});

describe('OAuth routes', () => {
  it('redirects the install to HubSpot with the configured scopes', async () => {
    const response = await request(app).get('/oauth/install');

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location as string);
    expect(target.origin + target.pathname).toBe('https://app.hubspot.com/oauth/authorize');
    expect(target.searchParams.get('client_id')).toBe('test-client-id');
    expect(target.searchParams.get('scope')).toContain('crm.objects.contacts.read');
  });

  it('creates a pending integration and issues a pairing session', async () => {
    const response = await request(app).get('/oauth/callback?code=auth-code');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/oxid/connect');
    expect(response.headers['set-cookie']?.[0]).toContain(PAIRING_COOKIE);
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly');

    expect(fakeState.integrations).toHaveLength(1);
    expect(fakeState.integrations[0]).toMatchObject({
      hubspotPortalId: 4242n,
      status: 'pending',
      name: 'merchant.hubspot.test',
    });
    // Tokens are stored encrypted, never in the clear.
    expect(fakeState.integrations[0]?.hubspotAccessToken).not.toContain('fresh-access-token');
    expect(fakeState.integrations[0]?.hubspotAccessToken).toMatch(/^v1:/);
  });

  it('rejects a callback without a code', async () => {
    const response = await request(app).get('/oauth/callback');
    expect(response.status).toBe(400);
  });

  it('reports a denied install', async () => {
    const response = await request(app).get('/oauth/callback?error=access_denied');
    expect(response.status).toBe(400);
  });
});

describe('OXID OAuth flow', () => {
  it('serves the connect page only with a valid session', async () => {
    const integration = addIntegration({
      portalId: 700,
      status: 'pending',
      oxidRefreshToken: null,
      oxidShopId: null,
    });

    const anonymous = await request(app).get('/oxid/connect');
    expect(anonymous.status).toBe(401);

    const authorized = await request(app)
      .get('/oxid/connect')
      .set('Cookie', sessionCookie(integration.id, '700'));

    expect(authorized.status).toBe(200);
    expect(authorized.text).toContain('Connect your OXID shop');
    expect(authorized.text).toContain('OAuth Client ID');
    expect(authorized.text).toContain(
      'https://app.hubspot.com/integrations-settings/700/installed/1234567',
    );
  });

  it('refuses to start OXID OAuth without a session', async () => {
    const response = await request(app)
      .post('/oxid/oauth/start')
      .send({
        shopUrl: 'https://shop.example.com',
        clientId: 'mwv_client',
        clientSecret: 'secret',
      });

    expect(response.status).toBe(401);
  });

  it('redirects to OXID authorize with PKCE when starting OAuth', async () => {
    const integration = addIntegration({
      portalId: 701,
      status: 'pending',
      oxidRefreshToken: null,
      oxidShopId: null,
    });

    const response = await request(app)
      .post('/oxid/oauth/start')
      .set('Cookie', sessionCookie(integration.id, '701'))
      .send({
        shopUrl: 'shop.example.com/admin/',
        clientId: 'mwv_client',
        clientSecret: 'secret',
      });

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location as string);
    expect(target.searchParams.get('cl')).toBe('oauthauthorize');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe('mwv_client');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toBeTruthy();
    expect(target.searchParams.get('state')).toBeTruthy();

    const stored = fakeState.integrations.find((row) => row.id === integration.id);
    expect(stored?.oxidBaseUrl).toBe('https://shop.example.com');
  });

  it('rejects a shop URL that is not https', async () => {
    const integration = addIntegration({
      portalId: 702,
      status: 'pending',
      oxidRefreshToken: null,
      oxidShopId: null,
    });

    const response = await request(app)
      .post('/oxid/oauth/start')
      .set('Cookie', sessionCookie(integration.id, '702'))
      .send({
        shopUrl: 'http://shop.example.com',
        clientId: 'mwv_client',
        clientSecret: 'secret',
      });

    expect(response.status).toBe(400);
  });

  it('completes OXID OAuth callback, activates tenant and redirects to mapping', async () => {
    const integration = addIntegration({
      portalId: 703,
      status: 'pending',
      oxidShopId: null,
      oxidRefreshToken: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('oauthtoken')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                access_token: 'oxid-access',
                refresh_token: 'oxid-refresh',
                expires_in: 3600,
              }),
          } as Response;
        }
        if (href.includes('oauthme')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                status: 'success',
                data: { sub: 'cust-1', email: 'user@example.com' },
              }),
          } as Response;
        }
        return { ok: false, status: 404, text: async () => 'not found' } as Response;
      }),
    );

    const start = await request(app)
      .post('/oxid/oauth/start')
      .set('Cookie', sessionCookie(integration.id, '703'))
      .send({
        shopUrl: 'https://shop.example.com',
        clientId: 'mwv_client',
        clientSecret: 'secret',
      });

    const state = new URL(start.headers.location as string).searchParams.get('state') as string;

    const callback = await request(app).get(
      `/oxid/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/oxid/mapping');

    const stored = fakeState.integrations.find((row) => row.id === integration.id);
    expect(stored?.status).toBe('active');
    expect(stored?.oxidBaseUrl).toBe('https://shop.example.com');
    expect(stored?.oxidRefreshToken).toMatch(/^v1:/);
    expect(stored?.oxidWebhookSecret).toMatch(/^v1:/);
    expect(stored?.oxidShopId).toBeTruthy();
  });

  it('rejects OXID OAuth callback with invalid state', async () => {
    const response = await request(app).get('/oxid/oauth/callback?code=auth-code&state=bogus');
    expect(response.status).toBe(400);
  });
});

describe('end-to-end through the queue', () => {
  it('a signed OXID webhook results in a HubSpot contact once the worker runs', async () => {
    const integration = addIntegration({ portalId: 800, oxidShopId: 'shop-800' });
    seedFakeHubspotContact(integration.id, { properties: { email: 'other@example.com' } });

    await postOxidWebhook('shop-800', oxidBody());

    const { SyncWorker } = await import('../src/sync/worker');
    const processed = await new SyncWorker().tick();

    expect(processed).toBe(1);
    expect(fakeState.jobs[0]?.status).toBe('done');

    const { fakeHubspotStore } = await import('./helpers/fakeHubspot');
    const emails = fakeHubspotStore(integration.id).contacts.map((c) => c.properties.email);
    expect(emails).toContain('kunde@example.com');
  });
});
