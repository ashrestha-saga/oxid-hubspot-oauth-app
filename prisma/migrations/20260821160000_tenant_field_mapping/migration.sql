-- AlterTable
ALTER TABLE "integrations" ADD COLUMN "field_mapping_json" TEXT;
ALTER TABLE "integrations" ADD COLUMN "sample_payload_json" TEXT;
ALTER TABLE "integrations" ADD COLUMN "mapping_status" TEXT NOT NULL DEFAULT 'default';
