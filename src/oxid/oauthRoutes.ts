import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env';
import { integrationsRepo, isOxidOAuthConnected, oxidWebhookSecret } from '../db/repositories/integrations';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../lib/errors';
import { randomToken, randomUUID } from '../lib/crypto';
import { logger } from '../lib/logger';
import { readPairingSession } from '../lib/session';
import { asyncHandler } from '../http/asyncHandler';
import {
  buildOxidAuthorizeUrl,
  exchangeOxidCodeForTokens,
  getOxidProfile,
  oxidOAuthRedirectUri,
  oxidOAuthScopes,
} from './oauthApi';
import { generateCodeVerifier } from './pkce';
import { signOxidOAuthState, verifyOxidOAuthState } from './oauthState';
import { normalizeShopUrl } from './shopUrl';

const startSchema = z.object({
  shopUrl: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false as const },
});

export const oxidOAuthRouter = Router();

export async function startOxidOAuth(input: {
  integrationId: string;
  shopUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const shopUrl = normalizeShopUrl(input.shopUrl);
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  const codeVerifier = generateCodeVerifier();
  const state = signOxidOAuthState({
    integrationId: input.integrationId,
    shopUrl,
    clientId,
    clientSecret,
    codeVerifier,
  });

  await integrationsRepo.saveOxidOAuthCredentials(input.integrationId, {
    oxidBaseUrl: shopUrl,
    clientId,
    clientSecret,
  });

  return buildOxidAuthorizeUrl(shopUrl, {
    clientId,
    redirectUri: oxidOAuthRedirectUri(),
    scopes: oxidOAuthScopes(),
    state,
    codeVerifier,
  });
}

oxidOAuthRouter.post(
  '/start',
  limiter,
  asyncHandler(async (req, res) => {
    const session = readPairingSession(req);
    if (!session) throw new UnauthorizedError('pairing session missing or expired');

    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('shopUrl, clientId and clientSecret are required', parsed.error.issues);
    }

    const integration = await integrationsRepo.findById(session.integrationId);
    if (!integration || integration.hubspotPortalId === null) {
      throw new NotFoundError('integration no longer exists');
    }

    const authorizeUrl = await startOxidOAuth({
      integrationId: integration.id,
      shopUrl: parsed.data.shopUrl,
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
    });

    logger.info({ integrationId: integration.id, shopUrl: parsed.data.shopUrl }, 'OXID OAuth started');
    res.redirect(authorizeUrl);
  }),
);

oxidOAuthRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (typeof error === 'string') {
      throw new BadRequestError('OXID denied the authorization', {
        error,
        description: errorDescription,
      });
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new BadRequestError('missing authorization code');
    }
    if (typeof state !== 'string' || state.length === 0) {
      throw new BadRequestError('missing OAuth state');
    }

    const verified = verifyOxidOAuthState(state);
    if (!verified) throw new BadRequestError('invalid or expired OAuth state');

    const integration = await integrationsRepo.findById(verified.integrationId);
    if (!integration) throw new NotFoundError('integration no longer exists');

    const tokens = await exchangeOxidCodeForTokens(verified.shopUrl, {
      code,
      clientId: verified.clientId,
      clientSecret: verified.clientSecret,
      redirectUri: oxidOAuthRedirectUri(),
      codeVerifier: verified.codeVerifier,
    });

    try {
      const profile = await getOxidProfile(verified.shopUrl, tokens.accessToken);
      logger.info(
        {
          integrationId: integration.id,
          sub: profile.sub,
          email: profile.email ? `${profile.email.slice(0, 3)}***` : null,
        },
        'OXID OAuth profile fetched',
      );
    } catch (err) {
      logger.warn({ err, integrationId: integration.id }, 'OXID profile fetch failed after token exchange');
    }

    const oxidShopId = integration.oxidShopId ?? randomUUID();
    const webhookSecret =
      integration.oxidWebhookSecret != null
        ? oxidWebhookSecret(integration)
        : randomToken(32);

    await integrationsRepo.attachOxidFromOAuth(integration.id, {
      oxidShopId,
      oxidBaseUrl: verified.shopUrl,
      clientId: verified.clientId,
      clientSecret: verified.clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      webhookSecret,
    });

    logger.info(
      { integrationId: integration.id, oxidShopId, shopUrl: verified.shopUrl },
      'OXID OAuth completed, integration active',
    );

    res.redirect('/oxid/mapping');
  }),
);
