import { describe, expect, it } from 'vitest';
import { hubspotInstalledAppUrl, normalizeShopUrl } from '../src/oxid/shopUrl';

describe('normalizeShopUrl', () => {
  it('keeps a clean base URL as is', () => {
    expect(normalizeShopUrl('https://shop.example.com')).toBe('https://shop.example.com');
  });

  it('adds the scheme when the merchant omits it', () => {
    expect(normalizeShopUrl('shop.example.com')).toBe('https://shop.example.com');
  });

  it('strips trailing slashes, admin paths and query strings', () => {
    for (const input of [
      'https://shop.example.com/',
      'https://shop.example.com/admin',
      'https://shop.example.com/admin/',
      'https://shop.example.com/admin/index.php',
      'https://shop.example.com/admin/index.php?cl=hubspot_connect',
    ]) {
      expect(normalizeShopUrl(input)).toBe('https://shop.example.com');
    }
  });

  it('keeps a sub-directory installation intact', () => {
    expect(normalizeShopUrl('https://example.com/shop/admin')).toBe('https://example.com/shop');
  });

  it('preserves a non-default port', () => {
    expect(normalizeShopUrl('https://shop.example.com:8443/admin')).toBe(
      'https://shop.example.com:8443',
    );
  });

  it('rejects plain http for a public host', () => {
    expect(() => normalizeShopUrl('http://shop.example.com')).toThrow(/https/);
  });

  it('allows http on localhost outside production', () => {
    expect(normalizeShopUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('rejects empty, malformed and non-qualified hosts', () => {
    expect(() => normalizeShopUrl('')).toThrow(/required/);
    expect(() => normalizeShopUrl('   ')).toThrow(/required/);
    expect(() => normalizeShopUrl('https://intranet')).toThrow(/qualified/);
  });
});

describe('hubspotInstalledAppUrl', () => {
  it('points at the portal connected-apps page', () => {
    expect(hubspotInstalledAppUrl('42735556')).toBe(
      'https://app.hubspot.com/integrations-settings/42735556/installed/1234567',
    );
  });
});
