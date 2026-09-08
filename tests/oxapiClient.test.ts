import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { OxapiClient } from '../src/oxid/adapters/oxapiClient';
import { defaultTenantFieldMap } from '../src/sync/tenantFieldMap';
import type { IntegrationRow } from '../src/db/repositories/integrations';

vi.mock('../src/oxid/tokenService', () => ({
  getValidOxidToken: vi.fn().mockResolvedValue('test-bearer-token'),
}));

vi.mock('../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('OxapiClient.upsertCustomerByEmail', () => {
  const integration = {
    id: 'int-1',
    oxidBaseUrl: 'https://shop.example.com',
  } as IntegrationRow;

  const contact = {
    email: 'hub@example.com',
    firstName: 'Hub',
    lastName: 'Spot',
    phone: '+491234',
  };

  const map = defaultTenantFieldMap();
  let previousInsertPassword: string | undefined;

  beforeEach(() => {
    previousInsertPassword = env.OXID_USER_INSERT_PASSWORD;
    (env as { OXID_USER_INSERT_PASSWORD?: string }).OXID_USER_INSERT_PASSWORD =
      'encrypted-password-payload';
  });

  afterEach(() => {
    (env as { OXID_USER_INSERT_PASSWORD?: string }).OXID_USER_INSERT_PASSWORD =
      previousInsertPassword;
    vi.unstubAllGlobals();
  });

  it('updates an existing user by oxusername', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          status: 'success',
          data: [{ oxid: 'ox-1', oxusername: 'hub@example.com', oxfname: 'Hub', oxlname: 'Spot' }],
          errors: {},
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OxapiClient(integration);
    const result = await client.upsertCustomerByEmail('hub@example.com', contact, map);

    expect(result.id).toBe('ox-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('userapi&fnc=updateUsers');
    expect(init.method ?? 'POST').toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      users: [
        {
          oxusername: 'hub@example.com',
          oxactive: 1,
          oxfname: 'Hub',
          oxlname: 'Spot',
          oxfon: '+491234',
        },
      ],
    });
  });

  it('updates by oxusername even when oxidRecordId is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          status: 'success',
          data: [{ oxid: 'ox-known', oxusername: 'hub@example.com', oxfname: 'Hub' }],
          errors: {},
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OxapiClient(integration);
    const result = await client.upsertCustomerByEmail('hub@example.com', contact, map, {
      oxidRecordId: 'ox-known',
    });

    expect(result.id).toBe('ox-known');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.users[0]).not.toHaveProperty('oxid');
    expect(body.users[0].oxusername).toBe('hub@example.com');
  });

  it('inserts when update returns user not found', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            status: 'success',
            data: [],
            errors: ['User (hub@example.com) not found'],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            status: 'success',
            data: [{ oxid: 'ox-new', oxusername: 'hub@example.com' }],
            errors: {},
          }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OxapiClient(integration);
    const result = await client.upsertCustomerByEmail('hub@example.com', contact, map);

    expect(result.id).toBe('ox-new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method ?? 'POST').toBe('POST');
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method ?? 'POST').toBe('POST');
    const insertBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(insertBody.users[0].password).toBe('encrypted-password-payload');
    expect(insertBody.users[0].oxusername).toBe('hub@example.com');
  });

  it('inserts without password when OXID_USER_INSERT_PASSWORD is unset', async () => {
    (env as { OXID_USER_INSERT_PASSWORD?: string }).OXID_USER_INSERT_PASSWORD = undefined;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ status: 'error', message: 'User not found' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            status: 'success',
            data: [{ oxid: 'ox-new', oxusername: 'hub@example.com' }],
            errors: {},
          }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const client = new OxapiClient(integration);
    const result = await client.upsertCustomerByEmail('hub@example.com', contact, map);

    expect(result.id).toBe('ox-new');
    const insertBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(insertBody.users[0]).not.toHaveProperty('password');
    expect(insertBody.users[0].oxusername).toBe('hub@example.com');
  });
});
