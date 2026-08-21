/**
 * Registers (or re-points) the app's contact webhook subscription.
 *
 * Webhook configuration is per app, not per installed account, so this is run
 * once per environment - and again whenever BASE_URL changes, which in local
 * development means every time the tunnel URL changes.
 *
 *   npm run hubspot:webhooks
 */
import { env } from '../src/config/env';

const API = 'https://api.hubapi.com/webhooks/v3';
const EVENT_TYPES = ['contact.propertyChange', 'contact.creation'] as const;
const WATCHED_PROPERTIES = ['email', 'firstname', 'lastname', 'phone'] as const;

function requireConfig(): { appId: string; developerApiKey: string } {
  const { HUBSPOT_APP_ID: appId, HUBSPOT_DEVELOPER_API_KEY: developerApiKey } = env;
  if (!appId || !developerApiKey) {
    throw new Error('HUBSPOT_APP_ID and HUBSPOT_DEVELOPER_API_KEY must be set in .env');
  }
  return { appId, developerApiKey };
}

async function call(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const { developerApiKey } = requireConfig();
  const url = new URL(`${API}${path}`);
  url.searchParams.set('hapikey', developerApiKey);

  const response = await fetch(url, {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function main(): Promise<void> {
  const { appId } = requireConfig();
  const targetUrl = `${env.BASE_URL}/webhooks/hubspot`;

  const settings = await call(`/${appId}/settings`, {
    method: 'PUT',
    body: { targetUrl, throttling: { period: 'SECONDLY', maxConcurrentRequests: 10 } },
  });
  if (settings.status >= 300) {
    throw new Error(`failed to set target URL: ${settings.status} ${JSON.stringify(settings.body)}`);
  }
  process.stdout.write(`target URL set to ${targetUrl}\n`);

  const existing = await call(`/${appId}/subscriptions`, { method: 'GET' });
  const known = new Set(
    ((existing.body as { results?: Array<{ eventType?: string; propertyName?: string }> })
      ?.results ?? []).map((row) => `${row.eventType}:${row.propertyName ?? ''}`),
  );

  for (const eventType of EVENT_TYPES) {
    const properties =
      eventType === 'contact.propertyChange' ? [...WATCHED_PROPERTIES] : [undefined];

    for (const propertyName of properties) {
      const key = `${eventType}:${propertyName ?? ''}`;
      if (known.has(key)) {
        process.stdout.write(`already subscribed: ${key}\n`);
        continue;
      }

      const created = await call(`/${appId}/subscriptions`, {
        method: 'POST',
        body: { eventType, active: true, ...(propertyName ? { propertyName } : {}) },
      });

      if (created.status >= 300) {
        process.stderr.write(`failed ${key}: ${created.status} ${JSON.stringify(created.body)}\n`);
        continue;
      }
      process.stdout.write(`subscribed: ${key}\n`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
