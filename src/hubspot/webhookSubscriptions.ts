import { defaultTenantFieldMap, hubspotPropertiesFromMap } from '../sync/tenantFieldMap';

/** HubSpot CRM contact object type id (raw format in webhook payloads). */
export const HUBSPOT_CONTACT_OBJECT_TYPE_ID = '0-1';

export interface ContactWebhookSubscriptionSpec {
  eventType: 'object.creation' | 'object.propertyChange';
  objectTypeId: string;
  propertyName?: string;
}

/**
 * HubSpot contact properties worth subscribing to for sync.
 * Excludes `lastmodifieddate` — it changes on every write and would cause loops.
 */
export function hubspotWebhookPropertyNames(): string[] {
  return hubspotPropertiesFromMap(defaultTenantFieldMap()).filter(
    (name) => name !== 'lastmodifieddate',
  );
}

/** App-level webhook subscriptions for contact create + mapped property changes. */
export function contactWebhookSubscriptionSpecs(): ContactWebhookSubscriptionSpec[] {
  const specs: ContactWebhookSubscriptionSpec[] = [
    {
      eventType: 'object.creation',
      objectTypeId: HUBSPOT_CONTACT_OBJECT_TYPE_ID,
    },
  ];

  for (const propertyName of hubspotWebhookPropertyNames()) {
    specs.push({
      eventType: 'object.propertyChange',
      objectTypeId: HUBSPOT_CONTACT_OBJECT_TYPE_ID,
      propertyName,
    });
  }

  return specs;
}

export function subscriptionSpecKey(spec: ContactWebhookSubscriptionSpec): string {
  return `${spec.eventType}:${spec.objectTypeId}:${spec.propertyName ?? ''}`;
}

export function subscriptionRowKey(row: {
  eventType?: string;
  objectTypeId?: string;
  propertyName?: string;
}): string {
  return `${row.eventType ?? ''}:${row.objectTypeId ?? ''}:${row.propertyName ?? ''}`;
}
