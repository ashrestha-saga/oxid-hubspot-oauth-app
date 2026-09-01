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

    expect(mapped.id).toBe('66666692');
    expect(mapped.fields).toMatchObject({
      email: 'j.smith02@merzljak.de',
      firstName: 'Jane02',
      lastName: 'Smith02',
      phone: '+493012345678',
      company: 'MWV',
      address: 'In der Raste 14',
      city: 'Bonn',
      zip: '53129',
    });
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
        mcustnr: '1',
        custom_email: 'custom@example.com',
        oxfname: 'Ada',
      },
      map,
    );

    expect(mapped.fields.email).toBe('custom@example.com');
    expect(mapped.fields.firstName).toBe('Ada');
  });

  it('suggests a map from discovered keys', () => {
    const { keys } = discoverOxidPayloadKeys(fixture);
    const suggested = suggestMapFromKeys(keys);
    const email = suggested.fields.find((field) => field.canonical === 'email');
    expect(email?.oxidPath).toBe('oxusername');
  });

  it('previews HubSpot properties for a sample + map', () => {
    const preview = previewMappedContact(fixture, defaultTenantFieldMap());
    expect(preview.id).toBe('66666692');
    expect(preview.hubspotProperties.email).toBe('j.smith02@merzljak.de');
    expect(preview.hubspotProperties.firstname).toBe('Jane02');
  });

  it('getByPath reads nested array indexes', () => {
    expect(getByPath(fixture.users, 'child_ids.0.oxcity')).toBe('Berlin');
  });

  it('parseTenantFieldMap falls back to defaults for garbage JSON', () => {
    expect(parseTenantFieldMap('not-json').version).toBe(1);
    expect(parseTenantFieldMap(null).fields).toHaveLength(9);
  });
});
