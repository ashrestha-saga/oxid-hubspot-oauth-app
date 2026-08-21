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

describe('Pairing flow', () => {
  it('serves the connect page only with a valid session', async () => {
    const integration = addIntegration({ portalId: 700, status: 'pending' });

    const anonymous = await request(app).get('/oxid/connect');
    expect(anonymous.status).toBe(401);

    const authorized = await request(app)
      .get('/oxid/connect')
      .set('Cookie', sessionCookie(integration.id, '700'));

    expect(authorized.status).toBe(200);
    expect(authorized.text).toContain('Connect your OXID shop');
    expect(authorized.text).toContain(
      'https://app.hubspot.com/integrations-settings/700/installed/1234567',
    );
  });

  it('refuses to start pairing without a session', async () => {
    const response = await request(app)
      .post('/oxid/pair/start')
      .send({ shopUrl: 'https://shop.example.com' });

    expect(response.status).toBe(401);
    expect(fakeState.pairings).toHaveLength(0);
  });

  it('mints a single-use token and redirect URL for the session portal', async () => {
    const integration = addIntegration({ portalId: 701, status: 'pending' });

    const response = await request(app)
      .post('/oxid/pair/start')
      .set('Cookie', sessionCookie(integration.id, '701'))
      .send({ shopUrl: 'shop.example.com/admin/' });

    expect(response.status).toBe(200);
    expect(response.body.shopUrl).toBe('https://shop.example.com');

    const redirect = new URL(response.body.redirectUrl);
    expect(redirect.searchParams.get('cl')).toBe('hubspot_connect');

    expect(fakeState.pairings).toHaveLength(1);
    expect(fakeState.pairings[0]).toMatchObject({
      hubspotPortalId: 701n,
      oxidShopUrl: 'https://shop.example.com',
      used: false,
    });
    expect(redirect.searchParams.get('pairing_token')).toBe(fakeState.pairings[0]?.token);
  });

  it('rejects a shop URL that is not https', async () => {
    const integration = addIntegration({ portalId: 702, status: 'pending' });

    const response = await request(app)
      .post('/oxid/pair/start')
      .set('Cookie', sessionCookie(integration.id, '702'))
      .send({ shopUrl: 'http://shop.example.com' });

    expect(response.status).toBe(400);
  });

  it('completes pairing, activates the tenant and returns the secret once', async () => {
    const integration = addIntegration({
      portalId: 703,
      status: 'pending',
      oxidShopId: null,
    });
    integration.oxidShopId = null;

    const start = await request(app)
      .post('/oxid/pair/start')
      .set('Cookie', sessionCookie(integration.id, '703'))
      .send({ shopUrl: 'https://shop.example.com' });

    const token = new URL(start.body.redirectUrl).searchParams.get('pairing_token') as string;

    const callback = await request(app).post('/oxid/pair/callback').send({
      pairing_token: token,
      shop_url: 'https://shop.example.com/admin',
      api_key: 'shop-api-key-0123456789',
    });

    expect(callback.status).toBe(200);
    expect(callback.body).toMatchObject({ status: 'ok', hubspot_portal_id: '703' });
    expect(callback.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(callback.body.webhook_url).toBe(
      `${BASE_URL}/webhooks/oxid/${callback.body.oxid_shop_id}`,
    );

    const stored = fakeState.integrations.find((row) => row.id === integration.id);
    expect(stored?.status).toBe('active');
    expect(stored?.oxidBaseUrl).toBe('https://shop.example.com');
    expect(stored?.oxidApiKey).toMatch(/^v1:/);
    expect(stored?.oxidWebhookSecret).not.toContain(callback.body.webhook_secret);

    const status = await request(app)
      .get('/oxid/status')
      .set('Cookie', sessionCookie(integration.id, '703'));
    expect(status.body).toMatchObject({ connected: true, status: 'active' });
  });

  it('rejects an unknown token', async () => {
    const response = await request(app).post('/oxid/pair/callback').send({
      pairing_token: 'definitely-not-a-real-token',
      shop_url: 'https://shop.example.com',
      api_key: 'shop-api-key-0123456789',
    });

    expect(response.status).toBe(400);
  });

  it('rejects a reused token', async () => {
    const integration = addIntegration({ portalId: 704, status: 'pending' });

    const start = await request(app)
      .post('/oxid/pair/start')
      .set('Cookie', sessionCookie(integration.id, '704'))
      .send({ shopUrl: 'https://shop.example.com' });
    const token = new URL(start.body.redirectUrl).searchParams.get('pairing_token') as string;

    const body = {
      pairing_token: token,
      shop_url: 'https://shop.example.com',
      api_key: 'shop-api-key-0123456789',
    };

    expect((await request(app).post('/oxid/pair/callback').send(body)).status).toBe(200);
    expect((await request(app).post('/oxid/pair/callback').send(body)).status).toBe(400);
  });

  it('rejects an expired token', async () => {
    const integration = addIntegration({ portalId: 705, status: 'pending' });
    const start = await request(app)
      .post('/oxid/pair/start')
      .set('Cookie', sessionCookie(integration.id, '705'))
      .send({ shopUrl: 'https://shop.example.com' });

    const token = new URL(start.body.redirectUrl).searchParams.get('pairing_token') as string;
    const pairing = fakeState.pairings.find((row) => row.token === token);
    if (pairing) pairing.expiresAt = new Date(Date.now() - 1000);

    const response = await request(app).post('/oxid/pair/callback').send({
      pairing_token: token,
      shop_url: 'https://shop.example.com',
      api_key: 'shop-api-key-0123456789',
    });

    expect(response.status).toBe(400);
  });

  it('refuses to bind a token to a different shop host', async () => {
    const integration = addIntegration({ portalId: 706, status: 'pending' });
    const start = await request(app)
      .post('/oxid/pair/start')
      .set('Cookie', sessionCookie(integration.id, '706'))
      .send({ shopUrl: 'https://shop.example.com' });

    const token = new URL(start.body.redirectUrl).searchParams.get('pairing_token') as string;

    const response = await request(app).post('/oxid/pair/callback').send({
      pairing_token: token,
      shop_url: 'https://attacker.example.com',
      api_key: 'shop-api-key-0123456789',
    });

    expect(response.status).toBe(400);
    expect(
      fakeState.integrations.find((row) => row.id === integration.id)?.status,
    ).toBe('pending');
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
