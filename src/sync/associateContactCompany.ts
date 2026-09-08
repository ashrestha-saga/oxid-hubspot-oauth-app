import { hubspotClientFor } from '../hubspot/client';
import { logger } from '../lib/logger';

export interface AssociateContactCompanyInput {
  integrationId: string;
  hubspotContactId: string;
  hubspotCompanyId: string;
}

/**
 * Creates the default HubSpot contact ↔ company association.
 * Safe to call repeatedly for the same pair.
 */
export async function associateContactWithCompany(
  input: AssociateContactCompanyInput,
): Promise<void> {
  const { integrationId, hubspotContactId, hubspotCompanyId } = input;
  await hubspotClientFor(integrationId).associateContactToCompany(
    hubspotContactId,
    hubspotCompanyId,
  );
  logger.info(
    { integrationId, hubspotContactId, hubspotCompanyId },
    'associated HubSpot contact with company',
  );
}
