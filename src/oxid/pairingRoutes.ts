import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { integrationsRepo } from '../db/repositories/integrations';
import { pairingRequestsRepo } from '../db/repositories/pairingRequests';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../lib/errors';
import { randomToken, randomUUID } from '../lib/crypto';
import { logger } from '../lib/logger';
import { readPairingSession } from '../lib/session';
import { asyncHandler } from '../http/asyncHandler';
import { renderConnectPage } from './connectPage';
import { buildPairingRedirectUrl, hubspotInstalledAppUrl, normalizeShopUrl, sameShopHost } from './shopUrl';

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

const startSchema = z.object({ shopUrl: z.string().min(1) });

const callbackSchema = z.object({
  pairing_token: z.string().min(10),
  shop_url: z.string().min(1),
  api_key: z.string().min(8),
});

// `trust proxy` is 1 because the service runs behind exactly one proxy, which is
// what the limiter's own check cannot infer - so that single check is disabled.
const limiterDefaults = {
  windowMs: 10 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false as const },
};

const startLimiter = rateLimit({ ...limiterDefaults, limit: 20 });

const callbackLimiter = rateLimit({ ...limiterDefaults, limit: 60 });

export const oxidPairingRouter = Router();

/**
 * Stand-in for the HubSpot UI extension: a page the merchant lands on straight
 * after installing, so the whole pairing flow is exercisable today. The eventual
 * UI extension calls the same `/oxid/pair/start` endpoint.
 */
oxidPairingRouter.get(
  '/connect',
  asyncHandler(async (req, res) => {
    const session = readPairingSession(req);
    if (!session) {
      res
        .status(401)
        .type('html')
        .send(renderConnectPage({ state: 'no_session', installUrl: '/oauth/install' }));
      return;
    }

    const integration = await integrationsRepo.findById(session.integrationId);
    if (!integration) throw new NotFoundError('integration no longer exists');

    res.type('html').send(
      renderConnectPage({
        state: integration.status === 'active' ? 'connected' : 'not_connected',
        portalId: session.portalId,
        shopUrl: integration.oxidBaseUrl,
        installUrl: '/oauth/install',
        hubspotAppUrl: hubspotInstalledAppUrl(session.portalId),
      }),
    );
  }),
);

/** Status endpoint the connect page polls after the merchant returns from OXID. */
oxidPairingRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    const session = readPairingSession(req);
    if (!session) throw new UnauthorizedError('pairing session missing or expired');

    const integration = await integrationsRepo.findById(session.integrationId);
    if (!integration) throw new NotFoundError('integration no longer exists');

    res.json({
      status: integration.status,
      portalId: session.portalId,
      shopUrl: integration.oxidBaseUrl,
      connected: integration.status === 'active',
    });
  }),
);

oxidPairingRouter.post(
  '/pair/start',
  startLimiter,
  asyncHandler(async (req, res) => {
    // The portal id comes from the signed session, never from the request body:
    // otherwise anyone could mint a pairing token for a portal they don't own.
    const session = readPairingSession(req);
    if (!session) throw new UnauthorizedError('pairing session missing or expired');

    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('shopUrl is required', parsed.error.issues);

    const integration = await integrationsRepo.findById(session.integrationId);
    if (!integration || integration.hubspotPortalId === null) {
      throw new NotFoundError('integration no longer exists');
    }

    const shopUrl = normalizeShopUrl(parsed.data.shopUrl);
    const token = randomToken(32);

    await pairingRequestsRepo.create({
      token,
      portalId: integration.hubspotPortalId,
      oxidShopUrl: shopUrl,
      expiresAt: new Date(Date.now() + PAIRING_TOKEN_TTL_MS),
    });

    logger.info({ integrationId: integration.id, shopUrl }, 'pairing started');

    res.json({
      redirectUrl: buildPairingRedirectUrl(shopUrl, token),
      shopUrl,
      expiresInSeconds: PAIRING_TOKEN_TTL_MS / 1000,
    });
  }),
);

/**
 * Called by the OXID module after the merchant confirms in their own shop admin.
 * Unauthenticated by design - the single-use pairing token is the credential.
 */
oxidPairingRouter.post(
  '/pair/callback',
  callbackLimiter,
  asyncHandler(async (req, res) => {
    const parsed = callbackSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('invalid pairing callback payload', parsed.error.issues);
    }

    const request = await pairingRequestsRepo.consume(parsed.data.pairing_token);
    if (!request) throw new BadRequestError('invalid, expired or already used pairing token');

    const shopUrl = normalizeShopUrl(parsed.data.shop_url);
    // A token is issued for one specific shop host; refuse to bind it elsewhere.
    if (!sameShopHost(shopUrl, request.oxidShopUrl)) {
      throw new BadRequestError('shop_url does not match the shop this token was issued for');
    }

    const integration = await integrationsRepo.findByPortalId(request.hubspotPortalId);
    if (!integration) throw new NotFoundError('no integration for this HubSpot portal');

    const oxidShopId = randomUUID();
    const webhookSecret = randomToken(32);

    await integrationsRepo.attachOxidShop(integration.id, {
      oxidShopId,
      oxidBaseUrl: shopUrl,
      oxidApiKey: parsed.data.api_key,
      oxidWebhookSecret: webhookSecret,
    });

    logger.info(
      { integrationId: integration.id, oxidShopId, shopUrl },
      'pairing completed, integration active',
    );

    // The signing secret is returned exactly once. The module must persist it -
    // there is no endpoint to read it back, only re-pairing.
    res.json({
      status: 'ok',
      oxid_shop_id: oxidShopId,
      webhook_secret: webhookSecret,
      webhook_url: `${env.BASE_URL}/webhooks/oxid/${oxidShopId}`,
      hubspot_portal_id: String(request.hubspotPortalId),
    });
  }),
);
