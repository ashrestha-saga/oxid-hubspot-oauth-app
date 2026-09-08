import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OxidRawUserRecord } from '../src/oxid/fromOxidUserWebhook';
import {
  canonicalFromOxidUser,
  defaultTenantFieldMap,
  discoverOxidPayloadKeys,
  getByPath,
  parseTenantFieldMap,
  previewMappedContact,
  suggestMapFromKeys,
  toHubspotPropertiesWithMap,
} from '../src/sync/tenantFieldMap';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'user.json'), 'utf8'),
) as { users: OxidRawUserRecord };

describe('tenantFieldMap', () => {
  it('maps the standard user.json fixture like the legacy adapter', () => {
    const mapped = canonicalFromOxidUser(
      fixture.users as unknown as Record<string, unknown>,
      defaultTenantFieldMap(),
    );

    expect(mapped.id).toBe('j.smith02@merzljak.de');
    expect(mapped.fields).toMatchObject({
      email: 'j.smith02@merzljak.de',
      firstName: 'Jane02',
      lastName: 'Smith02',
      phone: '+493012345678',
      company: 'MWV',
      address: 'In der Raste 14',
      city: 'Bonn',
      zip: '53129',
      country: 'a7c40f631fc920687.20179984',
    });
  });

  it('defaults map oxidId blank and oxsal → salutation', () => {
    const map = defaultTenantFieldMap();
    expect(map.fields.find((field) => field.canonical === 'oxidId')).toMatchObject({
      oxidPath: null,
      hubspotProperty: null,
    });
    expect(map.fields.find((field) => field.canonical === 'salutation')).toMatchObject({
      oxidPath: 'oxsal',
      hubspotProperty: 'salutation',
    });

    const mapped = canonicalFromOxidUser(
      {
        oxid: 'c1eec0d427dee923affddeb9c391f670',
        oxusername: 'hi32@gmail.com',
        oxfname: 'hellisho',
        oxlname: 'okays',
        oxsal: 'MR',
        oxcountry: 'Deutschland',
      },
      map,
    );

    expect(mapped.fields).toMatchObject({
      salutation: 'MR',
      country: 'Deutschland',
    });
    expect(mapped.fields).not.toHaveProperty('oxidId');
  });

  it('scrubs stale oxid → oxid_id bindings so HubSpot is never sent oxid_id by default', () => {
    const scrubbed = parseTenantFieldMap(
      JSON.stringify({
        version: 1,
        oxidIdPaths: ['oxusername', 'oxid'],
        fields: [
          {
            canonical: 'email',
            oxidPath: 'oxusername',
            hubspotProperty: 'email',
            transform: 'none',
          },
          {
            canonical: 'oxidId',
            oxidPath: 'oxid',
            hubspotProperty: 'oxid_id',
            transform: 'none',
          },
        ],
      }),
    );
    expect(scrubbed.fields.find((field) => field.canonical === 'oxidId')).toMatchObject({
      oxidPath: null,
      hubspotProperty: null,
    });
    expect(
      toHubspotPropertiesWithMap(
        { email: 'a@b.de', oxidId: 'abc' },
        scrubbed,
      ),
    ).not.toHaveProperty('oxid_id');
  });

  it('does not suggest oxid for HubSpot mapping', () => {
    const { keys } = discoverOxidPayloadKeys({
      users: {
        oxid: 'abc',
        oxusername: 'hi32@gmail.com',
        oxsal: 'MRS',
        salutation: { id: 'MRS', title: 'Frau', title_1: 'Mrs' },
        oxcountry: { oxtitle: 'Deutschland', oxisoalpha2: 'DE' },
        oxstreet: 'In der Raste',
      },
    });
    const suggested = suggestMapFromKeys(keys);
    expect(suggested.fields.find((field) => field.canonical === 'oxidId')?.oxidPath).toBeNull();
    expect(suggested.fields.find((field) => field.canonical === 'salutation')?.oxidPath).toBe(
      'salutation.title_1',
    );
    expect(suggested.fields.find((field) => field.canonical === 'country')?.oxidPath).toBe(
      'oxcountry.oxtitle',
    );
  });

  it('maps the new oxaddress + nested country/salutation payload', () => {
    const mapped = canonicalFromOxidUser(
      {
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
        oxcountry: { oxtitle: 'Deutschland', oxisoalpha2: 'DE' },
        oxaddress: [{ oxfon: '0228-1234', oxcompany: 'Company AG' }],
      },
      defaultTenantFieldMap(),
    );

    expect(mapped.fields).toMatchObject({
      email: 'r.victor01@merzljak.de',
      salutation: 'Mrs',
      country: 'Deutschland',
      address: 'In der Raste 14',
      phone: '02281234',
      company: 'Company AG',
    });
  });

  it('discovers only needful keys from a full shop webhook sample', () => {
    const { keys } = discoverOxidPayloadKeys({
      users: {
        oxid: 'abc',
        oxusername: 'hi32@gmail.com',
        oxsal: 'MR',
        oxrights: 'user',
        oxboni: '1000',
        oxstreet: 'Hirschberger',
      },
    });
    const paths = keys.map((key) => key.path);
    expect(paths).toContain('oxid');
    expect(paths).toContain('oxusername');
    expect(paths).toContain('oxsal');
    expect(paths).toContain('oxstreet');
    expect(paths).not.toContain('oxrights');
    expect(paths).not.toContain('oxboni');
  });

  it('discovers dotted keys from a nested OXID sample', () => {
    const { keys } = discoverOxidPayloadKeys(fixture);
    const paths = keys.map((key) => key.path);
    expect(paths).toContain('oxusername');
    expect(paths).toContain('oxfname');
    expect(paths).toContain('child_ids.0.oxfon');
  });

  it('supports a custom oxidPath for a different property name', () => {
    const map = defaultTenantFieldMap();
    map.fields = map.fields.map((field) =>
      field.canonical === 'email'
        ? { ...field, oxidPath: 'custom_email', transform: 'none' }
        : field,
    );

    const mapped = canonicalFromOxidUser(
      {
        oxusername: 'custom@example.com',
        custom_email: 'custom@example.com',
        oxfname: 'Ada',
      },
      map,
    );

    expect(mapped.id).toBe('custom@example.com');
    expect(mapped.fields.email).toBe('custom@example.com');
    expect(mapped.fields.firstName).toBe('Ada');
  });

  it('suggests a map from discovered keys', () => {
    const { keys } = discoverOxidPayloadKeys(fixture);
    const suggested = suggestMapFromKeys(keys);
    const email = suggested.fields.find((field) => field.canonical === 'email');
    expect(email?.oxidPath).toBe('oxusername');
    expect(suggested.oxidIdPaths).toContain('oxusername');
    expect(suggested.oxidIdPaths).toContain('oxid');
  });

  it('keeps email as the sync record id even when oxid is in oxidIdPaths', () => {
    const map = defaultTenantFieldMap();
    expect(map.oxidIdPaths).toContain('oxid');
    const mapped = canonicalFromOxidUser(
      fixture.users as unknown as Record<string, unknown>,
      map,
    );
    expect(mapped.id).toBe('j.smith02@merzljak.de');
  });

  it('previews HubSpot properties for a sample + map', () => {
    const preview = previewMappedContact(fixture, defaultTenantFieldMap());
    expect(preview.id).toBe('j.smith02@merzljak.de');
    expect(preview.hubspotProperties.email).toBe('j.smith02@merzljak.de');
    expect(preview.hubspotProperties.firstname).toBe('Jane02');
  });

  it('getByPath reads nested array indexes', () => {
    expect(getByPath(fixture.users, 'child_ids.0.oxcity')).toBe('Berlin');
  });

  it('parseTenantFieldMap falls back to defaults for garbage JSON', () => {
    expect(parseTenantFieldMap('not-json').version).toBe(1);
    expect(parseTenantFieldMap(null).fields).toHaveLength(11);
  });
});
