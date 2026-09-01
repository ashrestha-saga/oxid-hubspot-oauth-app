import { Router } from 'express';
import { integrationsRepo, isOxidOAuthConnected } from '../db/repositories/integrations';
import { NotFoundError } from '../lib/errors';
import { readPairingSession } from '../lib/session';
import { asyncHandler } from '../http/asyncHandler';
import { renderConnectPage } from './connectPage';
import { hubspotInstalledAppUrl } from './shopUrl';
import { oxidOAuthRedirectUri } from './oauthApi';

export const oxidConnectRouter = Router();

oxidConnectRouter.get(
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

    if (isOxidOAuthConnected(integration)) {
      res.redirect('/oxid/mapping');
      return;
    }

    res.type('html').send(
      renderConnectPage({
        state: 'not_connected',
        portalId: session.portalId,
        shopUrl: integration.oxidBaseUrl,
        installUrl: '/oauth/install',
        hubspotAppUrl: hubspotInstalledAppUrl(session.portalId),
        oxidOAuthRedirectUri: oxidOAuthRedirectUri(),
      }),
    );
  }),
);
