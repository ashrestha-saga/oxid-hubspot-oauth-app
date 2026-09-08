import { Client } from '@hubspot/api-client';
import { ExternalApiError } from '../lib/errors';
import { logger } from '../lib/logger';
import { getValidAccessTokenForIntegrationId } from './tokenService';

export interface HubspotContact {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string | null;
}

export interface HubspotCompany {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string | null;
}

export interface HubspotDeal {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string | null;
}

export interface HubspotLineItem {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string | null;
}

export type HubspotProperties = Record<string, string | null>;

interface SearchResponse {
  total?: number;
  results?: Array<{ id: string; properties?: HubspotProperties; updatedAt?: string }>;
  paging?: { next?: { after?: string } };
}

/**
 * One SDK client per integration, kept alive so its Bottleneck limiter actually
 * limits: HubSpot's cap is per portal (100 requests / 10s for OAuth apps), so a
 * shared client would let one busy tenant eat another tenant's budget.
 */
const clients = new Map<string, Client>();

function clientFor(integrationId: string, accessToken: string): Client {
  let client = clients.get(integrationId);
  if (!client) {
    client = new Client({
      numberOfApiCallRetries: 2,
      limiterOptions: { maxConcurrent: 4, minTime: 120, reservoir: 90, id: integrationId },
    });
    clients.set(integrationId, client);
  }
  client.setAccessToken(accessToken);
  return client;
}

function contactFrom(raw: {
  id: string;
  properties?: HubspotProperties;
  updatedAt?: string;
}): HubspotContact {
  return {
    id: String(raw.id),
    properties: raw.properties ?? {},
    updatedAt: raw.updatedAt ?? null,
  };
}

function companyFrom(raw: {
  id: string;
  properties?: HubspotProperties;
  updatedAt?: string;
}): HubspotCompany {
  return {
    id: String(raw.id),
    properties: raw.properties ?? {},
    updatedAt: raw.updatedAt ?? null,
  };
}

function dealFrom(raw: {
  id: string;
  properties?: HubspotProperties;
  updatedAt?: string;
}): HubspotDeal {
  return {
    id: String(raw.id),
    properties: raw.properties ?? {},
    updatedAt: raw.updatedAt ?? null,
  };
}

function lineItemFrom(raw: {
  id: string;
  properties?: HubspotProperties;
  updatedAt?: string;
}): HubspotLineItem {
  return {
    id: String(raw.id),
    properties: raw.properties ?? {},
    updatedAt: raw.updatedAt ?? null,
  };
}

/** HubSpot-defined association type ids used on deal / line item creates. */
const ASSOC_DEAL_TO_CONTACT = 3;
const ASSOC_DEAL_TO_COMPANY = 5;
const ASSOC_LINE_ITEM_TO_DEAL = 20;

/** HubSpot signals "already exists" with a 409 that carries the winning id. */
function existingIdFromConflict(body: string): string | null {
  const match = /Existing ID:\s*(\d+)/i.exec(body);
  return match ? (match[1] as string) : null;
}

export class HubspotClient {
  constructor(private readonly integrationId: string) {}

  private async request<T>(
    options: { method: string; path: string; body?: unknown; qs?: Record<string, string> },
    allowStatuses: number[] = [],
  ): Promise<{ status: number; body: T | null; text: string }> {
    const { accessToken } = await getValidAccessTokenForIntegrationId(this.integrationId);
    const client = clientFor(this.integrationId, accessToken);

    const response = await client.apiRequest({
      method: options.method,
      path: options.path,
      ...(options.body ? { body: options.body } : {}),
      ...(options.qs ? { qs: options.qs } : {}),
    });

    const text = await response.text();
    if (!response.ok && !allowStatuses.includes(response.status)) {
      throw new ExternalApiError(`HubSpot ${options.method} ${options.path} failed`, {
        system: 'hubspot',
        status: response.status,
        details: text.slice(0, 1000),
      });
    }

    return {
      status: response.status,
      body: text ? (JSON.parse(text) as T) : null,
      text,
    };
  }

