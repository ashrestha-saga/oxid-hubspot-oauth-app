# Testing checklist

Maps every item of the implementation guide's section 11 to the automated test that covers it, plus
the steps that still need a real HubSpot portal, a real OXID shop, or a live Postgres.

Run the automated suite with `npm test` (127 tests, no database or network needed - the repository
layer, the HubSpot CRM API and the OXID shop are all replaced by in-memory fakes).

## Covered automatically

| Guide checklist item | Where |
| --- | --- |
| Token refresh works when forced | `tests/tokenServices.test.ts` - refreshes inside the 5 minute margin, when already expired, persists the new pair encrypted, and collapses a race into a single refresh |
| OXID bearer token is cached and refreshed once expired | `tests/tokenServices.test.ts` - cache hit, refresh inside the margin, single refresh under concurrency |
| OXID OAuth start/callback flow | `tests/routes.test.ts` - "OXID OAuth flow" block |
| Creating a contact in HubSpot creates a customer in OXID with correct field mapping | `tests/syncContact.test.ts` - "HubSpot -> OXID" block |
| Creating a customer in OXID creates a contact in HubSpot with correct field mapping | `tests/syncContact.test.ts` - "OXID -> HubSpot" block, including email matching against an existing contact |
| Editing the same field on the synced side does not loop | `tests/syncContact.test.ts` - "suppresses the echo the destination system sends back" asserts `skipped_loop` *and* a write count that did not move |
| Two separate integrations don't cross-contaminate | `tests/syncContact.test.ts` - "multi-tenant isolation"; `tests/routes.test.ts` - one tenant's signature against another tenant's shop id; `tests/worker.test.ts` - tenant scoping of claimed jobs |
| `/webhooks/oxid/:oxidShopId` rejects wrong/missing signature (401) and unknown shop id (404) | `tests/routes.test.ts` - wrong secret, missing headers, body altered after signing, replayed timestamp, unknown shop, paused tenant (409), payload/URL shop id mismatch |
| Reconciliation picks up changes | `tests/reconcile.test.ts` - queues both sides, skips already-synced content, holds the watermark back when a side fails, overlapping window, overlap guard |

Also covered beyond the guide's list: AES-256-GCM round-trip and tamper detection
(`tests/crypto.test.ts`), signature primitives for both systems (`tests/hmac.test.ts`), hash
equivalence across the two systems (`tests/fieldMap.test.ts`), shop URL normalization
(`tests/shopUrl.test.ts`), session cookie forgery and expiry (`tests/session.test.ts`), and queue
retry/backoff behaviour (`tests/worker.test.ts`).

## Still manual - needs real accounts

These cannot be automated here because they require credentials and a live shop.

### 1. OAuth install completes end-to-end against a real HubSpot test account

```bash
cloudflared tunnel --url http://localhost:3000     # copy the https URL into BASE_URL + HUBSPOT_REDIRECT_URI
npm run prisma:migrate
npm run dev
```

Open `${BASE_URL}/oauth/install`, approve in a test portal. Expect a redirect to `/oxid/connect`.

Verify in the database:

```sql
select id, hubspot_portal_id, status,
       left(hubspot_access_token, 3) as token_prefix,
       hubspot_token_expires_at
from integrations;
```

`status` must be `pending` and `token_prefix` must be `v1:` — if you can read a token, encryption is
not wired up.

Then confirm the token actually works:

```sql
-- force a refresh on the next call
update integrations set hubspot_token_expires_at = now() - interval '1 hour';
```

Trigger any sync (or hit `/oxid/status`) and confirm from the logs that
`refreshing HubSpot access token` appears once and the row's expiry moves forward.

### 2. OXID OAuth connect completes end-to-end

Requires MWV API OAuth enabled on the shop (see [API_DOCUMENTATION.md](../../API_DOCUMENTATION.md)).

1. Create an OAuth client with redirect URI `${BASE_URL}/oxid/oauth/callback`, scopes `profile address api`, PKCE required.
2. Open `${BASE_URL}/oxid/connect` after HubSpot install.
3. Enter shop URL, client id, and client secret. Complete login on the shop OAuth page.
4. Expect redirect to `/oxid/mapping` and `status = 'active'` in the database with encrypted `oxid_refresh_token`.
5. Copy webhook URL + secret from HubSpot Settings and configure the shop push module.

### 3. Webhook signature rejection against the running server

```bash
curl -i -X POST "$BASE_URL/webhooks/oxid/<oxid_shop_id>" \
  -H 'Content-Type: application/json' \
  -H "X-Oxid-Timestamp: $(($(date +%s) * 1000))" \
  -H 'X-Oxid-Signature: sha256=deadbeef' \
  --data-raw '{"customer":{"id":"c-1","email":"a@b.de"}}'          # expect 401

curl -i -X POST "$BASE_URL/webhooks/oxid/not-a-real-shop" ...       # expect 404
```

The signed happy path is in section 4 of [oxid-module-contract.md](oxid-module-contract.md).

### 4. Contact sync in both directions against real systems

Both directions are exercised against fakes already. Against real systems, the HubSpot side works
today; the OXID side needs `OXID_CLIENT_MODE=oxapi` and the five operations in
[../src/oxid/adapters/oxapiClient.ts](../src/oxid/adapters/oxapiClient.ts) filled in — they throw
`NotImplementedError` until the shop API is confirmed. With `OXID_CLIENT_MODE=stub` the full pipeline
runs and logs exactly what it would have written.

After each test, the audit trail is the fastest way to see what happened:

```sql
select created_at, direction, status, detail
from sync_events
order by created_at desc
limit 20;
```

A healthy loop test shows one `success` followed by `skipped_loop`, never a growing chain of
`success` rows.

### 5. Reconciliation picks up a change made while the backend was offline

Stop the server, edit a contact in HubSpot, start it again, and wait for the interval (set
`RECONCILE_INTERVAL_MINUTES=1` while testing). Expect a `reconcile pass finished` log line with
`queued: 1` and a matching `sync_events` row.
