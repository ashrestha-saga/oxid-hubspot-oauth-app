import './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';
import { fakeHubspotStore, resetFakeHubspot, seedFakeHubspotContact } from './helpers/fakeHubspot';
import { resetStubOxidStore, seedStubCustomer, stubCustomers } from '../src/oxid/adapters/stubOxidClient';
import { resetOxidClientFactory } from '../src/oxid/client';
import { syncContact } from '../src/sync/syncContact';
import { contactHash } from '../src/sync/hash';

const customer = {
  id: 'oxid-1',
  email: 'kunde@example.com',
  firstName: 'Anna',
  lastName: 'Beispiel',
  phone: '+49 30 123456',
  updatedAt: new Date().toISOString(),
};

function eventsFor(integrationId: string) {
  return fakeState.events.filter((event) => event.integrationId === integrationId);
}

beforeEach(() => {
  resetFakeDb();
  resetFakeHubspot();
  resetStubOxidStore();
  resetOxidClientFactory();
});

describe('syncContact: OXID -> HubSpot', () => {
  it('creates the contact and links both ids in one mapping', async () => {
    const integration = addIntegration({ portalId: 111 });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: customer },
    });

    expect(result.status).toBe('success');

    const store = fakeHubspotStore(integration.id);
    expect(store.contacts).toHaveLength(1);
    expect(store.contacts[0]?.properties).toMatchObject({
      email: 'kunde@example.com',
      firstname: 'Anna',
      lastname: 'Beispiel',
      phone: '+4930123456',
    });

    expect(fakeState.mappings).toHaveLength(1);
    expect(fakeState.mappings[0]).toMatchObject({
      integrationId: integration.id,
      oxidCustomerId: 'oxid-1',
      hubspotContactId: store.contacts[0]?.id,
      sourceOfLastWrite: 'oxid',
    });
  });

  it('matches an existing HubSpot contact by email instead of duplicating it', async () => {
    const integration = addIntegration({ portalId: 112 });
    const existing = seedFakeHubspotContact(integration.id, {
      properties: { email: 'KUNDE@example.com', firstname: 'Old' },
    });

    await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: customer },
    });

    const store = fakeHubspotStore(integration.id);
    expect(store.contacts).toHaveLength(1);
    expect(store.contacts[0]?.id).toBe(existing.id);
    expect(store.contacts[0]?.properties.firstname).toBe('Anna');
  });

  it('skips a redelivery of the same payload without writing', async () => {
    const integration = addIntegration({ portalId: 113 });
    const sourceRecord = { id: customer.id, fields: customer };

    await syncContact({ integrationId: integration.id, direction: 'oxid_to_hubspot', sourceRecord });
    const writesAfterFirst = fakeHubspotStore(integration.id).writes;

    const second = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord,
    });

    expect(second.status).toBe('skipped_loop');
    expect(fakeHubspotStore(integration.id).writes).toBe(writesAfterFirst);
  });

  it('syncs again once a mapped field actually changes', async () => {
    const integration = addIntegration({ portalId: 114 });

    await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: customer },
    });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: { ...customer, phone: '+49 30 999999' } },
    });

    expect(result.status).toBe('success');
    expect(fakeHubspotStore(integration.id).contacts[0]?.properties.phone).toBe('+4930999999');
  });
});

describe('syncContact: HubSpot -> OXID', () => {
  it('creates the OXID customer with mapped fields', async () => {
    const integration = addIntegration({ portalId: 121 });
    const contact = seedFakeHubspotContact(integration.id, {
      properties: {
        email: 'neu@example.com',
        firstname: 'Bert',
        lastname: 'Neu',
        phone: '0304444',
      },
    });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'hubspot_to_oxid',
      sourceRecord: { id: contact.id },
    });

    expect(result.status).toBe('success');

    const customers = stubCustomers(integration.id);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      email: 'neu@example.com',
      firstName: 'Bert',
      lastName: 'Neu',
      phone: '0304444',
    });
  });

  it('hydrates the full contact when only an id is queued', async () => {
    const integration = addIntegration({ portalId: 122 });
    const contact = seedFakeHubspotContact(integration.id, {
      properties: { email: 'hydrate@example.com', firstname: 'Hy' },
    });

    await syncContact({
      integrationId: integration.id,
      direction: 'hubspot_to_oxid',
      sourceRecord: { id: contact.id },
    });

    expect(stubCustomers(integration.id)[0]?.firstName).toBe('Hy');
  });

  it('updates an existing OXID customer matched by email', async () => {
    const integration = addIntegration({ portalId: 123 });
    seedStubCustomer(integration.id, {
      id: 'oxid-existing',
      email: 'match@example.com',
      firstName: 'Alt',
      lastName: null,
      phone: null,
      updatedAt: new Date().toISOString(),
    });
    const contact = seedFakeHubspotContact(integration.id, {
      properties: { email: 'match@example.com', firstname: 'Neu' },
    });

    await syncContact({
      integrationId: integration.id,
      direction: 'hubspot_to_oxid',
      sourceRecord: { id: contact.id },
    });

    const customers = stubCustomers(integration.id);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: 'oxid-existing', firstName: 'Neu' });
  });
});

