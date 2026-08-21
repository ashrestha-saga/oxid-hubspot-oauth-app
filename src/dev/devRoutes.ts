import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler';
import {
  activateAllPendingDevIntegrations,
  applyDevOxidPairingIfNeeded,
  devBypassEnabled,
  getDevWebhookCredentials,
} from './devBypass';
import { integrationsRepo } from '../db/repositories/integrations';
import { NotFoundError } from '../lib/errors';

export const devRouter = Router();

devRouter.use((_req, res, next) => {
  if (!devBypassEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  next();
});

/**
 * Returns the fixed dev webhook URL, shop id, and signing secret.
 * Run OAuth install first so hubspot_portal_id is populated.
 */
devRouter.get(
  '/webhook-credentials',
  asyncHandler(async (_req, res) => {
    res.json(await getDevWebhookCredentials());
  }),
);

/** Pairs every HubSpot-connected integration that lacks an OXID shop (dev only). */
devRouter.post(
  '/activate',
  asyncHandler(async (_req, res) => {
    const activated = await activateAllPendingDevIntegrations();
    res.json({ status: 'ok', activated, ...(await getDevWebhookCredentials()) });
  }),
);

/** Pairs one integration by id (dev only). */
devRouter.post(
  '/activate/:integrationId',
  asyncHandler(async (req, res) => {
    const integration = await integrationsRepo.findById(req.params.integrationId as string);
    if (!integration) throw new NotFoundError('integration not found');

    const updated = await applyDevOxidPairingIfNeeded(integration);
    res.json({
      status: 'ok',
      integrationId: updated.id,
      hubspotPortalId: updated.hubspotPortalId?.toString() ?? null,
      ...(await getDevWebhookCredentials()),
    });
  }),
);
