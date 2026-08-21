import { describe, expect, it } from 'vitest';
import { buildPairingRedirectUrl, hubspotInstalledAppUrl, normalizeShopUrl, sameShopHost } from '../src/oxid/shopUrl';

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

describe('sameShopHost', () => {
  it('compares hosts case-insensitively and ignores the path', () => {
    expect(sameShopHost('https://Shop.Example.com/admin', 'https://shop.example.com')).toBe(true);
  });

  it('treats a different host or port as different', () => {
    expect(sameShopHost('https://shop.example.com', 'https://evil.example.com')).toBe(false);
    expect(sameShopHost('https://shop.example.com', 'https://shop.example.com:8443')).toBe(false);
  });

  it('is false for unparseable input', () => {
    expect(sameShopHost('not a url', 'https://shop.example.com')).toBe(false);
  });
});

describe('buildPairingRedirectUrl', () => {
  it('points at the module admin controller and carries the token', () => {
    const url = new URL(buildPairingRedirectUrl('https://shop.example.com', 'tok-123'));
    expect(url.origin + url.pathname).toBe('https://shop.example.com/admin/index.php');
    expect(url.searchParams.get('cl')).toBe('hubspot_connect');
    expect(url.searchParams.get('pairing_token')).toBe('tok-123');
  });

  it('keeps a sub-directory installation in the path', () => {
    const url = new URL(buildPairingRedirectUrl('https://example.com/shop', 'tok'));
    expect(url.pathname).toBe('/shop/admin/index.php');
  });
});

describe('hubspotInstalledAppUrl', () => {
  it('points at the portal connected-apps page', () => {
    expect(hubspotInstalledAppUrl('42735556')).toBe(
      'https://app.hubspot.com/integrations-settings/42735556/installed/1234567',
    );
  });
});
