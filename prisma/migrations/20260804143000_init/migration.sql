-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "hubspot_portal_id" BIGINT,
    "hubspot_access_token" TEXT,
    "hubspot_refresh_token" TEXT,
    "hubspot_token_expires_at" DATETIME,
    "oxid_shop_id" TEXT,
    "oxid_base_url" TEXT,
    "oxid_api_key" TEXT,
    "oxid_access_token" TEXT,
    "oxid_token_expires_at" DATETIME,
    "oxid_webhook_secret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_reconciled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "pairing_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "hubspot_portal_id" BIGINT NOT NULL,
    "oxid_shop_url" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "entity_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integration_id" TEXT NOT NULL,
    "hubspot_contact_id" TEXT,
    "oxid_customer_id" TEXT,
    "last_synced_at" DATETIME,
    "last_synced_hash" TEXT,
    "source_of_last_write" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "entity_mappings_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sync_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integration_id" TEXT,
    "direction" TEXT NOT NULL,
    "entity_mapping_id" TEXT,
    "status" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sync_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "sync_events_entity_mapping_id_fkey" FOREIGN KEY ("entity_mapping_id") REFERENCES "entity_mappings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "integration_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" DATETIME,
    "locked_by" TEXT,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "sync_jobs_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "integrations_hubspot_portal_id_key" ON "integrations"("hubspot_portal_id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_oxid_shop_id_key" ON "integrations"("oxid_shop_id");

-- CreateIndex
CREATE INDEX "integrations_status_idx" ON "integrations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_requests_token_key" ON "pairing_requests"("token");

-- CreateIndex
CREATE INDEX "pairing_requests_hubspot_portal_id_idx" ON "pairing_requests"("hubspot_portal_id");

-- CreateIndex
CREATE INDEX "pairing_requests_expires_at_idx" ON "pairing_requests"("expires_at");

-- CreateIndex
CREATE INDEX "entity_mappings_integration_id_idx" ON "entity_mappings"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_mappings_integration_id_hubspot_contact_id_key" ON "entity_mappings"("integration_id", "hubspot_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_mappings_integration_id_oxid_customer_id_key" ON "entity_mappings"("integration_id", "oxid_customer_id");

-- CreateIndex
CREATE INDEX "sync_events_integration_id_created_at_idx" ON "sync_events"("integration_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_events_entity_mapping_id_idx" ON "sync_events"("entity_mapping_id");

-- CreateIndex
CREATE INDEX "sync_events_status_idx" ON "sync_events"("status");

-- CreateIndex
CREATE INDEX "sync_jobs_status_run_after_idx" ON "sync_jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "sync_jobs_integration_id_dedupe_key_status_idx" ON "sync_jobs"("integration_id", "dedupe_key", "status");

