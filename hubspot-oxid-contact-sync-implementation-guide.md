# Implementation guide: bidirectional contact sync between HubSpot and OXID

**Scope:** a HubSpot public app (OAuth, multi-account) and an external backend that keeps HubSpot contacts and OXID customers in sync in both directions, with a self-serve connection flow so merchants pair their own accounts without any manual database work. No cart automation, no deal logic, no LLM features — contact sync only.

Hand this file to the agent as the spec. Sections are ordered as build phases — implement top to bottom, and don't start a phase until the previous one has a passing manual test.

---

## 0. Goal and non-goals

**Goal:** a small backend service that:
1. Lets multiple HubSpot accounts install the app via OAuth.
2. Lets each merchant self-serve pair their OXID shop to their HubSpot account, from inside the HubSpot app UI — no manual database inserts.
3. Syncs contact create/update events in both directions, without loops or duplicates, across many independent tenants at once.

**Non-goals (explicitly not building yet):**
- Deals, orders, line items, carts
- LLM/AI features
- HubSpot Marketplace listing / public distribution (build as OAuth app installed on a controlled list of accounts, not marketplace-published)
- Company or association sync (contact-only for this pass)
- Per-tenant configurable field mappings (v1 uses one global map for all tenants)

---

## 1. Tech stack

