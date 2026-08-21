import { describe, expect, it } from 'vitest';
import {
  emailOf,
  fromHubspot,
  fromOxid,
  hubspotReadProperties,
  normalizeValue,
  toHubspotProperties,
  toOxidInput,
} from '../src/sync/fieldMap';
import { contactHash } from '../src/sync/hash';

describe('field mapping', () => {
  it('maps a HubSpot contact onto canonical fields', () => {
    expect(
      fromHubspot({
        id: 'hs-1',
        properties: {
          email: 'A.User@Example.COM',
          firstname: ' Anna ',
          lastname: 'Beispiel',
          phone: '',
        },
        updatedAt: null,
      }),
    ).toEqual({
      email: 'a.user@example.com',
      firstName: 'Anna',
      lastName: 'Beispiel',
      phone: null,
      company: null,
      address: null,
      city: null,
      zip: null,
      country: null,
    });
  });

  it('maps an OXID customer onto canonical fields', () => {
    expect(
      fromOxid({
        id: 'oxid-1',
        email: 'kunde@example.com',
        firstName: 'Bert',
        lastName: null,
        phone: '030 111',
        updatedAt: null,
      }),
    ).toEqual({
      email: 'kunde@example.com',
      firstName: 'Bert',
      lastName: null,
      phone: '030111',
      company: null,
      address: null,
      city: null,
      zip: null,
      country: null,
    });
  });

  it('writes HubSpot properties with empty strings, which is how HubSpot clears a value', () => {
    expect(toHubspotProperties({ email: 'x@example.com', firstName: null })).toEqual({
      email: 'x@example.com',
      firstname: '',
    });
  });

  it('omits fields the source did not report at all', () => {
    expect(toHubspotProperties({ email: 'x@example.com' })).toEqual({ email: 'x@example.com' });
    expect(toOxidInput({ email: 'x@example.com' })).toEqual({ email: 'x@example.com' });
  });

  it('writes OXID input with nulls', () => {
    expect(toOxidInput({ email: 'x@example.com', phone: null })).toEqual({
      email: 'x@example.com',
      phone: null,
    });
  });

  it('requests every mapped property plus lastmodifieddate from HubSpot', () => {
    expect(hubspotReadProperties).toContain('email');
    expect(hubspotReadProperties).toContain('firstname');
    expect(hubspotReadProperties).toContain('lastname');
    expect(hubspotReadProperties).toContain('phone');
    expect(hubspotReadProperties).toContain('company');
    expect(hubspotReadProperties).toContain('address');
    expect(hubspotReadProperties).toContain('city');
    expect(hubspotReadProperties).toContain('zip');
    expect(hubspotReadProperties).toContain('country');
    expect(hubspotReadProperties).toContain('lastmodifieddate');
    expect(new Set(hubspotReadProperties).size).toBe(hubspotReadProperties.length);
  });

  it('normalizes values consistently', () => {
    expect(normalizeValue('email', ' Foo@Bar.de ')).toBe('foo@bar.de');
    expect(normalizeValue('firstName', '  Anna ')).toBe('Anna');
    expect(normalizeValue('phone', '')).toBeNull();
    expect(normalizeValue('phone', null)).toBeNull();
    expect(normalizeValue('phone', undefined)).toBeNull();
    expect(normalizeValue('phone', '+49 30 12345678')).toBe('+493012345678');
    expect(normalizeValue('phone', '+1 (888) 482-7768 ext 123')).toBe('+18884827768 ext 123');
  });

  it('extracts a normalized email', () => {
    expect(emailOf({ email: ' Mixed@Case.DE ' })).toBe('mixed@case.de');
    expect(emailOf({ email: '   ' })).toBeNull();
    expect(emailOf({})).toBeNull();
  });
});

describe('contact hash', () => {
  it('is stable across calls', () => {
    const contact = { email: 'a@b.de', firstName: 'A', lastName: 'B', phone: '1' };
    expect(contactHash(contact)).toBe(contactHash(contact));
  });

  it('ignores key order', () => {
    expect(contactHash({ email: 'a@b.de', firstName: 'A' })).toBe(
      contactHash({ firstName: 'A', email: 'a@b.de' }),
    );
  });

  it('treats missing, null and empty as the same, since the systems disagree', () => {
    const base = contactHash({ email: 'a@b.de' });
    expect(contactHash({ email: 'a@b.de', phone: null })).toBe(base);
    expect(contactHash({ email: 'a@b.de', phone: '' })).toBe(base);
    expect(contactHash({ email: 'a@b.de', phone: '   ' })).toBe(base);
  });

  it('is insensitive to email case and surrounding whitespace', () => {
    expect(contactHash({ email: 'A@B.de', firstName: ' Anna ' })).toBe(
      contactHash({ email: 'a@b.de', firstName: 'Anna' }),
    );
  });

  it('changes when any mapped value changes', () => {
    const base = contactHash({ email: 'a@b.de', firstName: 'A', lastName: 'B', phone: '1' });
    expect(contactHash({ email: 'a@b.de', firstName: 'A', lastName: 'B', phone: '2' })).not.toBe(
      base,
    );
    expect(contactHash({ email: 'z@b.de', firstName: 'A', lastName: 'B', phone: '1' })).not.toBe(
      base,
    );
  });

  it('produces the same hash from either system for the same person', () => {
    const fromHs = fromHubspot({
      id: 'hs-1',
      properties: { email: 'Kunde@Example.com', firstname: 'Anna', lastname: 'Beispiel', phone: '' },
      updatedAt: null,
    });
    const fromShop = fromOxid({
      id: 'oxid-1',
      email: 'kunde@example.com',
      firstName: 'Anna',
      lastName: 'Beispiel',
      phone: null,
      updatedAt: null,
    });

    expect(contactHash(fromHs)).toBe(contactHash(fromShop));
  });
});
