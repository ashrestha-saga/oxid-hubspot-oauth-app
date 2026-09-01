# OXID module contract

This document specifies what the OXID shop-side setup must provide for this backend. The backend
handles HubSpot OAuth and OXID OAuth; the shop module's job is **push webhooks** for customer
changes.

Throughout, `BACKEND_URL` is the public base URL of this service (e.g.
`https://hubspot-sync.example.com`).

See also [API_DOCUMENTATION.md](../../API_DOCUMENTATION.md) for the MWV API OAuth 2.0 endpoints
(`oauthauthorize`, `oauthtoken`, `oauthme`).

---

## 1. OXID OAuth (merchant setup — no custom PHP pairing module)

The merchant connects their shop via **OAuth 2.0 Authorization Code + PKCE** (MWV API v1.5+).

### 1.1 Shop prerequisites

In OXID Admin → Extensions → Modules → API → OAuth 2.0:

1. Enable OAuth (`mwvapi_blMOAuthAPI`).
2. Create an OAuth client (MWV API → OAuth 2.0 Clients):
   - **Redirect URI:** `{BACKEND_URL}/oxid/oauth/callback` (exact match)
   - **Scopes:** `profile address api`
   - **PKCE:** required (`S256`)
3. Copy `client_id` and `client_secret`.

### 1.2 Connect flow

```mermaid
sequenceDiagram
  participant M as Merchant
  participant BE as Backend
  participant OX as OXID OAuth

  M->>BE: HubSpot OAuth install then /oxid/connect
  M->>BE: POST shop URL + client_id + client_secret
  BE->>OX: Redirect oauthauthorize with PKCE
  OX->>M: Login + consent
  OX->>BE: GET /oxid/oauth/callback?code&state
  BE->>OX: POST oauthtoken (exchange code)
  BE->>BE: Store access/refresh tokens, generate webhook secret
  BE->>M: Redirect /oxid/mapping
```

The backend stores encrypted OXID access + refresh tokens and refreshes them automatically. No
`api_key` or `/oxid/pair/callback` is used.

### 1.3 Webhook credentials

After OAuth succeeds, the merchant copies from **HubSpot → Connected apps → OXID HubSpot Sync →
Settings**:

- `webhook_url` — `{BACKEND_URL}/webhooks/oxid/{oxid_shop_id}`
- `webhook_secret` — HMAC signing secret for push events

Configure these in the shop module that sends customer webhooks (section 2).

---

## 2. Push: customer changes

### 2.1 When to fire

Hook the customer save/insert/delete events (`oxcustomer::save`, `::insert`, `::update`, `::delete`,
or the equivalent event subscriber for your OXID version) and fire for:

| Event              | `event` value       |
| ------------------ | ------------------- |
| Customer created   | `customer.created`  |
| Customer updated   | `customer.updated`  |
| Customer deleted   | `customer.deleted`  |

Only fire when at least one **mapped** field changed: `email`, `firstName`, `lastName`, `phone`,
`company`, `address`, `city`, `zip`, `country`.
Sending on every save is harmless (the backend detects and skips no-op writes) but wasteful.

Do the HTTP call **out of the request path** if your setup allows it (queue, cron, `fastcgi_finish_request`)
so a slow network never blocks the merchant's admin. The backend answers in a few milliseconds
because it only verifies and enqueues, but the shop should not depend on that.

### 2.2 Request

```http
POST {webhook_url}
Content-Type: application/json
X-Oxid-Timestamp: 1775298753123
X-Oxid-Signature: sha256=<hex>

{
  "event": "customer.updated",
  "occurredAt": "2026-08-04T09:12:33.000Z",
  "shopId": "3f9c1d1e-....",
  "customer": {
    "id": "oxid-customer-oxid-value",
    "email": "kunde@example.com",
    "firstName": "Anna",
    "lastName": "Beispiel",
    "phone": "+49 30 123456",
    "updatedAt": "2026-08-04T09:12:31.000Z"
  }
}
```