  async getContact(id: string, properties: string[]): Promise<HubspotContact | null> {
    const { status, body } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>(
      {
        method: 'GET',
        path: `/crm/v3/objects/contacts/${encodeURIComponent(id)}`,
        qs: { properties: properties.join(',') },
      },
      [404],
    );

    if (status === 404 || !body) return null;
    return contactFrom(body);
  }

  async findContactByEmail(email: string, properties: string[]): Promise<HubspotContact | null> {
    const { body } = await this.request<SearchResponse>({
      method: 'POST',
      path: '/crm/v3/objects/contacts/search',
      body: {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties,
        limit: 1,
      },
    });

    const first = body?.results?.[0];
    return first ? contactFrom(first) : null;
  }

  async createContact(properties: HubspotProperties): Promise<HubspotContact> {
    const { status, body, text } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>({ method: 'POST', path: '/crm/v3/objects/contacts', body: { properties } }, [409]);

    if (status === 409) {
      const existingId = existingIdFromConflict(text);
      if (!existingId) {
        throw new ExternalApiError('HubSpot rejected contact create as duplicate', {
          system: 'hubspot',
          status: 409,
          details: text.slice(0, 1000),
        });
      }
      logger.debug({ existingId }, 'contact already existed, updating instead');
      return this.updateContact(existingId, properties);
    }

    return contactFrom(body as { id: string; properties?: HubspotProperties });
  }

  async updateContact(id: string, properties: HubspotProperties): Promise<HubspotContact> {
    const { body } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>({
      method: 'PATCH',
      path: `/crm/v3/objects/contacts/${encodeURIComponent(id)}`,
      body: { properties },
    });

    return contactFrom(body as { id: string; properties?: HubspotProperties });
  }

  /**
   * Create-or-update keyed on email.
   *
   * Deliberately search-then-write rather than `batch/upsert` with
   * `idProperty: email`: HubSpot does not support partial upserts keyed on
   * email, and we only ever write the handful of mapped fields, so every write
   * here is partial by definition.
   */
  async upsertContactByEmail(
    email: string,
    properties: HubspotProperties,
    readProperties: string[],
  ): Promise<{ contact: HubspotContact; created: boolean }> {
    const existing = await this.findContactByEmail(email, readProperties);
    if (existing) {
      return { contact: await this.updateContact(existing.id, properties), created: false };
    }
    return {
      contact: await this.createContact({ ...properties, email }),
      created: true,
    };
  }

