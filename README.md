# HubSpot ↔ OXID contact sync backend

Multi-tenant backend that keeps HubSpot contacts and OXID eShop customers in sync in both
directions. Each merchant installs the HubSpot app via OAuth and then pairs their own OXID shop
self-serve — no manual database work.

Implements [hubspot-oxid-contact-sync-implementation-guide.md](hubspot-oxid-contact-sync-implementation-guide.md).
Contact sync only: no deals, orders, carts, companies or AI features.

- [docs/oxid-module-contract.md](docs/oxid-module-contract.md) — what the PHP module in each shop must do
- [docs/testing-checklist.md](docs/testing-checklist.md) — what is covered by `npm test` and what still needs real accounts

## What is in this repository

The Node/TypeScript backend only. The PHP module that has to be installed in each OXID shop is
**not** in this repository — the contract it must fulfil is specified in
[docs/oxid-module-contract.md](docs/oxid-module-contract.md).

```
prisma/schema.prisma          database schema + migrations
src/config/env.ts             zod-validated environment, fails fast on boot
src/lib/                      crypto (AES-256-GCM), hmac, hashing, logger, cookie sessions
src/db/repositories/          one repository per table, all tenant-scoped
src/hubspot/                  OAuth, token refresh, CRM client, webhook receiver
src/oxid/                     pairing flow, token cache, webhook receiver, OxidClient port
src/sync/                     field map, sync engine, queue worker
src/jobs/reconcile.ts         periodic safety-net reconciliation
scripts/                      one-off operational scripts
tests/                        vitest unit + route tests
```

## Prerequisites

- Node.js 20+
- **No database server required for local dev** — the app uses SQLite (`prisma/dev.db`),
  created automatically by `npm run prisma:migrate`. `DATABASE_URL` is `file:./dev.db` (relative to
  `prisma/schema.prisma`). For production you can switch the Prisma provider to PostgreSQL and point
  `DATABASE_URL` at a hosted instance (Neon, Supabase, Railway).
- A tunnel for local development (`cloudflared tunnel --url http://localhost:3000` or
  `ngrok http 3000`). HubSpot requires a public HTTPS URL for both the OAuth redirect and webhooks.
- A HubSpot developer account with a test portal.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # for the two keys
npm run prisma:migrate
npm run dev
```

`BASE_URL` and `HUBSPOT_REDIRECT_URI` must both point at your public tunnel URL, and
`HUBSPOT_REDIRECT_URI` must be registered verbatim in the HubSpot app's auth settings. The webhook
v3 signature is computed over the full request URI, so a mismatch here shows up as
`401 invalid signature` on every HubSpot webhook.

### HubSpot app configuration (manual, one time)

1. Create an app in the developer account, auth type OAuth.
2. Redirect URL: `${BASE_URL}/oauth/callback`.
3. Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`, `oauth`.
4. Copy client id/secret and the numeric app id into `.env`.
5. Register the webhook subscription (target URL `${BASE_URL}/webhooks/hubspot`, event
   `contact.propertyChange`) either in the developer portal UI or with:

```bash
npm run hubspot:webhooks
```

## Running

```bash
npm run dev          # API + in-process queue worker + reconcile cron
npm run build && npm start
npm run worker       # optional: queue worker as its own process (set RUN_WORKER_IN_WEB=false)
npm test
npm run lint
npm run typecheck
```

## Flow overview

1. Merchant opens `/oauth/install`, approves the app. `/oauth/callback` stores encrypted tokens in
   `integrations` with `status = 'pending'` and issues a signed 30-minute pairing session cookie.
2. Merchant lands on `/oxid/connect`, enters their shop URL. `/oxid/pair/start` mints a single-use
   pairing token and redirects them into their own OXID admin.
3. The OXID module confirms with `/oxid/pair/callback`, which stores the shop credentials and
   returns the shop's webhook signing secret exactly once. `status` becomes `'active'`.
4. Contact changes arrive at `/webhooks/hubspot` or `/webhooks/oxid/:oxidShopId`, are verified,
   enqueued in `sync_jobs`, and processed by the worker through one shared `syncContact()`.