Rules:

- `customer.id` is required and must be the shop's stable customer id (`oxid` column of
  `oxuser`). It is what the backend stores as `oxid_customer_id`.
- `customer.email` is required for `created`/`updated`. Without it there is nothing to match on in
  HubSpot and the event is logged as `skipped_no_email`.
- Omit or `null` any field the shop does not have. `null` means "no value", it does not mean
  "unchanged".
- `occurredAt` and `customer.updatedAt` are ISO-8601 UTC.
- `shopId` is the `oxid_shop_id` shown in HubSpot Settings after OAuth. It must match the id in the URL.
- `event` may be omitted; it defaults to `customer.updated`.

#### 2.2.1 Alternative: raw OXID `users` object (no normalization in the module)

If the shop module already has the native OXID user row, it may POST it as-is. The backend maps
field names automatically via `fromOxidUserWebhook()`:

```json
{
  "users": {
    "oxusername": "j.smith02@merzljak.de",
    "oxfname": "Jane02",
    "oxlname": "Smith02",
    "mcustnr": "66666692",
    "oxcreate": "2026-07-31T17:28:36+02:00",
    "child_ids": [{ "oxfon": "+49 30 12345678" }]
  }
}
```

### 2.3 Signature

The signed string is the timestamp, a literal dot, then the **exact raw JSON bytes** that are sent:

```
signedPayload = X-Oxid-Timestamp + "." + rawBody
signature     = "sha256=" + bin2hex(hmac_sha256(signedPayload, webhook_secret))
```

`X-Oxid-Timestamp` is Unix time in **milliseconds**. The backend rejects anything more than 5
minutes off its own clock, so the shop's clock must be roughly correct (NTP).

### 2.4 Responses and retries

| Status | Meaning                                       | Module should                                  |
| ------ | --------------------------------------------- | ---------------------------------------------- |
| `202`  | Accepted and queued                            | Consider it delivered                          |
| `400`  | Malformed payload                              | Log, do not retry — it will never succeed      |
| `401`  | Bad or missing signature / stale timestamp     | Log loudly, check secret and clock, do not retry |
| `404`  | Unknown `oxidShopId`                           | Shop is no longer connected — stop sending, re-authorize |
| `409`  | Integration paused                             | Retry later                                    |
| `5xx`  | Backend problem                                | Retry with backoff (e.g. 1m, 5m, 30m)          |

---

## 3. What the backend needs to call *into* OXID

For the HubSpot → OXID direction, the backend uses **OAuth 2.0 bearer tokens** (refresh-token
grant) against the MWV API. See [API_DOCUMENTATION.md](../../API_DOCUMENTATION.md).

The real adapter lives in [../src/oxid/adapters/oxapiClient.ts](../src/oxid/adapters/oxapiClient.ts)
(`OXID_CLIENT_MODE=oxapi`). Confirm read/create/update/list endpoints for customers using
`Authorization: Bearer <access_token>`.

---

## 4. Testing the contract without the module

Signed webhook (credentials from HubSpot Settings after OAuth):

```bash
SECRET='<webhook_secret from Settings>'
SHOP_ID='<oxid_shop_id from Settings>'
BODY='{"event":"customer.updated","shopId":"'$SHOP_ID'","customer":{"id":"c-1","email":"kunde@example.com","firstName":"Anna","lastName":"Beispiel","phone":"+49301234"}}'
TS=$(($(date +%s) * 1000))
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -sS -X POST "$BACKEND_URL/webhooks/oxid/$SHOP_ID" \
  -H 'Content-Type: application/json' \
  -H "X-Oxid-Timestamp: $TS" \
  -H "X-Oxid-Signature: sha256=$SIG" \
  --data-raw "$BODY"
```

Tamper with one byte of `BODY` after computing `SIG` and the same call must return `401`.
