import {
  HUBSPOT_CONTACT_OBJECT_TYPE_ID,
  hubspotWebhookPropertyNames,
} from './webhookSubscriptions';

/** Raw HubSpot webhook event (legacy `contact.*` and generic `object.*`). */
export interface HubspotWebhookEvent {
  eventId?: number;
  subscriptionId?: number;
  portalId?: number;
  appId?: number;
  occurredAt?: number;
  subscriptionType?: string;
  attemptNumber?: number;
  objectId?: number | string;
  objectTypeId?: string;
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  sourceId?: string;
  isSensitive?: boolean;
}

const CONTACT_CREATION_TYPES = new Set(['contact.creation', 'object.creation']);
const CONTACT_PROPERTY_CHANGE_TYPES = new Set([
  'contact.propertyChange',
  'object.propertyChange',
]);

let watchedPropertyCache: Set<string> | null = null;

export function watchedHubspotProperties(): Set<string> {
  if (!watchedPropertyCache) {
    watchedPropertyCache = new Set(hubspotWebhookPropertyNames());
  }
  return watchedPropertyCache;
}

/** Test hook: reset cached property set when defaults change in tests. */
export function resetWatchedHubspotPropertiesCache(): void {
  watchedPropertyCache = null;
}

export function isContactObjectEvent(event: HubspotWebhookEvent): boolean {
  const type = event.subscriptionType;
  if (!type) {
    // Older tests / minimal payloads without subscriptionType — assume contact.
    return true;
  }

  if (!CONTACT_CREATION_TYPES.has(type) && !CONTACT_PROPERTY_CHANGE_TYPES.has(type)) {
    return false;
  }

  if (
    event.objectTypeId &&
    event.objectTypeId !== HUBSPOT_CONTACT_OBJECT_TYPE_ID &&
    event.objectTypeId !== 'contact'
  ) {
    return false;
  }

  return true;
}

export function isContactCreationEvent(event: HubspotWebhookEvent): boolean {
  return CONTACT_CREATION_TYPES.has(event.subscriptionType ?? '');
}

export function isContactPropertyChangeEvent(event: HubspotWebhookEvent): boolean {
  return CONTACT_PROPERTY_CHANGE_TYPES.has(event.subscriptionType ?? '');
}

/**
 * Returns true when the event should enqueue a hubspot_to_oxid sync job.
 * Property-change events outside the watched set are dropped (defense in depth).
 */
export function shouldQueueHubspotContactEvent(
  event: HubspotWebhookEvent,
  watched: Set<string> = watchedHubspotProperties(),
): boolean {
  if (!isContactObjectEvent(event)) return false;

  if (isContactCreationEvent(event)) return true;

  if (isContactPropertyChangeEvent(event)) {
    if (!event.propertyName) return false;
    return watched.has(event.propertyName);
  }

  // Minimal payloads without subscriptionType (legacy) — queue.
  if (!event.subscriptionType) return true;

  return false;
}

export function contactIdFromHubspotEvent(event: HubspotWebhookEvent): string | null {
  if (event.objectId === undefined || event.objectId === null) return null;
  const id = String(event.objectId).trim();
  return id || null;
}

export function portalIdFromHubspotEvent(event: HubspotWebhookEvent): string | null {
  if (event.portalId === undefined || event.portalId === null) return null;
  return String(event.portalId);
}
