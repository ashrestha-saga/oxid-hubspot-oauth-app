import './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';
import { fakeHubspotStore, resetFakeHubspot, seedFakeHubspotCompany } from './helpers/fakeHubspot';
import { resetStubOxidStore } from '../src/oxid/adapters/stubOxidClient';
import { resetOxidClientFactory } from '../src/oxid/client';
import { companyKeyOf } from '../src/sync/companyFieldMap';
import { syncContact } from '../src/sync/syncContact';

beforeEach(() => {
  resetFakeDb();
  resetFakeHubspot();
  resetStubOxidStore();
  resetOxidClientFactory();
});

describe('company upsert + association (OXID → HubSpot)', () => {
  it('creates a HubSpot company and associates it with the contact', async () => {
    const integration = addIntegration({ portalId: 901 });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: {
        id: 'kunde@example.com',
        fields: {
          email: 'kunde@example.com',
          firstName: 'Anna',
          lastName: 'Beispiel',
          company: 'MWV GmbH',
          city: 'Berlin',
          zip: '10115',
          country: 'DE',
        },
      },
    });

    expect(result.status).toBe('success');
    expect(result.hubspotCompanyId).toBeTruthy();

    const store = fakeHubspotStore(integration.id);
    expect(store.contacts).toHaveLength(1);
    expect(store.contacts[0]?.properties.company).toBeUndefined();
    expect(store.companies).toHaveLength(1);
    expect(store.companies[0]?.properties).toMatchObject({
      name: 'MWV GmbH',
      city: 'Berlin',
      zip: '10115',
      country: 'DE',
    });
    expect(store.associations).toEqual([`${store.contacts[0]?.id}:${store.companies[0]?.id}`]);

    expect(fakeState.companyMappings).toHaveLength(1);
    expect(fakeState.companyMappings[0]).toMatchObject({
      companyKey: companyKeyOf('MWV GmbH'),
      companyName: 'MWV GmbH',
      hubspotCompanyId: store.companies[0]?.id,
      sourceOfLastWrite: 'oxid',
    });
  });

  it('reuses an existing HubSpot company matched by name', async () => {
    const integration = addIntegration({ portalId: 902 });
    const existing = seedFakeHubspotCompany(integration.id, {
      properties: { name: 'MWV GmbH', city: 'Old' },
    });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: {
        id: 'kunde@example.com',
        fields: {
          email: 'kunde@example.com',
          firstName: 'Anna',
          company: 'MWV GmbH',
          city: 'Berlin',
        },
      },
    });

    const store = fakeHubspotStore(integration.id);
    expect(result.hubspotCompanyId).toBe(existing.id);
    expect(store.companies).toHaveLength(1);
    expect(store.companies[0]?.properties.city).toBe('Berlin');
    expect(store.associations[0]).toBe(`${result.hubspotContactId}:${existing.id}`);
  });

  it('skips company create when company name is missing', async () => {
    const integration = addIntegration({ portalId: 903 });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: {
        id: 'kunde@example.com',
        fields: {
          email: 'kunde@example.com',
          firstName: 'Anna',
          lastName: 'Beispiel',
        },
      },
    });

    expect(result.status).toBe('success');
    expect(result.hubspotCompanyId).toBeNull();
    expect(fakeHubspotStore(integration.id).companies).toHaveLength(0);
    expect(fakeState.companyMappings).toHaveLength(0);
  });

  it('does not run company sync on HubSpot → OXID', async () => {
    const integration = addIntegration({ portalId: 904 });
    const { seedFakeHubspotContact } = await import('./helpers/fakeHubspot');
    const contact = seedFakeHubspotContact(integration.id, {
      properties: {
        email: 'kunde@example.com',
        firstname: 'Anna',
        lastname: 'Beispiel',
        company: 'Should Not Become Company Object',
      },
    });

    const result = await syncContact({
      integrationId: integration.id,
      direction: 'hubspot_to_oxid',
      sourceRecord: { id: contact.id },
    });

    expect(result.status).toBe('success');
    expect(result.hubspotCompanyId ?? null).toBeNull();
    expect(fakeHubspotStore(integration.id).companies).toHaveLength(0);
  });
});
