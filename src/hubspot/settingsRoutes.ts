import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import {
  integrationsRepo,
  isOxidOAuthConnected,
  oxidWebhookSecret,
} from '../db/repositories/integrations';
import { hubspotClientFor } from './client';
import { BadRequestError } from '../lib/errors';
import { logger } from '../lib/logger';
import { asyncHandler } from '../http/asyncHandler';
import { parseJsonBody } from '../http/rawBody';
import { startOxidOAuth } from '../oxid/oauthRoutes';
import { oxidOAuthRedirectUri } from '../oxid/oauthApi';
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
import {
  loadSettingsIntegration,
  requireHubspotFetchAuth,
  type SettingsRequest,
} from './settingsAuth';

export const settingsRouter = Router();

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false as const },
});

settingsRouter.use(limiter);
settingsRouter.use(requireHubspotFetchAuth);
settingsRouter.use(asyncHandler(loadSettingsIntegration));

settingsRouter.get(
  '/status',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const map = parseTenantFieldMap(integration.fieldMappingJson);
    const oxidConnected = isOxidOAuthConnected(integration);

    res.json({
      portalId: req.settingsPortalId,
      integrationId: integration.id,
      status: integration.status,
      connected: oxidConnected,
      oxidConnected,
      oxidShopId: integration.oxidShopId,
      shopUrl: integration.oxidBaseUrl,
      mappingStatus: integration.mappingStatus,
      map,
      hasSample: Boolean(integration.samplePayloadJson),
      probeUrl: integration.oxidShopId
        ? `${env.BASE_URL}/webhooks/oxid/${integration.oxidShopId}/probe`
        : null,
      webhookUrl: integration.oxidShopId
        ? `${env.BASE_URL}/webhooks/oxid/${integration.oxidShopId}`
        : null,
      webhookSecret:
        oxidConnected && integration.oxidWebhookSecret
          ? oxidWebhookSecret(integration)
          : null,
      oxidOAuthRedirectUri: oxidOAuthRedirectUri(),
      lastReconciledAt: integration.lastReconciledAt,
      mappingWizardUrl: `${env.BASE_URL}/oxid/mapping`,
      connectUrl: `${env.BASE_URL}/oxid/connect`,
    });
  }),
);

settingsRouter.post(
  '/oauth/start',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const body = parseJsonBody<{ shopUrl?: string; clientId?: string; clientSecret?: string }>(
      req,
    ) ?? {};
    if (!body.shopUrl || typeof body.shopUrl !== 'string') {
      throw new BadRequestError('shopUrl is required');
    }
    if (!body.clientId || typeof body.clientId !== 'string') {
      throw new BadRequestError('clientId is required');
    }
    if (!body.clientSecret || typeof body.clientSecret !== 'string') {
      throw new BadRequestError('clientSecret is required');
    }

    const authorizeUrl = await startOxidOAuth({
      integrationId: integration.id,
      shopUrl: body.shopUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });

    logger.info({ integrationId: integration.id, shopUrl: body.shopUrl }, 'settings OXID OAuth started');

    res.json({ authorizeUrl });
  }),
);

settingsRouter.get(
  '/mapping',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const map = parseTenantFieldMap(integration.fieldMappingJson);
    const sample = integration.samplePayloadJson
      ? (JSON.parse(integration.samplePayloadJson) as unknown)
      : null;
    const discovered = sample ? discoverOxidPayloadKeys(sample) : { keys: [] };

    res.json({
      map,
      defaultMap: defaultTenantFieldMap(),
      mappingStatus: integration.mappingStatus,
      keys: discovered.keys,
      hasSample: Boolean(sample),
      sample,
    });
  }),
);

settingsRouter.get(
  '/hubspot-properties',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    try {
      const properties = await hubspotClientFor(integration.id).listContactProperties();
      res.json({ properties });
    } catch (error) {
      logger.warn({ err: error, integrationId: integration.id }, 'settings: list properties failed');
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

settingsRouter.put(
  '/mapping',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const body = parseJsonBody<{
      map?: TenantFieldMap;
      mappingStatus?: 'default' | 'custom';
    }>(req);
    const parsed = z
      .object({
        map: tenantFieldMapSchema,
        mappingStatus: z.enum(['default', 'custom']).default('custom'),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestError('invalid field map', parsed.error.issues);

    const map = ensureAllCanonicalFields(parsed.data.map as TenantFieldMap);
    if (!map.fields.some((field) => field.canonical === 'email' && field.oxidPath)) {
      throw new BadRequestError('email must be mapped to an OXID field');
    }

    const updated = await integrationsRepo.saveFieldMapping(integration.id, {
      fieldMappingJson: JSON.stringify(map),
      mappingStatus: parsed.data.mappingStatus,
    });

    res.json({ status: 'ok', mappingStatus: updated.mappingStatus, map });
  }),
);

settingsRouter.post(
  '/mapping/use-defaults',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const map = defaultTenantFieldMap();
    const updated = await integrationsRepo.saveFieldMapping(integration.id, {
      fieldMappingJson: JSON.stringify(map),
      mappingStatus: 'default',
    });
    res.json({ status: 'ok', mappingStatus: updated.mappingStatus, map });
  }),
);

settingsRouter.post(
  '/mapping/sample',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const body = parseJsonBody<{ payload?: unknown }>(req);
    if (!body?.payload) throw new BadRequestError('payload is required');

    await integrationsRepo.saveSamplePayload(integration.id, JSON.stringify(body.payload));
    const discovered = discoverOxidPayloadKeys(body.payload);
    res.json({
      status: 'captured',
      keys: discovered.keys,
      suggestedMap: suggestMapFromKeys(discovered.keys),
    });
  }),
);

settingsRouter.post(
  '/mapping/preview',
  asyncHandler(async (req: SettingsRequest, res) => {
    const integration = req.settingsIntegration!;
    const body = parseJsonBody<{ map?: TenantFieldMap; payload?: unknown }>(req) ?? {};
    const map = ensureAllCanonicalFields(
      body.map ? (body.map as TenantFieldMap) : parseTenantFieldMap(integration.fieldMappingJson),
    );
    const payload =
      body.payload ??
      (integration.samplePayloadJson
        ? (JSON.parse(integration.samplePayloadJson) as unknown)
        : null);
    if (!payload) throw new BadRequestError('no sample payload available');
    res.json(previewMappedContact(payload, map));
  }),
);
