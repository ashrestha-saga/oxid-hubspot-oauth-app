import { Router } from 'express';
import { env } from '../config/env';
import { integrationsRepo } from '../db/repositories/integrations';
import { syncJobsRepo } from '../db/repositories/syncJobs';
import { verifyHubspotSignature } from '../lib/hmac';
import { logger } from '../lib/logger';
import { asyncHandler } from '../http/asyncHandler';
import { parseJsonBody, publicUrlOf, rawBodyOf } from '../http/rawBody';
import { dedupeKeyFor } from '../sync/queue';

interface HubspotWebhookEvent {
  eventId?: number;
  subscriptionType?: string;
  portalId?: number;
  objectId?: number | string;
  propertyName?: string;
  occurredAt?: number;
  changeSource?: string;
}

export const hubspotWebhookRouter = Router();

/**
 * Receives contact change events.
 *
 * Verifies, enqueues and returns - nothing is synced inline. HubSpot retries
 * deliveries that are slow or non-2xx, so doing the sync here would turn one
 * downstream hiccup into a storm of duplicate work.
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
      if (event.portalId === undefined || event.objectId === undefined) {
        ignored += 1;
        continue;
      }

      const portalKey = String(event.portalId);
      if (!integrationCache.has(portalKey)) {
        const integration = await integrationsRepo.findByPortalId(portalKey);
        integrationCache.set(
          portalKey,
          integration && integration.status === 'active' ? integration.id : null,
        );
      }

      const integrationId = integrationCache.get(portalKey) ?? null;
      if (!integrationId) {
        ignored += 1;
        continue;
      }

      const contactId = String(event.objectId);
      // Only the id is queued: HubSpot sends one event per changed property, so
      // the worker reads the full contact when it processes the job.
      await syncJobsRepo.enqueue({
        integrationId,
        direction: 'hubspot_to_oxid',
        dedupeKey: dedupeKeyFor('hubspot_to_oxid', contactId),
        payload: { id: contactId },
      });
      queued += 1;
    }

    logger.debug({ received: events.length, queued, ignored }, 'HubSpot webhook processed');

    // Unknown or inactive portals are acknowledged, not retried: a redelivery
    // would fail the same way.
    res.status(200).json({ received: events.length, queued, ignored });
  }),
);
