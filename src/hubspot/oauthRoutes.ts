import { Router } from 'express';
import { integrationsRepo } from '../db/repositories/integrations';
import { BadRequestError } from '../lib/errors';
import { logger } from '../lib/logger';
import { setPairingCookie, signPairingSession } from '../lib/session';
import { asyncHandler } from '../http/asyncHandler';
import { buildAuthorizeUrl, exchangeCodeForTokens, getTokenInfo } from './oauthApi';
import { applyDevOxidPairingIfNeeded } from '../dev/devBypass';

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

    const ready = await applyDevOxidPairingIfNeeded(integration);

    logger.info(
      {
        integrationId: ready.id,
        portalId: info.portalId,
        status: ready.status,
        devBypass: ready.oxidShopId !== integration.oxidShopId,
      },
      'HubSpot install completed',
    );

    // The merchant proved control of this portal by completing OAuth, so hand
    // them a signed session that authorizes the OXID pairing step.
    setPairingCookie(
      res,
      signPairingSession({ integrationId: integration.id, portalId: info.portalId }),
    );

    res.redirect('/oxid/connect');
  }),
);