describe('syncContact: loop suppression across directions', () => {
  it('suppresses the echo the destination system sends back', async () => {
    const integration = addIntegration({ portalId: 131 });

    // OXID pushes a change, we write it to HubSpot.
    await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: customer },
    });

    const contactId = fakeState.mappings[0]?.hubspotContactId as string;
    const writesBefore = fakeHubspotStore(integration.id).writes;
    const oxidCountBefore = stubCustomers(integration.id).length;

    // HubSpot now fires contact.propertyChange for our own write. This is the
    // case the spec's origin-based guard missed: the echo arrives with origin
    // 'hubspot' while the last write was recorded as 'oxid'.
    const echo = await syncContact({
      integrationId: integration.id,
      direction: 'hubspot_to_oxid',
      sourceRecord: { id: contactId },
    });

    expect(echo.status).toBe('skipped_loop');
    expect(fakeHubspotStore(integration.id).writes).toBe(writesBefore);
    expect(stubCustomers(integration.id)).toHaveLength(oxidCountBefore);

    const statuses = eventsFor(integration.id).map((event) => event.status);
    expect(statuses).toEqual(['success', 'skipped_loop']);
  });

  it('records the hash of the values written, so the echo can be recognised', async () => {
    const integration = addIntegration({ portalId: 132 });

    await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: customer },
    });

    expect(fakeState.mappings[0]?.lastSyncedHash).toBe(
      contactHash({
        email: 'kunde@example.com',
        firstName: 'Anna',
        lastName: 'Beispiel',
        phone: '+4930123456',
      }),
    );
  });
});

describe('syncContact: guards', () => {
  it('skips records without an email', async () => {
    const integration = addIntegration({ portalId: 141 });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: 'oxid-no-mail', fields: { firstName: 'Ohne', email: null } },
    });

    expect(result.status).toBe('skipped_no_email');
    expect(fakeHubspotStore(integration.id).contacts).toHaveLength(0);
  });

  it('does not propagate deletions in v1', async () => {
    const integration = addIntegration({ portalId: 142 });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: customer.id, fields: customer, deleted: true },
    });

    expect(result.status).toBe('skipped_unsupported');
    expect(fakeHubspotStore(integration.id).contacts).toHaveLength(0);
  });

  it('refuses to sync an integration that is not active', async () => {
    const integration = addIntegration({ portalId: 143, status: 'paused' });

    await expect(
      syncContact({
        integrationId: integration.id,
        direction: 'oxid_to_hubspot',
        sourceRecord: { id: customer.id, fields: customer },
      }),
    ).rejects.toThrow(/not active/);
  });

  it('reports an error when the source record no longer exists', async () => {
    const integration = addIntegration({ portalId: 144 });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'hubspot_to_oxid',
      sourceRecord: { id: 'hs-missing' },
    });

    expect(result.status).toBe('error');
    expect(eventsFor(integration.id)[0]?.status).toBe('error');
  });
});

describe('syncContact: multi-tenant isolation', () => {
  it('never lets a change in one tenant touch another', async () => {
    const tenantA = addIntegration({ portalId: 201 });
    const tenantB = addIntegration({ portalId: 202 });

    seedStubCustomer(tenantB.id, {
      id: 'oxid-1',
      email: 'b@example.com',
      firstName: 'Tenant',
      lastName: 'B',
      phone: null,
      updatedAt: new Date().toISOString(),
    });
    seedFakeHubspotContact(tenantB.id, { properties: { email: 'b@example.com', firstname: 'B' } });

    // Same OXID customer id in tenant A - a scoping bug would collide here.
    await syncContact({
      integrationId: tenantA.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: 'oxid-1', fields: customer },
    });

    expect(fakeHubspotStore(tenantA.id).contacts).toHaveLength(1);
    expect(fakeHubspotStore(tenantA.id).contacts[0]?.properties.email).toBe('kunde@example.com');

    const tenantBContacts = fakeHubspotStore(tenantB.id).contacts;
    expect(tenantBContacts).toHaveLength(1);
    expect(tenantBContacts[0]?.properties.email).toBe('b@example.com');
    expect(fakeHubspotStore(tenantB.id).writes).toBe(0);

    expect(stubCustomers(tenantB.id)[0]?.firstName).toBe('Tenant');

    const mappings = fakeState.mappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.integrationId).toBe(tenantA.id);
    expect(eventsFor(tenantB.id)).toHaveLength(0);
  });

  it('keeps separate mappings for the same email in two tenants', async () => {
    const tenantA = addIntegration({ portalId: 211 });
    const tenantB = addIntegration({ portalId: 212 });

    for (const integration of [tenantA, tenantB]) {
      await syncContact({
        integrationId: integration.id,
        direction: 'oxid_to_hubspot',
        sourceRecord: { id: 'shared-oxid-id', fields: customer },
      });
    }

    expect(fakeState.mappings).toHaveLength(2);
    expect(new Set(fakeState.mappings.map((row) => row.integrationId))).toEqual(
      new Set([tenantA.id, tenantB.id]),
    );
    expect(fakeHubspotStore(tenantA.id).contacts[0]?.id).not.toBe(
      fakeHubspotStore(tenantB.id).contacts[0]?.id,
    );
  });
});