5. Every `RECONCILE_INTERVAL_MINUTES` the reconcile job sweeps both sides for anything the webhooks
   missed.

## Routes

| Route                          | Method | Purpose                                                    |
| ------------------------------ | ------ | ---------------------------------------------------------- |
| `/healthz`                     | GET    | Liveness + database check                                  |
| `/oauth/install`               | GET    | Start HubSpot OAuth                                        |
| `/oauth/callback`              | GET    | Complete OAuth, upsert integration, issue pairing session   |
| `/oxid/connect`                | GET    | Pairing form (stand-in for the HubSpot UI extension)        |
| `/oxid/pair/start`             | POST   | Mint pairing token, return OXID admin redirect URL          |
| `/oxid/pair/callback`          | POST   | OXID module confirms pairing, returns the webhook secret    |
| `/webhooks/hubspot`            | POST   | HubSpot contact change events (signature v3 verified)       |
| `/webhooks/oxid/:oxidShopId`   | POST   | OXID customer change events (HMAC verified)                 |
| `/dev/webhook-credentials`     | GET    | Dev only: fixed OXID webhook URL + signing secret           |
| `/dev/activate`                | POST   | Dev only: auto-pair stub OXID shop for pending integrations |

## Development bypass (OXID → HubSpot without pairing UI)

Set `DEV_BYPASS_PAIRING=true` in `.env` (blocked when `NODE_ENV=production`). After HubSpot OAuth, a fixed stub OXID shop is attached automatically. Use:

```bash
curl https://<tunnel>/dev/webhook-credentials
```

Sign webhooks with the returned `webhook_secret` and POST to `webhook_url`. Defaults: shop id `00000000-0000-0000-0000-000000000001`, secret `dev-webhook-secret-min-16-chars`.

If you OAuth'd before enabling the flag, run `POST /dev/activate` or restart the server.

## Implementation notes worth knowing

Three places where this deliberately differs from the guide:

1. **Loop detection ignores which side wrote last.** An echo always arrives with the *opposite*
   origin of the write that caused it (we write to HubSpot, HubSpot notifies us as `hubspot`), so a
   guard requiring both a matching hash *and* a matching origin never fires and the write bounces
   back. `syncContact()` skips whenever the incoming content hash equals `last_synced_hash`;
   `source_of_last_write` is kept for auditing only. Covered by
   "suppresses the echo the destination system sends back" in `tests/syncContact.test.ts`.
2. **HubSpot writes are search-then-write, not `batch/upsert`.** HubSpot does not support partial
   upserts keyed on `email`, and this integration only ever writes the four mapped fields, so every
   write is partial. `upsertContactByEmail()` searches by email, then creates or patches, handling
   the `409` "already exists" race by following the id in the error.
3. **Webhooks are acknowledged before the sync runs.** Both receivers verify, write a `sync_jobs`
   row and return immediately; the worker does the actual sync with retry and backoff. Otherwise a
   slow destination would cause the sender to retry and multiply the work.

The OXID write path is behind the `OxidClient` interface and currently runs against an in-memory
stub (`OXID_CLIENT_MODE=stub`), which logs every call it would have made. Filling in the five
methods in [src/oxid/adapters/oxapiClient.ts](src/oxid/adapters/oxapiClient.ts) is the only change
needed once the shop API is confirmed — see section 3 of
[docs/oxid-module-contract.md](docs/oxid-module-contract.md).

## Security notes

- All tokens, API keys and webhook secrets are AES-256-GCM encrypted at rest
  (`src/lib/crypto.ts`). Nothing sensitive is ever written in plaintext.
- `/oxid/pair/start` requires the signed pairing session cookie; the portal id is taken from the
  session, never from the request body, so nobody can mint a pairing token for a portal they do not
  control.
- Both webhook routes use raw-body parsers and constant-time signature comparison.
- Webhooks are acknowledged before processing so HubSpot never retries because of slow sync work.
