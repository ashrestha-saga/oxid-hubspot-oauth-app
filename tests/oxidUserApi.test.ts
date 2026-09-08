import { describe, expect, it } from 'vitest';
import { defaultTenantFieldMap } from '../src/sync/tenantFieldMap';
import {
  buildOxidUserRecord,
  isUserNotFoundMessage,
  oxidCustomerFromApiRow,
  OxidUserNotFoundError,
  parseUserApiResponse,
} from '../src/oxid/userApi';

describe('buildOxidUserRecord', () => {
  it('maps canonical fields to OXID user columns with email as oxusername', () => {
    const map = defaultTenantFieldMap();
    const record = buildOxidUserRecord(
      {
        email: 'Jane@Example.com',
        firstName: 'Jane',
        lastName: 'Smith',
        phone: '+49301234',
      },
      map,
      'Jane@Example.com',
    );

    expect(record).toMatchObject({
      oxusername: 'jane@example.com',
      oxfname: 'Jane',
      oxlname: 'Smith',
      oxfon: '+49301234',
      oxactive: 1,
    });
  });

  it('omits empty optional fields', () => {
    const map = defaultTenantFieldMap();
    const record = buildOxidUserRecord({ email: 'a@b.com', lastName: 'Only' }, map, 'a@b.com');

    expect(record.oxusername).toBe('a@b.com');
    expect(record.oxlname).toBe('Only');
    expect(record).not.toHaveProperty('oxfname');
  });

  it('does not send oxid or dotted read-paths on User API writes', () => {
    const map = defaultTenantFieldMap();
    map.fields = map.fields.map((field) =>
      field.canonical === 'phone'
        ? { ...field, oxidPath: 'child_ids.0.oxfon' }
        : field.canonical === 'company'
          ? { ...field, oxidPath: 'oxid' }
          : field,
    );

    const record = buildOxidUserRecord(
      {
        email: 'a@b.com',
        phone: '+49123',
        company: 'Acme',
        firstName: 'A',
      },
      map,
      'a@b.com',
    );

    expect(record).not.toHaveProperty('child_ids.0.oxfon');
    expect(record).not.toHaveProperty('oxid');
    expect(record.oxfname).toBe('A');
  });
});

describe('parseUserApiResponse', () => {
  it('parses a successful user row', () => {
    const customer = parseUserApiResponse({
      status: 'success',
      data: [
        {
          oxid: 'ox-abc',
          oxusername: 'user@example.com',
          oxfname: 'John',
          oxlname: 'Doe',
        },
      ],
      errors: {},
    });

    expect(customer).toMatchObject({
      id: 'ox-abc',
      email: 'user@example.com',
      firstName: 'John',
      lastName: 'Doe',
    });
  });

  it('throws OxidUserNotFoundError when update targets a missing user', () => {
    expect(() =>
      parseUserApiResponse({
        status: 'error',
        message: 'User not found',
      }),
    ).toThrow(OxidUserNotFoundError);
  });

  it('throws OxidUserNotFoundError when shop returns success with empty data and errors', () => {
    expect(() =>
      parseUserApiResponse({
        status: 'success',
        data: [],
        errors: ['User (h.pagmagdola02@merzljak.de) not found'],
      }),
    ).toThrow(OxidUserNotFoundError);
  });

  it('detects user-not-found in error messages', () => {
    expect(isUserNotFoundMessage('User not found')).toBe(true);
    expect(isUserNotFoundMessage('User (a@b.de) not found')).toBe(true);
    expect(isUserNotFoundMessage('Something else')).toBe(false);
  });
});

describe('oxidCustomerFromApiRow', () => {
  it('falls back to oxusername as id when oxid is missing', () => {
    expect(oxidCustomerFromApiRow({ oxusername: 'fallback@example.com' }).id).toBe(
      'fallback@example.com',
    );
  });
});
