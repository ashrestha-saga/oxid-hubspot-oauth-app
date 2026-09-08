-- CreateTable
CREATE TABLE `company_mappings` (
    `id` VARCHAR(191) NOT NULL,
    `integration_id` VARCHAR(191) NOT NULL,
    `company_key` VARCHAR(191) NOT NULL,
    `company_name` VARCHAR(191) NULL,
    `hubspot_company_id` VARCHAR(191) NULL,
    `last_synced_at` DATETIME(3) NULL,
    `last_synced_hash` VARCHAR(191) NULL,
    `source_of_last_write` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `company_mappings_integration_id_company_key_key`(`integration_id`, `company_key`),
    UNIQUE INDEX `company_mappings_integration_id_hubspot_company_id_key`(`integration_id`, `hubspot_company_id`),
    INDEX `company_mappings_integration_id_idx`(`integration_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `company_mappings` ADD CONSTRAINT `company_mappings_integration_id_fkey` FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
