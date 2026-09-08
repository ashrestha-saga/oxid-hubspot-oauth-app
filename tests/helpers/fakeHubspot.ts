import { randomUUID } from 'node:crypto';
import type {
  HubspotCompany,
  HubspotContact,
  HubspotDeal,
  HubspotLineItem,
  HubspotProperties,
} from '../../src/hubspot/client';

/**
 * In-memory HubSpot CRM. Counts writes so tests can prove that a suppressed
 * loop really performed no write rather than just reporting one.
 */
interface Store {
  contacts: Map<string, HubspotContact>;
  companies: Map<string, HubspotCompany>;
  deals: Map<string, HubspotDeal>;
  lineItems: Map<string, HubspotLineItem>;
  /** `${fromId}:${toId}` pairs. */
  associations: Set<string>;
  writes: number;
  reads: number;
}

const stores = new Map<string, Store>();

function storeFor(integrationId: string): Store {
  let store = stores.get(integrationId);
  if (!store) {
    store = {
      contacts: new Map(),
      companies: new Map(),
      deals: new Map(),
      lineItems: new Map(),
      associations: new Set(),
      writes: 0,
      reads: 0,
    };
    stores.set(integrationId, store);
  }
  return store;
}

export function resetFakeHubspot(): void {
  stores.clear();
}

export function fakeHubspotStore(integrationId: string): {
  contacts: HubspotContact[];
  companies: HubspotCompany[];
  deals: HubspotDeal[];
  lineItems: HubspotLineItem[];
  associations: string[];
  writes: number;
  reads: number;
} {
  const store = storeFor(integrationId);
  return {
    contacts: [...store.contacts.values()].map((contact) => ({ ...contact })),
    companies: [...store.companies.values()].map((company) => ({ ...company })),
    deals: [...store.deals.values()].map((deal) => ({ ...deal })),
    lineItems: [...store.lineItems.values()].map((item) => ({ ...item })),
    associations: [...store.associations],
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

export function seedFakeHubspotCompany(
  integrationId: string,
  company: { id?: string; properties: HubspotProperties },
): HubspotCompany {
  const record: HubspotCompany = {
    id: company.id ?? `hs-co-${randomUUID()}`,
    properties: { ...company.properties },
    updatedAt: new Date().toISOString(),
  };
  storeFor(integrationId).companies.set(record.id, record);
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

  async getCompany(id: string, _properties: string[]): Promise<HubspotCompany | null> {
    const store = storeFor(this.integrationId);
    store.reads += 1;
    const found = store.companies.get(id);
    return found ? { ...found, properties: { ...found.properties } } : null;
  }

  async findCompanyByName(name: string, _properties: string[]): Promise<HubspotCompany | null> {
    const store = storeFor(this.integrationId);
    store.reads += 1;
    const needle = name.trim().toLowerCase();
    for (const company of store.companies.values()) {
      if ((company.properties.name ?? '').trim().toLowerCase() === needle) {
        return { ...company, properties: { ...company.properties } };
      }
    }
    return null;
  }

  async createCompany(properties: HubspotProperties): Promise<HubspotCompany> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    const company: HubspotCompany = {
      id: `hs-co-${randomUUID()}`,
      properties: { ...properties },
      updatedAt: new Date().toISOString(),
    };
    store.companies.set(company.id, company);
    return { ...company, properties: { ...company.properties } };
  }

  async updateCompany(id: string, properties: HubspotProperties): Promise<HubspotCompany> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    const existing = store.companies.get(id);
    const company: HubspotCompany = {
      id,
      properties: { ...(existing?.properties ?? {}), ...properties },
      updatedAt: new Date().toISOString(),
    };
    store.companies.set(id, company);
    return { ...company, properties: { ...company.properties } };
  }

  async upsertCompanyByName(
    name: string,
    properties: HubspotProperties,
    readProperties: string[],
  ): Promise<{ company: HubspotCompany; created: boolean }> {
    const existing = await this.findCompanyByName(name, readProperties);
    if (existing) {
      return { company: await this.updateCompany(existing.id, properties), created: false };
    }
    return {
      company: await this.createCompany({ ...properties, name }),
      created: true,
    };
  }

  async associateContactToCompany(contactId: string, companyId: string): Promise<void> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    store.associations.add(`${contactId}:${companyId}`);
  }

  async createDeal(
    properties: HubspotProperties,
    associations: { contactId: string; companyId?: string | null },
  ): Promise<HubspotDeal> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    const deal: HubspotDeal = {
      id: `hs-deal-${randomUUID()}`,
      properties: { ...properties },
      updatedAt: new Date().toISOString(),
    };
    store.deals.set(deal.id, deal);
    store.associations.add(`${deal.id}:${associations.contactId}`);
    if (associations.companyId) {
      store.associations.add(`${deal.id}:${associations.companyId}`);
    }
    return { ...deal, properties: { ...deal.properties } };
  }

  async createLineItem(
    properties: HubspotProperties,
    dealId: string,
  ): Promise<HubspotLineItem> {
    const store = storeFor(this.integrationId);
    store.writes += 1;
    const lineItem: HubspotLineItem = {
      id: `hs-li-${randomUUID()}`,
      properties: { ...properties },
      updatedAt: new Date().toISOString(),
    };
    store.lineItems.set(lineItem.id, lineItem);
    store.associations.add(`${lineItem.id}:${dealId}`);
    return { ...lineItem, properties: { ...lineItem.properties } };
  }
}

export function fakeHubspotClientFor(integrationId: string): FakeHubspotClient {
  return new FakeHubspotClient(integrationId);
}
