import {
  companyMappingsRepo,
  type CompanyMappingRow,
} from '../db/repositories/companyMappings';
import type { IntegrationRow } from '../db/repositories/integrations';
import { hubspotClientFor } from '../hubspot/client';
import { logger } from '../lib/logger';
import {
  companyFromContact,
  companyHash,
  companyHubspotProperties,
  companyKeyOf,
  toHubspotCompanyProperties,
  type CanonicalCompany,
} from './companyFieldMap';
import type { CanonicalContact } from './fieldMap';

export interface SyncCompanyFromContactInput {
  integration: IntegrationRow;
  contact: CanonicalContact;
}

export interface SyncCompanyResult {
  status: 'success' | 'skipped_no_company' | 'skipped_loop';
  hubspotCompanyId?: string;
  companyMappingId?: string;
  companyName?: string;
  reason?: string;
}

async function writeCompanyToHubspot(
  integrationId: string,
  mapping: CompanyMappingRow | null,
  company: CanonicalCompany,
): Promise<string> {
  const client = hubspotClientFor(integrationId);
  const properties = toHubspotCompanyProperties(company);
  const readProperties = [...companyHubspotProperties];

  if (mapping?.hubspotCompanyId) {
    const existing = await client.getCompany(mapping.hubspotCompanyId, ['name']);
    if (existing) {
      await client.updateCompany(mapping.hubspotCompanyId, properties);
      return mapping.hubspotCompanyId;
    }
    logger.warn(
      { integrationId, hubspotCompanyId: mapping.hubspotCompanyId },
      'mapped HubSpot company is gone, re-matching by name',
    );
  }

  const { company: written } = await client.upsertCompanyByName(
    company.name,
    properties,
    readProperties,
  );
  return written.id;
}

/**
 * OXID → HubSpot only: upsert a Company object from contact/user company fields.
 * Does not write the HubSpot contact "company" text property.
 */
export async function syncCompanyFromContact(
  input: SyncCompanyFromContactInput,
): Promise<SyncCompanyResult> {
  const { integration, contact } = input;
  const company = companyFromContact(contact);
  if (!company) {
    return { status: 'skipped_no_company', reason: 'no company name on contact' };
  }

  const companyKey = companyKeyOf(company.name);
  let mapping = await companyMappingsRepo.findByCompanyKey(integration.id, companyKey);
  if (!mapping) {
    mapping = await companyMappingsRepo.create({
      integrationId: integration.id,
      companyKey,
      companyName: company.name,
    });
  }

  const hash = companyHash(company);
  if (mapping.lastSyncedHash === hash && mapping.hubspotCompanyId) {
    return {
      status: 'skipped_loop',
      hubspotCompanyId: mapping.hubspotCompanyId,
      companyMappingId: mapping.id,
      companyName: company.name,
    };
  }

  const hubspotCompanyId = await writeCompanyToHubspot(integration.id, mapping, company);

  const linked = await companyMappingsRepo.upsertByCompanyKey({
    integrationId: integration.id,
    companyKey,
    companyName: company.name,
    hubspotCompanyId,
  });
  await companyMappingsRepo.recordSync(integration.id, linked.id, {
    hash,
    source: 'oxid',
  });

  logger.info(
    {
      integrationId: integration.id,
      companyKey,
      hubspotCompanyId,
    },
    'company synced (oxid → hubspot)',
  );

  return {
    status: 'success',
    hubspotCompanyId,
    companyMappingId: linked.id,
    companyName: company.name,
  };
}
