import { env } from '../config/env';
import { BadRequestError } from '../lib/errors';

/**
 * Turns whatever the merchant typed into the shop's base URL.
 *
 * Merchants paste all sorts of things ("shop.example.com",
 * "https://shop.example.com/admin/index.php?cl=..."), and this value is later
 * used to build both the pairing redirect and every OXID API call, so it is
 * normalized once here rather than patched up at each call site.
 */
export function normalizeShopUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new BadRequestError('shopUrl is required');

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new BadRequestError('shopUrl is not a valid URL');
  }

  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLocal && env.NODE_ENV !== 'production')) {
    throw new BadRequestError('shopUrl must use https');
  }
  if (!url.hostname.includes('.') && !isLocal) {
    throw new BadRequestError('shopUrl must be a fully qualified host name');
  }

  const path = url.pathname
    .replace(/\/admin\/index\.php\/?$/i, '')
    .replace(/\/admin\/?$/i, '')
    .replace(/\/+$/, '');

  return `${url.origin}${path}`;
}

/** Guards against a pairing token being replayed against a different shop. */
export function sameShopHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

export function buildPairingRedirectUrl(shopBaseUrl: string, token: string): string {
  const url = new URL(`${shopBaseUrl}/admin/index.php`);
  url.searchParams.set('cl', 'hubspot_connect');
  url.searchParams.set('pairing_token', token);
  return url.toString();
}

/** HubSpot "Connected apps" page for the portal that just installed this integration. */
export function hubspotInstalledAppUrl(portalId: string): string {
  const base = `https://app.hubspot.com/integrations-settings/${portalId}/installed`;
  const appId = env.HUBSPOT_APP_ID?.trim();
  return appId ? `${base}/${appId}` : base;
}
