import { oxidBaseUrl, type IntegrationRow } from '../../db/repositories/integrations';
import { ExternalApiError, NotImplementedError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { OxidClient, OxidCustomer, OxidCustomerInput } from '../client';
import { getValidOxidToken } from '../tokenService';

/**
 * Real OXID shop adapter.
 *
 * Transport (auth + request/response handling) is finished; the five operations
 * are intentionally unimplemented until the shop-side API is confirmed - see
 * section 3 of docs/oxid-module-contract.md. Filling them in is the only change
 * needed to go live: nothing outside this file knows how OXID is reached.
 *
 * Each method below documents the assumed call so the shape can be checked
 * against the real API before any code is written.
 */
export class OxapiClient implements OxidClient {
  readonly mode = 'oxapi' as const;

  constructor(private readonly integration: IntegrationRow) {}

  /** Authenticated request helper against the shop, with a fresh bearer token. */
  protected async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = await getValidOxidToken(this.integration.id);
    const url = `${oxidBaseUrl(this.integration)}${path}`;

    const response = await fetch(url, {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ExternalApiError(`OXID ${init.method ?? 'POST'} ${path} failed`, {
        system: 'oxid',
        status: response.status,
        details: text.slice(0, 1000),
      });
    }

    const body = text ? (JSON.parse(text) as T & { errors?: unknown[] }) : ({} as T);

    // GraphQL answers 200 with an `errors` array, so a status check is not enough.
    if (body && typeof body === 'object' && Array.isArray((body as { errors?: unknown[] }).errors)) {
      throw new ExternalApiError(`OXID ${path} returned GraphQL errors`, {
        system: 'oxid',
        status: 200,
        details: (body as { errors?: unknown[] }).errors?.slice(0, 5),
      });
    }

    return body;
  }

  /** Expected: query customer by email, mapped onto {@link OxidCustomer}. */
  async findCustomerByEmail(email: string): Promise<OxidCustomer | null> {
    logger.warn({ email: email.slice(0, 3) + '***' }, 'oxapi adapter not implemented');
    throw new NotImplementedError('OxapiClient.findCustomerByEmail');
  }

  /** Expected: query customer by its `oxid` primary key. */
  async getCustomer(_id: string): Promise<OxidCustomer | null> {
    throw new NotImplementedError('OxapiClient.getCustomer');
  }

  /** Expected: create a customer from email/first name/last name/phone. */
  async createCustomer(_input: OxidCustomerInput): Promise<OxidCustomer> {
    throw new NotImplementedError('OxapiClient.createCustomer');
  }

  /**
   * Expected: update an *arbitrary* existing customer. Note that OXID's standard
   * graphql-storefront only exposes self-service mutations for the logged-in
   * customer, so this most likely needs an admin-scoped API or a REST endpoint
   * on the sync module itself.
   */
  async updateCustomer(_id: string, _input: OxidCustomerInput): Promise<OxidCustomer> {
    throw new NotImplementedError('OxapiClient.updateCustomer');
  }

  /** Expected: customers with `updatedAt`/`oxtimestamp` at or after `since`. */
  async listModifiedSince(_since: Date): Promise<OxidCustomer[]> {
    throw new NotImplementedError('OxapiClient.listModifiedSince');
  }
}
