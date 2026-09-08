import { Router } from 'express';
import { env } from '../config/env';
import { integrationsRepo } from '../db/repositories/integrations';
import { syncJobsRepo } from '../db/repositories/syncJobs';
import { verifyHubspotSignature } from '../lib/hmac';
import { logger } from '../lib/logger';
import { asyncHandler } from '../http/asyncHandler';
import { parseJsonBody, publicUrlOf, rawBodyOf } from '../http/rawBody';
import { dedupeKeyFor } from '../sync/queue';
import {
  contactIdFromHubspotEvent,
  portalIdFromHubspotEvent,
  shouldQueueHubspotContactEvent,
  type HubspotWebhookEvent,
} from './webhookPayload';

export const hubspotWebhookRouter = Router();

/**
 * Receives HubSpot contact webhook events (object.creation, object.propertyChange).
 *
 * Verifies signature v3, filters to watched contact properties, enqueues
 * hubspot_to_oxid jobs. The worker fetches the full contact from HubSpot CRM
 * and writes to OXID using the saved OAuth tokens for that portal.
 */
hubspotWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const verification = verifyHubspotSignature({
      method: req.method,
      fullUri: publicUrlOf(req),
      rawBody: rawBodyOf(req),
      signature: req.get('x-hubspot-signature-v3'),
      timestamp: req.get('x-hubspot-request-timestamp'),
      clientSecret: env.HUBSPOT_CLIENT_SECRET,
    });

    if (!verification.ok) {
      logger.warn({ reason: verification.reason }, 'rejected HubSpot webhook');
      res.status(401).json({ error: 'invalid_signature', message: verification.reason });
      return;
    }

    const events = parseJsonBody<HubspotWebhookEvent[]>(req);
    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'bad_request', message: 'expected a JSON array of events' });
      return;
    }

    let queued = 0;
    let ignored = 0;
    const integrationCache = new Map<string, string | null>();

    for (const event of events) {
      const portalId = portalIdFromHubspotEvent(event);
      const contactId = contactIdFromHubspotEvent(event);

      if (!portalId || !contactId) {
        ignored += 1;
        continue;
      }

      if (!shouldQueueHubspotContactEvent(event)) {
        ignored += 1;
        continue;
      }

      if (!integrationCache.has(portalId)) {
        const integration = await integrationsRepo.findByPortalId(portalId);
        integrationCache.set(
          portalId,
          integration && integration.status === 'active' ? integration.id : null,
        );
      }

      const integrationId = integrationCache.get(portalId) ?? null;
      if (!integrationId) {
        ignored += 1;
        continue;
      }

      await syncJobsRepo.enqueue({
        integrationId,
        direction: 'hubspot_to_oxid',
        dedupeKey: dedupeKeyFor('hubspot_to_oxid', contactId),
        payload: {
          id: contactId,
          hubspotEvent: {
            subscriptionType: event.subscriptionType,
            propertyName: event.propertyName,
            objectTypeId: event.objectTypeId,
            eventId: event.eventId,
          },
        },
      });
      queued += 1;
    }

    logger.info(
      { received: events.length, queued, ignored },
      'HubSpot contact webhook processed',
    );

    res.status(200).json({ received: events.length, queued, ignored });
  }),
);
