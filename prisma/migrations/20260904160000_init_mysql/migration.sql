-- CreateTable
CREATE TABLE `integrations` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `hubspot_portal_id` BIGINT NULL,
    `hubspot_access_token` TEXT NULL,
    `hubspot_refresh_token` TEXT NULL,
    `hubspot_token_expires_at` DATETIME(3) NULL,
    `oxid_shop_id` VARCHAR(191) NULL,
    `oxid_base_url` TEXT NULL,
    `oxid_oauth_client_id` TEXT NULL,
    `oxid_oauth_client_secret` TEXT NULL,
    `oxid_access_token` TEXT NULL,
    `oxid_refresh_token` TEXT NULL,
    `oxid_token_expires_at` DATETIME(3) NULL,
    `oxid_webhook_secret` TEXT NULL,
    `field_mapping_json` TEXT NULL,
    `sample_payload_json` TEXT NULL,
    `mapping_status` VARCHAR(191) NOT NULL DEFAULT 'default',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `last_reconciled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `integrations_hubspot_portal_id_key`(`hubspot_portal_id`),
    UNIQUE INDEX `integrations_oxid_shop_id_key`(`oxid_shop_id`),
    INDEX `integrations_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `entity_mappings` (
    `id` VARCHAR(191) NOT NULL,
    `integration_id` VARCHAR(191) NOT NULL,
    `hubspot_contact_id` VARCHAR(191) NULL,
    `oxid_customer_id` VARCHAR(191) NULL,
    `last_synced_at` DATETIME(3) NULL,
    `last_synced_hash` VARCHAR(191) NULL,
    `source_of_last_write` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `entity_mappings_integration_id_idx`(`integration_id`),
    UNIQUE INDEX `entity_mappings_integration_id_hubspot_contact_id_key`(`integration_id`, `hubspot_contact_id`),
    UNIQUE INDEX `entity_mappings_integration_id_oxid_customer_id_key`(`integration_id`, `oxid_customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_events` (
    `id` VARCHAR(191) NOT NULL,
    `integration_id` VARCHAR(191) NULL,
    `direction` VARCHAR(191) NOT NULL,
    `entity_mapping_id` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `detail` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sync_events_integration_id_created_at_idx`(`integration_id`, `created_at`),
    INDEX `sync_events_entity_mapping_id_idx`(`entity_mapping_id`),
    INDEX `sync_events_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sync_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `integration_id` VARCHAR(191) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `dedupe_key` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `run_after` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_at` DATETIME(3) NULL,
    `locked_by` VARCHAR(191) NULL,
    `last_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `sync_jobs_status_run_after_idx`(`status`, `run_after`),
    INDEX `sync_jobs_integration_id_dedupe_key_status_idx`(`integration_id`, `dedupe_key`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `entity_mappings` ADD CONSTRAINT `entity_mappings_integration_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_events` ADD CONSTRAINT `sync_events_integration_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_events` ADD CONSTRAINT `sync_events_entity_mapping_id_fkey` FOREIGN KEY (`entity_mapping_id`) REFERENCES `entity_mappings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sync_jobs` ADD CONSTRAINT `sync_jobs_integration_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

