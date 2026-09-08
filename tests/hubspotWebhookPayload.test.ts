import { describe, expect, it, beforeEach } from 'vitest';
import {
  contactIdFromHubspotEvent,
  isContactObjectEvent,
  resetWatchedHubspotPropertiesCache,
  shouldQueueHubspotContactEvent,
  type HubspotWebhookEvent,
} from '../src/hubspot/webhookPayload';
import { HUBSPOT_CONTACT_OBJECT_TYPE_ID } from '../src/hubspot/webhookSubscriptions';

describe('HubSpot webhook payload', () => {
  beforeEach(() => {
    resetWatchedHubspotPropertiesCache();
  });

  it('queues object.creation for contacts', () => {
    const event: HubspotWebhookEvent = {
      subscriptionType: 'object.creation',
      objectTypeId: HUBSPOT_CONTACT_OBJECT_TYPE_ID,
      objectId: 99,
      portalId: 1,
    };
    expect(isContactObjectEvent(event)).toBe(true);
    expect(shouldQueueHubspotContactEvent(event)).toBe(true);
    expect(contactIdFromHubspotEvent(event)).toBe('99');
  });

  it('queues object.propertyChange for watched mapped properties', () => {
    expect(
      shouldQueueHubspotContactEvent({
        subscriptionType: 'object.propertyChange',
        objectTypeId: HUBSPOT_CONTACT_OBJECT_TYPE_ID,
        propertyName: 'email',
        objectId: 1,
        portalId: 1,
      }),
    ).toBe(true);
  });

  it('ignores property changes outside the watched set', () => {
    expect(
      shouldQueueHubspotContactEvent({
        subscriptionType: 'object.propertyChange',
        objectTypeId: HUBSPOT_CONTACT_OBJECT_TYPE_ID,
        propertyName: 'lastmodifieddate',
        objectId: 1,
        portalId: 1,
      }),
    ).toBe(false);

    expect(
      shouldQueueHubspotContactEvent({
        subscriptionType: 'object.propertyChange',
        objectTypeId: HUBSPOT_CONTACT_OBJECT_TYPE_ID,
        propertyName: 'hs_lead_status',
        objectId: 1,
        portalId: 1,
      }),
    ).toBe(false);
  });

  it('ignores non-contact object types', () => {
    expect(
      shouldQueueHubspotContactEvent({
        subscriptionType: 'object.creation',
        objectTypeId: '0-3',
        objectId: 1,
        portalId: 1,
      }),
    ).toBe(false);
  });

  it('accepts legacy contact.* subscription types', () => {
    expect(
      shouldQueueHubspotContactEvent({
        subscriptionType: 'contact.creation',
        objectId: 1,
        portalId: 1,
      }),
    ).toBe(true);

    expect(
      shouldQueueHubspotContactEvent({
        subscriptionType: 'contact.propertyChange',
        propertyName: 'firstname',
        objectId: 1,
        portalId: 1,
      }),
    ).toBe(true);
  });
});
