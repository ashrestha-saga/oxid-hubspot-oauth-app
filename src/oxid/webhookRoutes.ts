import { Router } from 'express';
import { integrationsRepo, oxidWebhookSecret } from '../db/repositories/integrations';
import { syncJobsRepo } from '../db/repositories/syncJobs';
import { verifyOxidSignature } from '../lib/hmac';
import { logger } from '../lib/logger';
import { asyncHandler } from '../http/asyncHandler';
import { parseJsonBody, rawBodyOf } from '../http/rawBody';
import { dedupeKeyFor } from '../sync/queue';
import {
  discoverOxidPayloadKeys,
  parseTenantFieldMap,
  suggestMapFromKeys,
} from '../sync/tenantFieldMap';
import { parseOxidWebhook, shopIdFrom, sourceRecordFromWebhook } from './webhookPayload';

export const oxidWebhookRouter = Router();

/**
 * Receives customer change events pushed by the shop's module.
 *
 * The shop id in the path selects the tenant, and the signature is checked with
 * that tenant's own secret - so one shop's secret can never authenticate an
 * event for another shop.
 */
oxidWebhookRouter.post(
  '/:oxidShopId',
  asyncHandler(async (req, res) => {
    const { oxidShopId } = req.params as { oxidShopId: string };

    const integration = await integrationsRepo.findByOxidShopId(oxidShopId);
    if (!integration || !integration.oxidWebhookSecret) {
      logger.warn({ oxidShopId }, 'webhook for unknown OXID shop');
      res.status(404).json({ error: 'not_found', message: 'unknown oxidShopId' });
      return;
    }

    const verification = verifyOxidSignature({
      rawBody: rawBodyOf(req),
      signature: req.get('x-oxid-signature'),
      timestamp: req.get('x-oxid-timestamp'),
      secret: oxidWebhookSecret(integration),
    });

    if (!verification.ok) {
      logger.warn({ oxidShopId, reason: verification.reason }, 'rejected OXID webhook');
      res.status(401).json({ error: 'invalid_signature', message: verification.reason });
      return;
    }

    if (integration.status !== 'active') {
      res.status(409).json({ error: 'integration_not_ready', message: `status ${integration.status}` });
      return;
    }

    const parsed = parseOxidWebhook(parseJsonBody(req));
    if (!parsed) {
      res.status(400).json({
        error: 'bad_request',
        message: 'invalid payload: expected customer or users object',
      });
      return;
    }

    const payloadShopId = shopIdFrom(parsed);
    if (payloadShopId && payloadShopId !== oxidShopId) {
      res
        .status(400)
        .json({ error: 'bad_request', message: 'shopId does not match the URL shop id' });
      return;
    }

    const map = parseTenantFieldMap(integration.fieldMappingJson);
    const sourceRecord = sourceRecordFromWebhook(parsed, map);

    const { jobId, deduped } = await syncJobsRepo.enqueue({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      dedupeKey: dedupeKeyFor('oxid_to_hubspot', sourceRecord.id),
      payload: { ...sourceRecord },
    });

    logger.debug(
      { integrationId: integration.id, customerId: sourceRecord.id, jobId, deduped },
      'OXID webhook queued',
    );

    res.status(202).json({ status: 'queued', jobId, deduped });
  }),
);

/**
 * Mapping-setup probe: same HMAC as the live webhook, but only stores the sample
 * payload and returns discovered keys — never enqueues a sync job.
 */
oxidWebhookRouter.post(
  '/:oxidShopId/probe',
  asyncHandler(async (req, res) => {
    const { oxidShopId } = req.params as { oxidShopId: string };

    const integration = await integrationsRepo.findByOxidShopId(oxidShopId);
    if (!integration || !integration.oxidWebhookSecret) {
      res.status(404).json({ error: 'not_found', message: 'unknown oxidShopId' });
      return;
    }

    const verification = verifyOxidSignature({
      rawBody: rawBodyOf(req),
      signature: req.get('x-oxid-signature'),
      timestamp: req.get('x-oxid-timestamp'),
      secret: oxidWebhookSecret(integration),
    });

    if (!verification.ok) {
      res.status(401).json({ error: 'invalid_signature', message: verification.reason });
      return;
    }

    const body = parseJsonBody(req);
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'bad_request', message: 'JSON body required' });
      return;
    }

    const sampleJson = JSON.stringify(body);
    await integrationsRepo.saveSamplePayload(integration.id, sampleJson);

    const discovered = discoverOxidPayloadKeys(body);
    const suggested = suggestMapFromKeys(discovered.keys);

    logger.info(
      { integrationId: integration.id, keyCount: discovered.keys.length },
      'OXID probe sample stored',
    );

    res.status(200).json({
      status: 'captured',
      keys: discovered.keys,
      suggestedMap: suggested,
      sampleStored: true,
    });
  }),
);
