import { randomBytes } from 'node:crypto';

// Deterministic, self-contained environment so unit tests never depend on a
// developer's local .env or reach a real HubSpot/OXID/Postgres instance.
const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: '3000',
  BASE_URL: 'https://backend.test',
  DATABASE_URL: 'file:./test.db',
  HUBSPOT_CLIENT_ID: 'test-client-id',
  HUBSPOT_CLIENT_SECRET: 'test-client-secret',
  HUBSPOT_REDIRECT_URI: 'https://backend.test/oauth/callback',
  HUBSPOT_SCOPES: 'crm.objects.contacts.read,crm.objects.contacts.write,oauth',
  HUBSPOT_APP_ID: '1234567',
  HUBSPOT_DEVELOPER_API_KEY: 'test-developer-api-key',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SIGNING_KEY: randomBytes(32).toString('base64'),
  OXID_CLIENT_MODE: 'stub',
  RECONCILE_INTERVAL_MINUTES: '15',
  RUN_WORKER_IN_WEB: 'false',
};

// Assigned unconditionally: an ambient value from the developer's shell, a local
// .env, or Vite's own `BASE_URL=/` would otherwise change what the tests assert.
for (const [name, value] of Object.entries(testEnv)) {
  process.env[name] = value;
}
