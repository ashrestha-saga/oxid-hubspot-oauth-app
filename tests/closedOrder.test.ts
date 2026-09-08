import './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';
import { fakeHubspotStore, resetFakeHubspot, seedFakeHubspotContact } from './helpers/fakeHubspot';
import { resetStubOxidStore } from '../src/oxid/adapters/stubOxidClient';
import { resetOxidClientFactory } from '../src/oxid/client';
import { parseClosedOrderWebhook } from '../src/oxid/orderWebhookPayload';
import { processClosedOrder } from '../src/sync/processClosedOrder';
import { SyncWorker } from '../src/sync/worker';

const sampleOrderBody = {
  orders: {
    oxid: '3688b4216d4e3743a36471405b06cb5e',
    oxshopid: 1,
    oxorderdate: '2026-05-27 17:24:51',
    oxordernr: 519,
    oxtotalordersum: 52.71,
    oxcurrency: 'EUR',
    shopname: 'Med Sales',
    user: {
      oxid: '0400f18a7c9695af0e330bde325abdd6',
      oxusername: 'a.shrestha@merzljak.de',
      oxcompany: 'Merzljak W/V GmbH',
      oxfname: 'John',
      oxlname: 'ADM01',
      oxstreet: 'In der Raste',
      oxstreetnr: '14',
      oxcity: 'Bonn',
      oxzip: '53129',
      oxfon: '',
      country: 'Deutschland',
    },
    items: [
      {
        oxid: '35e748868b37775b0d69b2abc1c063c9',
        oxamount: 1,
        oxartnum: '1502',
        oxtitle: 'Pumpe CABRINHA INFLATION',
        oxshortdesc: 'Zuverlässige Pumpe',
        oxnetprice: 29.9,
        oxbrutprice: 35.58,
      },
      {
        oxid: 'b6c35923fe093ef5d0c4f0d77f7426af',
        oxamount: 1,
        oxartnum: '1506',
        oxtitle: 'KiteFix Kleber GLUFIX (30g)',
        oxshortdesc: 'Klebstoff',
        oxnetprice: 12.49,
        oxbrutprice: 12.49,
      },
    ],
    billingAddress: {
      oxbillcompany: 'Merzljak W/V GmbH',
      oxbillfname: 'John',
      oxbilllname: 'ADM01',
      oxbillstreet: 'In der Raste',
      oxbillstreetnr: '14',
      oxbillcity: 'Bonn',
      oxbillzip: '53129',
      oxbillfon: '',
    },
  },
};

beforeEach(() => {
  resetFakeDb();
  resetFakeHubspot();
  resetStubOxidStore();
  resetOxidClientFactory();
});

describe('parseClosedOrderWebhook', () => {
  it('normalizes the sample OXID order payload', () => {
    const parsed = parseClosedOrderWebhook(sampleOrderBody);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.order.oxidOrderId).toBe('3688b4216d4e3743a36471405b06cb5e');
    expect(parsed.order.contact.email).toBe('a.shrestha@merzljak.de');
    expect(parsed.order.companyName).toBe('Merzljak W/V GmbH');
    expect(parsed.order.items).toHaveLength(2);
    expect(parsed.order.amount).toBe(52.71);
    expect(parsed.order.contact.address).toBe('In der Raste 14');
  });

  it('rejects missing email', () => {
    const body = structuredClone(sampleOrderBody);
    body.orders.user.oxusername = '';
    const parsed = parseClosedOrderWebhook(body);
    expect(parsed.ok).toBe(false);
  });
});

describe('processClosedOrder', () => {
  it('creates contact, company, deal and line items', async () => {
    const integration = addIntegration({ portalId: 920, oxidShopId: '1' });
    const parsed = parseClosedOrderWebhook(sampleOrderBody);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await processClosedOrder({ integration, order: parsed.order });

    expect(result.success).toBe(true);
    expect(result.owner_id).toBeNull();
    expect(result.line_item_ids).toHaveLength(2);

    const store = fakeHubspotStore(integration.id);
    expect(store.contacts).toHaveLength(1);
    expect(store.companies).toHaveLength(1);
    expect(store.deals).toHaveLength(1);
    expect(store.deals[0]?.properties).toMatchObject({
      dealstage: 'closedwon',
      pipeline: 'default',
      amount: '52.71',
    });
    expect(store.deals[0]?.properties.dealname).toContain('Bestellung 519');
    expect(store.lineItems).toHaveLength(2);
    expect(store.lineItems[0]?.properties.artikelnummer).toBe('1502');
  });

  it('does not overwrite an existing HubSpot contact', async () => {
    const integration = addIntegration({ portalId: 921, oxidShopId: '1' });
    seedFakeHubspotContact(integration.id, {
      properties: {
        email: 'a.shrestha@merzljak.de',
        firstname: 'Existing',
        lastname: 'Contact',
      },
    });

    const parsed = parseClosedOrderWebhook(sampleOrderBody);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    await processClosedOrder({ integration, order: parsed.order });

    const store = fakeHubspotStore(integration.id);
    expect(store.contacts).toHaveLength(1);
    expect(store.contacts[0]?.properties.firstname).toBe('Existing');
  });
});

describe('POST /webhooks/oxid/:shopId/orders', () => {
  const app = createApp();
  const secret = 'order-webhook-secret';

  function sign(body: string, timestamp: string): string {
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('base64');
    return `sha256=${digest}`;
  }

  it('queues a closed-order job', async () => {
    const integration = addIntegration({
      portalId: 922,
      oxidShopId: '1',
      oxidWebhookSecret: secret,
      status: 'active',
    });

    const body = JSON.stringify(sampleOrderBody);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await request(app)
      .post('/webhooks/oxid/1/orders')
      .set('Content-Type', 'application/json')
      .set('X-MWV-Timestamp', timestamp)
      .set('X-MWV-Signature', sign(body, timestamp))
      .send(body);

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('queued');
    expect(fakeState.jobs).toHaveLength(1);
    expect(fakeState.jobs[0]?.dedupeKey).toBe(
      `oxid_to_hubspot:order:3688b4216d4e3743a36471405b06cb5e`,
    );

    const worker = new SyncWorker({ batchSize: 5 });
    await worker.tick();

    const store = fakeHubspotStore(integration.id);
    expect(store.deals).toHaveLength(1);
    expect(store.lineItems).toHaveLength(2);
  });
});
