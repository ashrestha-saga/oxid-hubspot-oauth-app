import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatOxidStreet,
  fromOxidUserWebhook,
  oxidUserRecordId,
  pickOxidField,
  type OxidRawUserRecord,
} from '../src/oxid/fromOxidUserWebhook';
import {
  parseOxidWebhook,
  sourceRecordFromWebhook,
} from '../src/oxid/webhookPayload';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'user.json'), 'utf8'),
) as { users: OxidRawUserRecord };

describe('fromOxidUserWebhook', () => {
  it('maps oxusername/oxfname/oxlname onto canonical contact fields', () => {
    const result = fromOxidUserWebhook(fixture.users);

    expect(result).toEqual({
      id: '66666692',
      updatedAt: '2026-07-31T17:28:36+02:00',
      fields: {
        email: 'j.smith02@merzljak.de',
        firstName: 'Jane02',
        lastName: 'Smith02',
        phone: '+493012345678',
        company: 'MWV',
        address: 'In der Raste 14',
        city: 'Bonn',
        zip: '53129',
        country: 'a7c40f631fc920687.20179984',
      },
    });
  });

  it('prefers oxid over mcustnr as the record id', () => {
    expect(
      oxidUserRecordId({ oxid: 'internal-oxid-id', mcustnr: '66666692' }),
    ).toBe('internal-oxid-id');
  });

  it('uses mcustnr when oxid is absent', () => {
    expect(oxidUserRecordId({ mcustnr: 66666692 })).toBe('66666692');
  });

  it('picks phone from the user row before child delivery addresses', () => {
    const result = fromOxidUserWebhook({
      mcustnr: '1',
      oxusername: 'a@b.de',
      oxfon: '+49 111',
      child_ids: [{ oxfon: '+49 222' }],
    });

    expect(result.fields.phone).toBe('+49111');
  });

  it('maps address fields from the user row and company from a child fallback', () => {
    expect(formatOxidStreet({ oxstreet: 'In der Raste', oxstreetnr: '14' })).toBe(
      'In der Raste 14',
    );

    const user: OxidRawUserRecord = {
      mcustnr: '9',
      oxusername: 'a@b.de',
      oxstreet: 'Main',
      oxstreetnr: '1',
      oxcity: 'Bonn',
      oxzip: '53129',
      child_ids: [{ oxcompany: 'Child GmbH', oxcity: 'Berlin' }],
    };

    expect(pickOxidField(user, (row) => row.oxcity ?? null)).toBe('Bonn');
    expect(fromOxidUserWebhook(user).fields).toMatchObject({
      address: 'Main 1',
      city: 'Bonn',
      zip: '53129',
      company: 'Child GmbH',
    });
  });

  it('falls back to the first child oxfon when the user has no phone', () => {
    const result = fromOxidUserWebhook({
      mcustnr: '2',
      oxusername: 'a@b.de',
      child_ids: [{ oxfon: '' }, { oxfon: '+49 40 98765432' }],
    });

    expect(result.fields.phone).toBe('+494098765432');
  });

  it('prefers oxtimestamp over oxcreate for updatedAt', () => {
    const result = fromOxidUserWebhook({
      mcustnr: '3',
      oxusername: 'a@b.de',
      oxcreate: '2026-01-01T00:00:00Z',
      oxtimestamp: '2026-02-01T00:00:00Z',
    });

    expect(result.updatedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('throws when neither oxid nor mcustnr is present', () => {
    expect(() =>
      fromOxidUserWebhook({ oxusername: 'orphan@example.com' }),
    ).toThrow(/no oxid or mcustnr/);
  });
});

describe('parseOxidWebhook + sourceRecordFromWebhook', () => {
  it('accepts bare { users } payloads like user.json', () => {
    const parsed = parseOxidWebhook(fixture);
    expect(parsed?.format).toBe('bare_users');

    const record = sourceRecordFromWebhook(parsed!);
    expect(record.id).toBe('66666692');
    expect(record.fields.email).toBe('j.smith02@merzljak.de');
    expect(record.deleted).toBe(false);
  });

  it('accepts wrapped raw users with event metadata', () => {
    const parsed = parseOxidWebhook({
      event: 'customer.updated',
      shopId: 'shop-1',
      users: fixture.users,
    });

    expect(parsed?.format).toBe('raw_users');
    expect(sourceRecordFromWebhook(parsed!).id).toBe('66666692');
  });

  it('still accepts the normalized customer contract', () => {
    const parsed = parseOxidWebhook({
      event: 'customer.updated',
      customer: {
        id: 'oxid-1',
        email: 'norm@example.com',
        firstName: 'Norm',
        lastName: 'Al',
        phone: '030',
      },
    });

    expect(parsed?.format).toBe('normalized');
    expect(sourceRecordFromWebhook(parsed!)).toMatchObject({
      id: 'oxid-1',
      fields: {
        email: 'norm@example.com',
        firstName: 'Norm',
        lastName: 'Al',
        phone: '030',
      },
    });
  });

  it('returns null for unrelated payloads', () => {
    expect(parseOxidWebhook({ customer: { email: 'x@y.de' } })).toBeNull();
    expect(parseOxidWebhook({ users: { oxusername: 'no-id@example.com' } })).toBeNull();
  });
});