- **Runtime:** Node.js (LTS), TypeScript preferred but plain JS acceptable
- **Framework:** Express (or Fastify)
- **Database:** PostgreSQL
- **ORM:** Prisma or Knex (agent's choice, but pick one and use it consistently — no raw SQL scattered around)
- **Queue (optional, later):** BullMQ + Redis for the reconciliation job at scale — a simple DB-backed cron is fine to start
- **Hosting:** any Node-friendly host (Render, Fly.io, Railway, ECS) — must support long-running processes and outbound HTTPS
- **HubSpot SDK:** `@hubspot/api-client`
- **HubSpot UI extensions:** built with the current HubSpot developer platform's UI extension SDK (React-based, runs inside the HubSpot app)
- **OXID module:** PHP, built against the OXID module/event system, deployed inside each customer's OXID shop
- **HTTP client for OXID (backend side):** `graphql-request` or plain `fetch` against OXAPI (GraphQL)

**Why this shape, in one sentence:** as of the current HubSpot developer platform (2026.03), OAuth-authenticated apps cannot use HubSpot-hosted serverless functions — only privately distributed, static-auth apps can. That's why everything here is an external backend rather than functions living inside the HubSpot project.

---

## 2. Environment variables

Create `.env.example` with these keys (agent should generate this file first):

```
# Server
PORT=3000
BASE_URL=https://your-backend.example.com

# Database
DATABASE_URL=postgres://user:pass@host:5432/dbname

# HubSpot app credentials (from HubSpot developer account)
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=https://your-backend.example.com/oauth/callback
HUBSPOT_SCOPES=crm.objects.contacts.read,crm.objects.contacts.write,oauth

# Encryption for stored tokens/secrets
TOKEN_ENCRYPTION_KEY=   # 32-byte key, base64

# Reconciliation
RECONCILE_INTERVAL_MINUTES=15
```

Never commit `.env`. Add it to `.gitignore` in step 1.

---

## 3. Database schema

Implement as migrations (Prisma schema or SQL migration files — agent's choice).

### 3.1 `integrations` — one row per tenant pairing

```sql
create table integrations (
  id uuid primary key default gen_random_uuid(),
  name text,                                -- human label, filled in once known

  -- HubSpot side
  hubspot_portal_id bigint unique,          -- hub_id, set after OAuth install completes
  hubspot_access_token text,                -- encrypted
  hubspot_refresh_token text,               -- encrypted
  hubspot_token_expires_at timestamptz,

  -- OXID side
  oxid_shop_id text unique,                 -- generated at pairing time (see section 6)
  oxid_base_url text,                       -- e.g. https://shop.client.com
  oxid_api_key text,                        -- encrypted, long-lived credential used to mint bearer tokens
  oxid_access_token text,                   -- encrypted, cached short-lived bearer token
  oxid_token_expires_at timestamptz,
  oxid_webhook_secret text,                 -- encrypted, per-shop HMAC signing secret for the push module

  status text not null default 'pending',   -- pending | active | paused | error
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 3.2 `pairing_requests` — short-lived tokens for the self-serve connect flow

```sql
create table pairing_requests (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  hubspot_portal_id bigint not null,
  oxid_shop_url text not null,
  used boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

### 3.3 `entity_mappings` — one row per synced contact

```sql
create table entity_mappings (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references integrations(id),
  hubspot_contact_id text,
  oxid_customer_id text,
  last_synced_at timestamptz,
  last_synced_hash text,                    -- hash of the last-written field values, for loop detection
  source_of_last_write text,                -- 'hubspot' | 'oxid' — which side triggered the last write
  created_at timestamptz not null default now(),
  unique (integration_id, hubspot_contact_id),
  unique (integration_id, oxid_customer_id)
);
```

### 3.4 `sync_events` — audit/debug log (recommended, not optional)

```sql
create table sync_events (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid references integrations(id),
  direction text not null,                  -- 'hubspot_to_oxid' | 'oxid_to_hubspot'
  entity_mapping_id uuid references entity_mappings(id),
  status text not null,                     -- 'success' | 'error' | 'skipped_loop'
  detail jsonb,
  created_at timestamptz not null default now()
);
```

Index `hubspot_portal_id` and `oxid_shop_id` on `integrations`, `token` on `pairing_requests`, and `integration_id` on both child tables.

---

## 4. Token encryption

Implement a small `crypto.ts` module using AES-256-GCM with `TOKEN_ENCRYPTION_KEY`. Every write to `hubspot_access_token`, `hubspot_refresh_token`, `oxid_api_key`, `oxid_access_token`, `oxid_webhook_secret` goes through `encrypt()`; every read goes through `decrypt()`. Do not store any of these fields in plaintext. Write unit tests for round-trip encrypt/decrypt before wiring it into the rest of the app.

---

## 5. Phase 1 — HubSpot OAuth flow

### 5.1 Register the app
Manual step (not code): in the HubSpot developer account, create a new app, set it to OAuth auth type, add redirect URL `${BASE_URL}/oauth/callback`, and request scopes `crm.objects.contacts.read` and `crm.objects.contacts.write`. Copy client ID/secret into `.env`.

### 5.2 Routes to build

```
GET  /oauth/install          -> redirects to HubSpot's authorization URL
GET  /oauth/callback         -> exchanges ?code for tokens, creates/updates integrations row
```

`/oauth/install`: build the HubSpot authorize URL from `HUBSPOT_CLIENT_ID`, `HUBSPOT_REDIRECT_URI`, `HUBSPOT_SCOPES`, redirect the browser there.

`/oauth/callback`:
1. Read `?code` from query string.
2. POST to HubSpot's token endpoint to exchange for `access_token` + `refresh_token`.
3. Call HubSpot's "get account details" endpoint (or decode the token info) to get `hub_id`.
4. Upsert into `integrations` keyed on `hubspot_portal_id`: store encrypted tokens, expiry, set `status = 'pending'` (still needs OXID pairing — see Phase 3).
5. Redirect to a simple success page or return JSON confirming install.

### 5.3 HubSpot token service

Build `hubspotTokenService.ts` with:

```ts
async function getValidAccessTokenForHub(hubId: string): Promise<{ accessToken: string, integrationId: string }>
```

Logic: look up the integration row, check `hubspot_token_expires_at`. If expired or expiring within 5 minutes, call HubSpot's refresh endpoint with the stored refresh token, update the row, return the fresh token. If not expired, decrypt and return the stored access token.

**Test before moving on:** manually run `/oauth/install`, complete the flow against a HubSpot test account, confirm a row appears in `integrations` with encrypted tokens, and confirm `getValidAccessTokenForHub` returns a working token you can use to hit `GET /crm/v3/objects/contacts` successfully.

---

## 6. Phase 2 — self-serve OXID pairing

This is how a merchant connects their own OXID shop from inside the HubSpot app UI — no manual database work, no copy-pasted credentials between systems.

### 6.1 HubSpot UI extension: the "Connect" button

Build a settings panel (React, HubSpot UI extension SDK) shown inside the installed app:

```jsx
function OxidConnectPanel({ context }) {
  const [shopUrl, setShopUrl] = useState('');
  const [status, setStatus] = useState('not_connected');

  const handleConnect = async () => {
    const res = await fetch(`${BACKEND_URL}/oxid/pair/start`, {
      method: 'POST',
      body: JSON.stringify({ hubId: context.portal.id, shopUrl }),
    });
    const { redirectUrl } = await res.json();
    window.open(redirectUrl, '_blank');
  };

  return (
    <Form>
      <Input label="Your OXID shop admin URL" value={shopUrl} onChange={setShopUrl} />
      <Button onClick={handleConnect}>Connect OXID shop</Button>
      {status === 'connected' && <Alert title="Connected" />}
    </Form>
  );
}
```

### 6.2 Backend route: start pairing

```
POST /oxid/pair/start
```

```javascript
app.post('/oxid/pair/start', async (req, res) => {
  const { hubId, shopUrl } = req.body;
  const token = crypto.randomUUID();

  await db.pairingRequests.create({
    token, hubspotPortalId: hubId, oxidShopUrl: shopUrl,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  const redirectUrl = `${shopUrl}/admin/index.php?cl=hubspot_connect&pairing_token=${token}`;
  res.json({ redirectUrl });
});
```

### 6.3 Custom OXID module: the authorization step

A PHP module installed on each customer's OXID shop. It has one admin page, `hubspot_connect`, that:
1. Reads `pairing_token` from the URL.
2. Shows a simple "Connect this shop to HubSpot?" confirmation, using the merchant's existing OXID admin session as the authentication step (there is no separate OXID login flow to build — this is the login).
3. On confirm, generates or reads an API key for this shop and POSTs to the backend:

```php
$response = $httpClient->post($backendUrl . '/oxid/pair/callback', [
    'pairing_token' => $pairingToken,
    'shop_url'      => $shopBaseUrl,
    'api_key'       => $generatedApiKey,
]);
```

The module also hooks the customer save event to push contact changes later (see Phase 4, section 8.2) — build both pieces of the module together since they share the shop's configuration.

### 6.4 Backend route: confirm pairing

```
POST /oxid/pair/callback
```

```javascript
app.post('/oxid/pair/callback', async (req, res) => {
  const { pairing_token, shop_url, api_key } = req.body;

  const request = await db.pairingRequests.findValidByToken(pairing_token); // not expired, not used
  if (!request) return res.status(400).json({ error: 'invalid or expired token' });

  const oxidShopId = crypto.randomUUID(); // generated here, at pairing time

  await db.integrations.upsert({
    hubspotPortalId: request.hubspotPortalId,
    oxidShopId,
    oxidBaseUrl: shop_url,
    oxidApiKey: encrypt(api_key),
    oxidWebhookSecret: encrypt(crypto.randomBytes(32).toString('hex')),
    status: 'active',
  });
  await db.pairingRequests.markUsed(pairing_token);

  res.json({ status: 'ok', oxidShopId });
});
```

Return the generated `oxid_webhook_secret` (or have the module fetch it right after) so the module can store it locally for signing future webhook events — see section 8.2.

**Test before moving on:** run the full flow against a real (or staging) OXID shop and HubSpot test account. Confirm exactly one `integrations` row exists afterward with both HubSpot and OXID fields populated, and confirm a second pairing attempt with an expired or reused token is rejected.

---

## 7. Phase 3 — OXID bearer token caching

OXID doesn't issue a long-lived refresh token the way HubSpot does — you re-derive a short-lived bearer token from the stored API key whenever needed, and cache it.

```javascript
async function getValidOxidToken(integrationId) {
  const integration = await db.integrations.findById(integrationId);

  const stillValid = integration.oxidAccessToken
    && integration.oxidTokenExpiresAt
    && integration.oxidTokenExpiresAt > new Date(Date.now() + 60 * 1000);

  if (stillValid) return decrypt(integration.oxidAccessToken);

  const res = await fetch(`${integration.oxidBaseUrl}/oxapi/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: decrypt(integration.oxidApiKey),
      grantType: 'client_credentials',
    }),
  });
  const { access_token, expires_in } = await res.json();

  await db.integrations.update(integrationId, {
    oxidAccessToken: encrypt(access_token),
    oxidTokenExpiresAt: new Date(Date.now() + expires_in * 1000),
  });

  return access_token;
}
```

Call this at the top of every function that talks to OXID — mirrors `getValidAccessTokenForHub` on the HubSpot side. If sync volume grows enough that concurrent calls for the same integration both see an expired token at once, wrap the refresh in a short-lived in-memory lock keyed by `integrationId` — not worth building until you actually observe it happening.

---

## 8. Phase 4 — sync engine

### 8.1 Field mapping

Define a single source of truth, e.g. `fieldMap.ts`:

```ts
export const contactFieldMap = [
  { hubspot: 'email',     oxid: 'email',      direction: 'both' },
  { hubspot: 'firstname', oxid: 'firstName',  direction: 'both' },
  { hubspot: 'lastname',  oxid: 'lastName',   direction: 'both' },
  { hubspot: 'phone',     oxid: 'phone',      direction: 'both' },
];
```

Keep this small for v1 — four fields is plenty to prove the pipeline works. Expand later.

### 8.2 OXID → backend: custom module push

The same module from section 6.3 hooks the customer save event and POSTs to the backend, signed with the shop's `oxid_webhook_secret`.

```
POST /webhooks/oxid/:oxidShopId
```

```javascript
router.post('/webhooks/oxid/:oxidShopId', async (req, res) => {
  const integration = await db.integrations.findByOxidShopId(req.params.oxidShopId);
  if (!integration) return res.status(404).end();

  const valid = verifyHmac(req.rawBody, req.get('x-oxid-signature'), decrypt(integration.oxid_webhook_secret));
  if (!valid) return res.status(401).end();

  await syncContact({
    integrationId: integration.id,
    direction: 'oxid_to_hubspot',
    sourceRecord: req.body,
  });
  res.status(200).end();
});
```

Note: configure a raw-body parser for this specific route before JSON parsing — HMAC verification needs the exact bytes sent, not a re-serialized object. Use a constant-time comparison for the signature check.

### 8.3 HubSpot → backend: native webhook

1. Register a HubSpot webhook subscription for `contact.propertyChange` on the app (one-time setup via HubSpot's webhooks settings API or developer portal, not per account).
2. Build:

```
POST /webhooks/hubspot
```

Validates HubSpot's webhook signature, reads `portalId` from the payload, looks up the integration, fetches the full contact via the CRM API (webhook payloads only include the changed property, not the full record), calls `syncContact({ direction: 'hubspot_to_oxid', ... })`.

### 8.4 Core sync function (shared by both directions)

```ts
async function syncContact({
  integrationId,
  direction,           // 'hubspot_to_oxid' | 'oxid_to_hubspot'
  sourceRecord,
}): Promise<void>
```

Steps:
1. Look up (or create) the `entity_mappings` row for this integration + source ID.
2. Compute a hash of the relevant field values from `sourceRecord` (only the fields in `contactFieldMap`).
3. **Loop check:** if `last_synced_hash` equals the new hash AND `source_of_last_write` equals this write's origin, skip — log to `sync_events` as `skipped_loop` and return.
4. Map fields using `contactFieldMap`, write to the destination system (HubSpot contact upsert API using `getValidAccessTokenForHub`, or OXID customer mutation using `getValidOxidToken`).
5. Update `entity_mappings`: new hash, `last_synced_at = now()`, `source_of_last_write` = this write's origin.
6. Log a `sync_events` row with `status = 'success'` or `'error'`.

Both directions call this one function — don't write two parallel implementations. Use email as the natural key for first-sync dedup on both the HubSpot upsert and the OXID upsert; after that, `entity_mappings` is the source of truth.

---

## 9. Phase 5 — reconciliation job

Since OXID sync is push-based, this job is the only polling in the system, and it exists purely as a safety net. Scheduled job (cron-style, every `RECONCILE_INTERVAL_MINUTES`), per active integration:

1. Pulls contacts modified in HubSpot since the last reconciliation run.
2. Pulls customers modified in OXID via OXAPI, filtered by `updatedAt` since the last reconciliation run (add a `last_reconciled_at` column to `integrations`).
3. For anything not already reflected in `entity_mappings` at a recent `last_synced_at`, runs it through `syncContact()`.

Catches anything missed by webhook delivery failures, OXID module errors, or the module being temporarily uninstalled/misconfigured.

---

## 10. Route summary

| Route | Method | Purpose |
|---|---|---|
| `/oauth/install` | GET | Start HubSpot OAuth |
| `/oauth/callback` | GET | Complete HubSpot OAuth, create integration row |
| `/oxid/pair/start` | POST | Merchant clicks Connect in HubSpot UI — generates pairing token, returns OXID redirect URL |
| `/oxid/pair/callback` | POST | OXID module confirms pairing, backend saves the integration row |
| `/webhooks/hubspot` | POST | Receive HubSpot contact change events |
| `/webhooks/oxid/:oxidShopId` | POST | Receive OXID customer change events from the shop's push module, HMAC-verified |

---

## 11. Testing checklist (manual, before calling any phase done)

- [ ] OAuth install completes end-to-end against a real HubSpot test account
- [ ] Token refresh works when forced (manually expire `hubspot_token_expires_at` in DB and confirm refresh happens)
- [ ] Self-serve pairing flow completes end-to-end: click Connect in HubSpot → authorize in OXID admin → integration row created with both sides populated
- [ ] A reused or expired `pairing_token` is rejected by `/oxid/pair/callback`
- [ ] OXID bearer token is cached and reused until `oxid_token_expires_at`, and re-derived automatically once expired
- [ ] Creating a contact in HubSpot creates a customer in OXID with correct field mapping
- [ ] Creating a customer in OXID creates a contact in HubSpot with correct field mapping
- [ ] Editing the same field on the synced side does **not** create an infinite loop (verify via `sync_events` — should see `skipped_loop` entries, not endless `success` entries)
- [ ] Reconciliation job picks up a change made while the backend was offline (stop the server, change a contact, restart, wait for the job)
- [ ] Two separate integrations (two HubSpot accounts, two OXID shops) don't cross-contaminate — a change in tenant A never touches tenant B's records
- [ ] `/webhooks/oxid/:oxidShopId` rejects a request with a wrong or missing signature (`401`) and rejects an unknown `oxidShopId` (`404`) — confirm with a manual `curl` before wiring up the real module

---

## 12. Explicitly deferred to later passes

Do not build these now — flag as future work if the agent's plan drifts toward them:
- Company/association sync
- Deal, order, or cart sync
- Multi-field custom property mapping UI
- Marketplace listing / public app certification
- Per-tenant configurable field mappings
