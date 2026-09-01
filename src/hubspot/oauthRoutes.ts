import { Router } from 'express';
import { integrationsRepo, isOxidOAuthConnected } from '../db/repositories/integrations';
import { BadRequestError } from '../lib/errors';
import { logger } from '../lib/logger';
import { setPairingCookie, signPairingSession } from '../lib/session';
import { asyncHandler } from '../http/asyncHandler';
import { buildAuthorizeUrl, exchangeCodeForTokens, getTokenInfo } from './oauthApi';

export const oauthRouter = Router();

oauthRouter.get('/install', (_req, res) => {
  const authorizeUrl = buildAuthorizeUrl();
  logger.info({ redirectUri: new URL(authorizeUrl).searchParams.get('redirect_uri') }, 'starting HubSpot OAuth');
  res.redirect(authorizeUrl);
});

oauthRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, error, error_description: errorDescription } = req.query;

    if (typeof error === 'string') {
      throw new BadRequestError('HubSpot denied the installation', {
        error,
        description: errorDescription,
      });
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new BadRequestError('missing authorization code');
    }

    const tokens = await exchangeCodeForTokens(code);
    const info = await getTokenInfo(tokens.accessToken);

    const integration = await integrationsRepo.upsertFromHubspotInstall({
      portalId: info.portalId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      name: info.hubDomain,
    });

    logger.info(
      {
        integrationId: integration.id,
        portalId: info.portalId,
        status: integration.status,
        oxidConnected: isOxidOAuthConnected(integration),
      },
      'HubSpot install completed',
    );

    setPairingCookie(
      res,
      signPairingSession({ integrationId: integration.id, portalId: info.portalId }),
    );

    if (isOxidOAuthConnected(integration)) {
      res.redirect('/oxid/mapping');
      return;
    }

    res.redirect('/oxid/connect');
  }),
);
