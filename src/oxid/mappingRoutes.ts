import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { integrationsRepo, isOxidOAuthConnected } from '../db/repositories/integrations';
import { hubspotClientFor } from '../hubspot/client';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../lib/errors';
import { logger } from '../lib/logger';
import { readPairingSession } from '../lib/session';
import { asyncHandler } from '../http/asyncHandler';
import {
  defaultTenantFieldMap,
  discoverOxidPayloadKeys,
  ensureAllCanonicalFields,
  parseTenantFieldMap,
  previewMappedContact,
  suggestMapFromKeys,
  tenantFieldMapSchema,
  type TenantFieldMap,
} from '../sync/tenantFieldMap';
import { renderMappingPage } from './mappingPage';
import { hubspotInstalledAppUrl } from './shopUrl';

export const oxidMappingRouter = Router();

async function requireSessionIntegration(req: Parameters<typeof readPairingSession>[0]) {
  const session = readPairingSession(req);
  if (!session) throw new UnauthorizedError('pairing session missing or expired');

  const integration = await integrationsRepo.findById(session.integrationId);
  if (!integration) throw new NotFoundError('integration no longer exists');

  return { session, integration };
}

oxidMappingRouter.get(
  '/mapping',
  asyncHandler(async (req, res) => {
    const session = readPairingSession(req);
    if (!session) {
      res
        .status(401)
        .type('html')
        .send(
          renderMappingPage({
            state: 'no_session',
            installUrl: '/oauth/install',
          }),
        );
      return;
    }

    const integration = await integrationsRepo.findById(session.integrationId);
    if (!integration) throw new NotFoundError('integration no longer exists');

    res.type('html').send(
      renderMappingPage({
        state: isOxidOAuthConnected(integration) ? 'ready' : 'need_pairing',
        portalId: session.portalId,
        shopUrl: integration.oxidBaseUrl,
        oxidShopId: integration.oxidShopId,
        mappingStatus: integration.mappingStatus,
        installUrl: '/oauth/install',
        connectUrl: '/oxid/connect',
        hubspotAppUrl: hubspotInstalledAppUrl(session.portalId),
        probeUrl: integration.oxidShopId
          ? `${env.BASE_URL}/webhooks/oxid/${integration.oxidShopId}/probe`
          : null,
        webhookUrl: integration.oxidShopId
          ? `${env.BASE_URL}/webhooks/oxid/${integration.oxidShopId}`
          : null,
      }),
    );
  }),
);

oxidMappingRouter.get(
  '/mapping/state',
  asyncHandler(async (req, res) => {
    const { integration } = await requireSessionIntegration(req);
    const map = parseTenantFieldMap(integration.fieldMappingJson);
    const sample = integration.samplePayloadJson
      ? (JSON.parse(integration.samplePayloadJson) as unknown)
      : null;
    const discovered = sample ? discoverOxidPayloadKeys(sample) : { keys: [], usersObject: null };

    res.json({
      status: integration.status,
      mappingStatus: integration.mappingStatus,
      oxidShopId: integration.oxidShopId,
      shopUrl: integration.oxidBaseUrl,
      probeUrl: integration.oxidShopId
        ? `${env.BASE_URL}/webhooks/oxid/${integration.oxidShopId}/probe`
        : null,
      webhookUrl: integration.oxidShopId
        ? `${env.BASE_URL}/webhooks/oxid/${integration.oxidShopId}`
        : null,
      map,
      defaultMap: defaultTenantFieldMap(),
      sample,
      keys: discovered.keys,
      hasSample: Boolean(sample),
    });
  }),
);

oxidMappingRouter.get(
  '/mapping/hubspot-properties',
  asyncHandler(async (req, res) => {
    const { integration } = await requireSessionIntegration(req);
    if (!integration.hubspotAccessToken) {
      throw new BadRequestError('HubSpot is not connected for this integration');
    }

    try {
      const properties = await hubspotClientFor(integration.id).listContactProperties();
      res.json({ properties });
    } catch (error) {
      logger.warn({ err: error, integrationId: integration.id }, 'failed to list HubSpot properties');
      // Fall back to the standard contact properties so the wizard still works offline.
      const map = defaultTenantFieldMap();
      res.json({
        properties: map.fields.map((field) => ({
          name: field.hubspotProperty,
          label: field.hubspotProperty,
          type: 'string',
        })),
        fallback: true,
      });
    }
  }),
);

const sampleSchema = z.object({
  payload: z.unknown(),
});

oxidMappingRouter.post(
  '/mapping/sample',
  asyncHandler(async (req, res) => {
    const { integration } = await requireSessionIntegration(req);
    const parsed = sampleSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('payload is required', parsed.error.issues);

    const sampleJson = JSON.stringify(parsed.data.payload);
    await integrationsRepo.saveSamplePayload(integration.id, sampleJson);

    const discovered = discoverOxidPayloadKeys(parsed.data.payload);
    const suggested = suggestMapFromKeys(discovered.keys);

    res.json({
      status: 'captured',
      keys: discovered.keys,
      suggestedMap: suggested,
    });
  }),
);

oxidMappingRouter.post(
  '/mapping/preview',
  asyncHandler(async (req, res) => {
    const { integration } = await requireSessionIntegration(req);
    const bodySchema = z.object({
      map: tenantFieldMapSchema.optional(),
      payload: z.unknown().optional(),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('invalid preview body', parsed.error.issues);

    const map = ensureAllCanonicalFields(
      (parsed.data.map as TenantFieldMap | undefined) ??
        parseTenantFieldMap(integration.fieldMappingJson),
    );
    const payload =
      parsed.data.payload ??
      (integration.samplePayloadJson
        ? (JSON.parse(integration.samplePayloadJson) as unknown)
        : null);

    if (!payload) throw new BadRequestError('no sample payload — send a probe or paste JSON first');

    res.json(previewMappedContact(payload, map));
  }),
);

oxidMappingRouter.put(
  '/mapping',
  asyncHandler(async (req, res) => {
    const { integration } = await requireSessionIntegration(req);
    const bodySchema = z.object({
      map: tenantFieldMapSchema,
      mappingStatus: z.enum(['default', 'custom']).default('custom'),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('invalid field map', parsed.error.issues);

    const map = ensureAllCanonicalFields(parsed.data.map as TenantFieldMap);
    if (!map.fields.some((field) => field.canonical === 'email' && field.oxidPath)) {
      throw new BadRequestError('email must be mapped to an OXID field');
    }

    const updated = await integrationsRepo.saveFieldMapping(integration.id, {
      fieldMappingJson: JSON.stringify(map),
      mappingStatus: parsed.data.mappingStatus,
    });

    logger.info(
      { integrationId: integration.id, mappingStatus: updated.mappingStatus },
      'tenant field mapping saved',
    );

    res.json({
      status: 'ok',
      mappingStatus: updated.mappingStatus,
      map,
    });
  }),
);

oxidMappingRouter.post(
  '/mapping/use-defaults',
  asyncHandler(async (req, res) => {
    const { integration } = await requireSessionIntegration(req);
    const map = defaultTenantFieldMap();
    const updated = await integrationsRepo.saveFieldMapping(integration.id, {
      fieldMappingJson: JSON.stringify(map),
      mappingStatus: 'default',
    });

    res.json({ status: 'ok', mappingStatus: updated.mappingStatus, map });
  }),
);
