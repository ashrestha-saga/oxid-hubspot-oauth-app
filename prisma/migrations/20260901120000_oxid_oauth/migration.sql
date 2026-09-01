-- OXID OAuth: replace API key with OAuth client credentials + refresh token.
-- Drop legacy pairing_requests table.

PRAGMA foreign_keys=OFF;

CREATE TABLE "integrations_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "hubspot_portal_id" BIGINT,
    "hubspot_access_token" TEXT,
    "hubspot_refresh_token" TEXT,
    "hubspot_token_expires_at" DATETIME,
    "oxid_shop_id" TEXT,
    "oxid_base_url" TEXT,
    "oxid_oauth_client_id" TEXT,
    "oxid_oauth_client_secret" TEXT,
    "oxid_access_token" TEXT,
    "oxid_refresh_token" TEXT,
    "oxid_token_expires_at" DATETIME,
    "oxid_webhook_secret" TEXT,
    "field_mapping_json" TEXT,
    "sample_payload_json" TEXT,
    "mapping_status" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_reconciled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

INSERT INTO "integrations_new" (
    "id", "name", "hubspot_portal_id", "hubspot_access_token", "hubspot_refresh_token",
    "hubspot_token_expires_at", "oxid_shop_id", "oxid_base_url",
    "oxid_oauth_client_id", "oxid_oauth_client_secret",
    "oxid_access_token", "oxid_refresh_token", "oxid_token_expires_at",
    "oxid_webhook_secret", "field_mapping_json", "sample_payload_json",
    "mapping_status", "status", "last_reconciled_at", "created_at", "updated_at"
)
SELECT
    "id", "name", "hubspot_portal_id", "hubspot_access_token", "hubspot_refresh_token",
    "hubspot_token_expires_at", "oxid_shop_id", "oxid_base_url",
    NULL, NULL,
    "oxid_access_token", NULL, "oxid_token_expires_at",
    "oxid_webhook_secret", "field_mapping_json", "sample_payload_json",
    "mapping_status", "status", "last_reconciled_at", "created_at", "updated_at"
FROM "integrations";

DROP TABLE "integrations";
ALTER TABLE "integrations_new" RENAME TO "integrations";

CREATE UNIQUE INDEX "integrations_hubspot_portal_id_key" ON "integrations"("hubspot_portal_id");
CREATE UNIQUE INDEX "integrations_oxid_shop_id_key" ON "integrations"("oxid_shop_id");
CREATE INDEX "integrations_status_idx" ON "integrations"("status");

DROP TABLE IF EXISTS "pairing_requests";

PRAGMA foreign_keys=ON;
