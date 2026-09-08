import type { HubspotProperties } from '../hubspot/client';
import { hubspotClientFor } from '../hubspot/client';
import { logger } from '../lib/logger';
import type { ClosedOrderContactDetails } from '../oxid/orderWebhookPayload';

export interface EnsureContactFromOrderInput {
  integrationId: string;
  contact: ClosedOrderContactDetails;
}

export interface EnsureContactFromOrderResult {
  hubspotContactId: string;
  created: boolean;
}

/**
 * Find HubSpot contact by email; create only if missing.
 * Existing contacts are not updated (matches prior closed-order behavior).
 */
export async function ensureContactFromOrder(
  input: EnsureContactFromOrderInput,
): Promise<EnsureContactFromOrderResult> {
  const { integrationId, contact } = input;
  const client = hubspotClientFor(integrationId);
  const email = contact.email.trim().toLowerCase();

  const existing = await client.findContactByEmail(email, ['email']);
  if (existing) {
    return { hubspotContactId: existing.id, created: false };
  }

  const properties: HubspotProperties = {
    email,
    firstname: contact.firstName ?? '',
    lastname: contact.lastName ?? '',
    phone: contact.phone ?? '',
    address: contact.address ?? '',
    zip: contact.zip ?? '',
    city: contact.city ?? '',
    country: contact.country ?? '',
  };

  const created = await client.createContact(properties);
  logger.info(
    { integrationId, hubspotContactId: created.id, email },
    'created HubSpot contact from closed order',
  );
  return { hubspotContactId: created.id, created: true };
}
