import { env } from '../config/env';
import { BadRequestError } from '../lib/errors';

/**
 * Turns whatever the merchant typed into the shop's base URL.
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

/** HubSpot "Connected apps" page for the portal that just installed this integration. */
export function hubspotInstalledAppUrl(portalId: string): string {
  const base = `https://app.hubspot.com/integrations-settings/${portalId}/installed`;
  const appId = env.HUBSPOT_APP_ID?.trim();
  return appId ? `${base}/${appId}` : base;
}
