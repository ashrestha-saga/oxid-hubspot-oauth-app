-- AlterTable
ALTER TABLE `entity_mappings` ADD COLUMN `oxid_record_id` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `entity_mappings_integration_id_oxid_record_id_key` ON `entity_mappings`(`integration_id`, `oxid_record_id`);
