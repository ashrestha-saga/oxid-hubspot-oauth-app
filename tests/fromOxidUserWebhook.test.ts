import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatOxidStreet,
  fromOxidUserWebhook,
  oxidUserRecordId,
  pickNeedfulOxidUser,
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
      id: 'j.smith02@merzljak.de',
      updatedAt: '2026-07-31T17:28:36+02:00',
      fields: {
        email: 'j.smith02@merzljak.de',
        firstName: 'Jane02',
        lastName: 'Smith02',
        salutation: null,
        phone: '+493012345678',
        company: 'MWV',
        address: 'In der Raste 14',
        city: 'Bonn',
        zip: '53129',
        country: 'a7c40f631fc920687.20179984',
      },
    });
  });

  it('maps nested salutation/country objects and oxaddress fallbacks', () => {
    const result = fromOxidUserWebhook({
      oxid: '0400f18a7c9695af0e330bde325abdd6',
      oxusername: 'r.victor01@merzljak.de',
      oxfname: 'John',
      oxlname: 'ADM01',
      oxsal: 'MRS',
      salutation: { id: 'MRS', title: 'Frau', title_1: 'Mrs' },
      oxstreet: 'In der Raste',
      oxstreetnr: '14',
      oxzip: '53129',
      oxcity: 'Bonn',
      oxcountry: {
        oxid: 'a7c40f631fc920687.20179984',
        oxtitle: 'Deutschland',
        oxtitle_1: 'Germany',
        oxisoalpha2: 'DE',
      },
      oxaddress: [
        {
          oxfon: '0228-1234',
          oxcompany: 'Company AG',
        },
      ],
    });

    expect(result.fields).toMatchObject({
      email: 'r.victor01@merzljak.de',
      firstName: 'John',
      lastName: 'ADM01',
      salutation: 'Mrs',
      country: 'Deutschland',
      address: 'In der Raste 14',
      phone: '02281234',
      company: 'Company AG',
    });
    expect(result.fields).not.toHaveProperty('oxidId');
  });

  it('maps oxsal and prefers oxcountry name over oxcountryid', () => {
    const result = fromOxidUserWebhook({
      oxid: 'c1eec0d427dee923affddeb9c391f670',
      oxusername: 'hi32@gmail.com',
      oxfname: 'hellisho',
      oxlname: 'okays',
      oxsal: 'MR',
      oxcountry: 'Deutschland',
      oxcountryid: 'a7c40f631fc920687.20179984',
    });

    expect(result.fields).toMatchObject({
      email: 'hi32@gmail.com',
      firstName: 'hellisho',
      lastName: 'okays',
      salutation: 'MR',
      country: 'Deutschland',
    });
  });

  it('keeps only needful keys from a full shop webhook row', () => {
    const picked = pickNeedfulOxidUser({
      oxid: 'abc',
      oxusername: 'hi32@gmail.com',
      oxfname: 'hellisho',
      oxlname: 'okays',
      oxsal: 'MR',
      oxrights: 'user',
      oxboni: '1000',
      oxpoints: '0',
      oxwronglogins: '0',
      oxstreet: 'Hirschberger',
      oxcountry: 'Deutschland',
      deliveryAddress: [],
    });

    expect(picked).toEqual({
      oxid: 'abc',
      oxusername: 'hi32@gmail.com',
      oxfname: 'hellisho',
      oxlname: 'okays',
      oxsal: 'MR',
      oxstreet: 'Hirschberger',
      oxcountry: 'Deutschland',
      deliveryAddress: [],
    });
    expect(picked).not.toHaveProperty('oxrights');
    expect(picked).not.toHaveProperty('oxboni');
  });

  it('uses normalized email as the record id, ignoring mcustnr and oxid', () => {
    expect(
      oxidUserRecordId({
        oxid: 'internal-oxid-id',
        mcustnr: '66666692',
        oxusername: 'User@Example.com',
      }),
    ).toBe('user@example.com');
  });

  it('returns null when oxusername is missing', () => {
    expect(oxidUserRecordId({ mcustnr: 66666692 })).toBeNull();
  });

  it('picks phone from the user row before child delivery addresses', () => {
    const result = fromOxidUserWebhook({
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
      oxusername: 'a@b.de',
      child_ids: [{ oxfon: '' }, { oxfon: '+49 40 98765432' }],
    });

    expect(result.fields.phone).toBe('+494098765432');
  });

  it('prefers oxtimestamp over oxcreate for updatedAt', () => {
    const result = fromOxidUserWebhook({
      oxusername: 'a@b.de',
      oxcreate: '2026-01-01T00:00:00Z',
      oxtimestamp: '2026-02-01T00:00:00Z',
    });

    expect(result.updatedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('throws when oxusername is missing', () => {
    expect(() => fromOxidUserWebhook({ mcustnr: '1' })).toThrow(/no email \(oxusername\)/);
  });
});

describe('parseOxidWebhook + sourceRecordFromWebhook', () => {
  it('accepts bare { users } payloads like user.json', () => {
    const parsed = parseOxidWebhook(fixture);
    expect(parsed?.format).toBe('bare_users');

    const record = sourceRecordFromWebhook(parsed!);
    expect(record.id).toBe('j.smith02@merzljak.de');
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
    expect(sourceRecordFromWebhook(parsed!).id).toBe('j.smith02@merzljak.de');
  });

  it('accepts users with email only (no mcustnr)', () => {
    const parsed = parseOxidWebhook({
      users: { oxusername: 'only-email@example.com', oxfname: 'Only' },
    });

    expect(parsed?.format).toBe('bare_users');
    expect(sourceRecordFromWebhook(parsed!)).toMatchObject({
      id: 'only-email@example.com',
      fields: { email: 'only-email@example.com', firstName: 'Only' },
    });
  });

  it('still accepts the normalized customer contract keyed by email', () => {
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
      id: 'norm@example.com',
      fields: {
        email: 'norm@example.com',
        firstName: 'Norm',
        lastName: 'Al',
        phone: '030',
      },
    });
  });

  it('returns null for unrelated payloads', () => {
    expect(parseOxidWebhook({ customer: { firstName: 'NoEmail' } })).toBeNull();
    expect(parseOxidWebhook({ users: { oxfname: 'no-email' } })).toBeNull();
  });
});
