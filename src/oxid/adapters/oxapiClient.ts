import { env } from '../../config/env';
import { ExternalApiError, IntegrationNotReadyError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { CanonicalContact } from '../../sync/fieldMap';
import type { TenantFieldMap } from '../../sync/tenantFieldMap';
import { oxidBaseUrl, type IntegrationRow } from '../../db/repositories/integrations';
import type { OxidClient, OxidCustomer, OxidCustomerInput } from '../client';
import { getValidOxidToken } from '../tokenService';
import {
  buildOxidUserRecord,
  OxidUserNotFoundError,
  parseUserApiResponse,
  USER_API_INSERT_PATH,
  USER_API_UPDATE_PATH,
  userApiUrl,
  type OxidUserApiResponse,
} from '../userApi';

/**
 * Real OXID shop adapter via MWV User API (`userapi`).
 *
 * HubSpot → OXID: updateUsers prefers `oxid` when known, otherwise `oxusername`.
 * On "user not found", insertUsers always uses `oxusername`.
 */
export class OxapiClient implements OxidClient {
  readonly mode = 'oxapi' as const;

  constructor(private readonly integration: IntegrationRow) {}

  protected async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = await getValidOxidToken(this.integration.id);
    const url = userApiUrl(oxidBaseUrl(this.integration), path);

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
      throw new ExternalApiError(`OXID User API HTTP ${response.status}`, {
        system: 'oxid',
        status: response.status,
        details: text.slice(0, 1000),
      });
    }

    return (text ? JSON.parse(text) : {}) as T;
  }

  async upsertCustomerByEmail(
    email: string,
    contact: CanonicalContact,
    map: TenantFieldMap,
    options?: { oxidRecordId?: string | null },
  ): Promise<OxidCustomer> {
    const userRecord = buildOxidUserRecord(contact, map, email);
    const { oxid: _oxid, ...byEmail } = userRecord;
    const updatePayload = withUpdateIdentity(byEmail, options?.oxidRecordId);

    try {
      return await this.updateUserRecord(updatePayload);
    } catch (error) {
      if (!(error instanceof OxidUserNotFoundError)) throw error;
      logger.info(
        { integrationId: this.integration.id, email: email.slice(0, 3) + '***' },
        'OXID user not found, inserting',
      );
      // insertUsers always identifies by oxusername (new users have no oxid yet).
      return await this.insertUserRecord(byEmail);
    }
  }

  private async updateUserRecord(
    userRecord: Record<string, string | number>,
  ): Promise<OxidCustomer> {
    const requestBody = { users: [userRecord] };
    const body = await this.request<OxidUserApiResponse>(USER_API_UPDATE_PATH, {
      body: requestBody,
    });
    // Temporary debug — compare with Postman updateUsers
    console.log('[OXID updateUsers] request', JSON.stringify(requestBody, null, 2));
    console.log('[OXID updateUsers] response', JSON.stringify(body, null, 2));
    logger.info(
      { integrationId: this.integration.id, fnc: 'updateUsers', request: requestBody, response: body },
      'OXID updateUsers raw result',
    );
    return parseUserApiResponse(body);
  }

  private async insertUserRecord(
    userRecord: Record<string, string | number>,
  ): Promise<OxidCustomer> {
    const encryptedPassword = env.OXID_USER_INSERT_PASSWORD;
    const payload: Record<string, string | number> = { ...userRecord };
    if (encryptedPassword) {
      payload.password = encryptedPassword;
    }

    const requestBody = { users: [payload] };
    const body = await this.request<OxidUserApiResponse>(USER_API_INSERT_PATH, {
      body: requestBody,
    });
    const logSafeBody = {
      users: [{ ...payload, ...(payload.password ? { password: '[redacted]' } : {}) }],
    };
    // Temporary debug — compare with Postman insertUsers
    console.log('[OXID insertUsers] request', JSON.stringify(logSafeBody, null, 2));
    console.log('[OXID insertUsers] response', JSON.stringify(body, null, 2));
    logger.info(
      {
        integrationId: this.integration.id,
        fnc: 'insertUsers',
        request: logSafeBody,
        response: body,
      },
      'OXID insertUsers raw result',
    );
    return parseUserApiResponse(body);
  }

  /** @deprecated Prefer {@link upsertCustomerByEmail}. */
  async findCustomerByEmail(_email: string): Promise<OxidCustomer | null> {
    return null;
  }

  /** @deprecated Prefer {@link upsertCustomerByEmail}. */
  async getCustomer(_id: string): Promise<OxidCustomer | null> {
    return null;
  }

  /** @deprecated Prefer {@link upsertCustomerByEmail}. */
  async createCustomer(input: OxidCustomerInput): Promise<OxidCustomer> {
    const email = input.email?.trim().toLowerCase();
    if (!email) {
      throw new IntegrationNotReadyError('createCustomer requires email');
    }
    const record = buildOxidUserRecord(
      {
        email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
      },
      {
        version: 1,
        oxidIdPaths: ['oxid'],
        fields: [
          { canonical: 'email', oxidPath: 'oxusername', hubspotProperty: 'email', transform: 'none' },
          { canonical: 'firstName', oxidPath: 'oxfname', hubspotProperty: 'firstname', transform: 'none' },
          { canonical: 'lastName', oxidPath: 'oxlname', hubspotProperty: 'lastname', transform: 'none' },
          { canonical: 'phone', oxidPath: 'oxfon', hubspotProperty: 'phone', transform: 'none' },
        ],
      },
      email,
    );
    return this.insertUserRecord(record);
  }

  /** @deprecated Prefer {@link upsertCustomerByEmail}. */
  async updateCustomer(id: string, input: OxidCustomerInput): Promise<OxidCustomer> {
    const email = (input.email ?? id).trim().toLowerCase();
    const record = buildOxidUserRecord(
      {
        email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        phone: input.phone ?? null,
      },
      {
        version: 1,
        oxidIdPaths: ['oxid'],
        fields: [
          { canonical: 'email', oxidPath: 'oxusername', hubspotProperty: 'email', transform: 'none' },
          { canonical: 'firstName', oxidPath: 'oxfname', hubspotProperty: 'firstname', transform: 'none' },
          { canonical: 'lastName', oxidPath: 'oxlname', hubspotProperty: 'lastname', transform: 'none' },
          { canonical: 'phone', oxidPath: 'oxfon', hubspotProperty: 'phone', transform: 'none' },
        ],
      },
      email,
    );
    const { oxid: _oxid, ...byEmail } = record;
    byEmail.oxusername = email;
    // Prefer oxid when the caller passed a real shop id; otherwise oxusername.
    const oxidRecordId = id.includes('@') ? null : id;
    return this.updateUserRecord(withUpdateIdentity(byEmail, oxidRecordId));
  }

  async listModifiedSince(_since: Date): Promise<OxidCustomer[]> {
    return [];
  }
}

/**
 * updateUsers identity: use `oxid` when known, otherwise keep `oxusername`.
 * When updating by oxid, drop oxusername so the API matches on the shop id.
 */
function withUpdateIdentity(
  byEmail: Record<string, string | number>,
  oxidRecordId?: string | null,
): Record<string, string | number> {
  const trimmed = oxidRecordId?.trim();
  if (!trimmed || trimmed.includes('@')) return byEmail;

  const { oxusername: _oxusername, ...rest } = byEmail;
  return { oxid: trimmed, ...rest };
}