  /** Contacts whose `lastmodifieddate` is at or after `since`, oldest first. */
  async listModifiedSince(
    since: Date,
    properties: string[],
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<HubspotContact[]> {
    const pageSize = options.pageSize ?? 100;
    const maxPages = options.maxPages ?? 20;
    const contacts: HubspotContact[] = [];
    let after: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const { body } = await this.request<SearchResponse>({
        method: 'POST',
        path: '/crm/v3/objects/contacts/search',
        body: {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'lastmodifieddate',
                  operator: 'GTE',
                  value: String(since.getTime()),
                },
              ],
            },
          ],
          sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
          properties,
          limit: pageSize,
          ...(after ? { after } : {}),
        },
      });

      for (const result of body?.results ?? []) contacts.push(contactFrom(result));

      after = body?.paging?.next?.after;
      if (!after) break;
    }

    return contacts;
  }

  /** Contact property definitions for the mapping wizard. */
  async listContactProperties(): Promise<
    Array<{ name: string; label: string; type: string; modificationMetadata?: unknown }>
  > {
    const { body } = await this.request<{
      results?: Array<{
        name: string;
        label: string;
        type: string;
        modificationMetadata?: { readOnlyValue?: boolean };
      }>;
    }>({
      method: 'GET',
      path: '/crm/v3/properties/contacts',
    });

    return (body?.results ?? [])
      .filter((property) => !property.modificationMetadata?.readOnlyValue)
      .map((property) => ({
        name: property.name,
        label: property.label,
        type: property.type,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async getCompany(id: string, properties: string[]): Promise<HubspotCompany | null> {
    const { status, body } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>(
      {
        method: 'GET',
        path: `/crm/v3/objects/companies/${encodeURIComponent(id)}`,
        qs: { properties: properties.join(',') },
      },
      [404],
    );

    if (status === 404 || !body) return null;
    return companyFrom(body);
  }

  async findCompanyByName(name: string, properties: string[]): Promise<HubspotCompany | null> {
    const { body } = await this.request<SearchResponse>({
      method: 'POST',
      path: '/crm/v3/objects/companies/search',
      body: {
        filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }],
        properties,
        limit: 1,
      },
    });

    const first = body?.results?.[0];
    return first ? companyFrom(first) : null;
  }

  async createCompany(properties: HubspotProperties): Promise<HubspotCompany> {
    const { status, body, text } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>({ method: 'POST', path: '/crm/v3/objects/companies', body: { properties } }, [409]);

    if (status === 409) {
      const existingId = existingIdFromConflict(text);
      if (!existingId) {
        throw new ExternalApiError('HubSpot rejected company create as duplicate', {
          system: 'hubspot',
          status: 409,
          details: text.slice(0, 1000),
        });
      }
      logger.debug({ existingId }, 'company already existed, updating instead');
      return this.updateCompany(existingId, properties);
    }

    return companyFrom(body as { id: string; properties?: HubspotProperties });
  }

  async updateCompany(id: string, properties: HubspotProperties): Promise<HubspotCompany> {
    const { body } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>({
      method: 'PATCH',
      path: `/crm/v3/objects/companies/${encodeURIComponent(id)}`,
      body: { properties },
    });

    return companyFrom(body as { id: string; properties?: HubspotProperties });
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

  /**
   * Ensures the default HubSpot association between a contact and a company.
   * Idempotent — HubSpot accepts re-associating the same pair.
   */
  async associateContactToCompany(contactId: string, companyId: string): Promise<void> {
    await this.request({
      method: 'PUT',
      path: `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
    });
  }

  async createDeal(
    properties: HubspotProperties,
    associations: { contactId: string; companyId?: string | null },
  ): Promise<HubspotDeal> {
    const associationPayload: Array<{
      to: { id: string };
      types: Array<{ associationCategory: string; associationTypeId: number }>;
    }> = [
      {
        to: { id: associations.contactId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: ASSOC_DEAL_TO_CONTACT,
          },
        ],
      },
    ];

    if (associations.companyId) {
      associationPayload.push({
        to: { id: associations.companyId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: ASSOC_DEAL_TO_COMPANY,
          },
        ],
      });
    }

    const { body } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>({
      method: 'POST',
      path: '/crm/v3/objects/deals',
      body: { properties, associations: associationPayload },
    });

    return dealFrom(body as { id: string; properties?: HubspotProperties });
  }

  async createLineItem(properties: HubspotProperties, dealId: string): Promise<HubspotLineItem> {
    const { body } = await this.request<{
      id: string;
      properties?: HubspotProperties;
      updatedAt?: string;
    }>({
      method: 'POST',
      path: '/crm/v3/objects/line_items',
      body: {
        properties,
        associations: [
          {
            to: { id: dealId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: ASSOC_LINE_ITEM_TO_DEAL,
              },
            ],
          },
        ],
      },
    });

    return lineItemFrom(body as { id: string; properties?: HubspotProperties });
  }
}

export function hubspotClientFor(integrationId: string): HubspotClient {
  return new HubspotClient(integrationId);
}

/** Test seam: drops cached SDK clients (and their rate limiters). */
export function resetHubspotClients(): void {
  clients.clear();
}
