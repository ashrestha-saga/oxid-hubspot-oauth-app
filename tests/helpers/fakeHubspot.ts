import { randomUUID } from 'node:crypto';
import type { HubspotContact, HubspotProperties } from '../../src/hubspot/client';

/**
 * In-memory HubSpot CRM. Counts writes so tests can prove that a suppressed
 * loop really performed no write rather than just reporting one.
 */
interface Store {
  contacts: Map<string, HubspotContact>;
  writes: number;
  reads: number;
}

const stores = new Map<string, Store>();

function storeFor(integrationId: string): Store {
  let store = stores.get(integrationId);
  if (!store) {
    store = { contacts: new Map(), writes: 0, reads: 0 };
    stores.set(integrationId, store);
  }
  return store;
}

export function resetFakeHubspot(): void {
  stores.clear();
}

export function fakeHubspotStore(integrationId: string): {
  contacts: HubspotContact[];
  writes: number;
  reads: number;
} {
  const store = storeFor(integrationId);
  return {
    contacts: [...store.contacts.values()].map((contact) => ({ ...contact })),
    writes: store.writes,
    reads: store.reads,
  };
}

export function seedFakeHubspotContact(
  integrationId: string,
  contact: { id?: string; properties: HubspotProperties },
): HubspotContact {
  const record: HubspotContact = {
    id: contact.id ?? `hs-${randomUUID()}`,
    properties: { ...contact.properties },
    updatedAt: new Date().toISOString(),
  };
  storeFor(integrationId).contacts.set(record.id, record);
  return record;
}

export class FakeHubspotClient {
  constructor(private readonly integrationId: string) {}

  async getContact(id: string, _properties: string[]): Promise<HubspotContact | null> {
    const store = storeFor(this.integrationId);
    store.reads += 1;
    const found = store.contacts.get(id);
    return found ? { ...found, properties: { ...found.properties } } : null;
  }

  async findContactByEmail(email: string, _properties: string[]): Promise<HubspotContact | null> {
    const store = storeFor(this.integrationId);
    store.reads += 1;
    for (const contact of store.contacts.values()) {
      if ((contact.properties.email ?? '').toLowerCase() === email.toLowerCase()) {
        return { ...contact, properties: { ...contact.properties } };
      }
    }
    return null;
  }

  async createContact(properties: HubspotProperties): Promise<HubspotContact> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    const contact: HubspotContact = {
      id: `hs-${randomUUID()}`,
      properties: { ...properties },
      updatedAt: new Date().toISOString(),
    };
    store.contacts.set(contact.id, contact);
    return { ...contact, properties: { ...contact.properties } };
  }

  async updateContact(id: string, properties: HubspotProperties): Promise<HubspotContact> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    const existing = store.contacts.get(id);
    const contact: HubspotContact = {
      id,
      properties: { ...(existing?.properties ?? {}), ...properties },
      updatedAt: new Date().toISOString(),
    };
    store.contacts.set(id, contact);
    return { ...contact, properties: { ...contact.properties } };
  }

  async upsertContactByEmail(
    email: string,
    properties: HubspotProperties,
    readProperties: string[],
  ): Promise<{ contact: HubspotContact; created: boolean }> {
    const existing = await this.findContactByEmail(email, readProperties);
    if (existing) {
      return { contact: await this.updateContact(existing.id, properties), created: false };
    }
    return { contact: await this.createContact({ ...properties, email }), created: true };
  }

  async listModifiedSince(
    since: Date,
    _properties: string[],
    _options?: { pageSize?: number; maxPages?: number },
  ): Promise<HubspotContact[]> {
    const store = storeFor(this.integrationId);
    return [...store.contacts.values()]
      .filter((contact) => !contact.updatedAt || new Date(contact.updatedAt) >= since)
      .map((contact) => ({ ...contact, properties: { ...contact.properties } }));
  }
}

export function fakeHubspotClientFor(integrationId: string): FakeHubspotClient {
  return new FakeHubspotClient(integrationId);
}
