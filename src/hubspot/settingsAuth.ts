import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { integrationsRepo, type IntegrationRow } from '../db/repositories/integrations';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../lib/errors';
import { verifyHubspotSignature } from '../lib/hmac';
import { publicUrlOf, rawBodyOf } from '../http/rawBody';

export interface SettingsRequest extends Request {
  settingsPortalId?: string;
  settingsIntegration?: IntegrationRow;
}

/**
 * Authenticates HubSpot UI extension `hubspot.fetch()` calls via signature v3.
 * Portal id comes from HubSpot's appended query metadata — never from the body.
 */
export function requireHubspotFetchAuth(req: SettingsRequest, _res: Response, next: NextFunction): void {
  const verification = verifyHubspotSignature({
    method: req.method,
    fullUri: publicUrlOf(req),
    rawBody: rawBodyOf(req),
    signature: req.get('x-hubspot-signature-v3'),
    timestamp: req.get('x-hubspot-request-timestamp'),
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
  });

  if (!verification.ok) {
    next(new UnauthorizedError(verification.reason ?? 'invalid HubSpot signature'));
    return;
  }

  const portalId = typeof req.query.portalId === 'string' ? req.query.portalId : null;
  if (!portalId) {
    next(new BadRequestError('missing portalId query parameter from HubSpot'));
    return;
  }

  req.settingsPortalId = portalId;
  next();
}

export async function loadSettingsIntegration(
  req: SettingsRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const portalId = req.settingsPortalId;
    if (!portalId) {
      next(new UnauthorizedError('portal not authenticated'));
      return;
    }

    const integration = await integrationsRepo.findByPortalId(portalId);
    if (!integration) {
      next(new NotFoundError('app is not installed for this portal — complete OAuth install first'));
      return;
    }

    req.settingsIntegration = integration;
    next();
  } catch (error) {
    next(error);
  }
}
