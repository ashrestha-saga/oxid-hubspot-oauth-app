import express, { type Express } from 'express';
import { prisma } from './db/prisma';
import { syncJobsRepo } from './db/repositories/syncJobs';
import { oauthRouter } from './hubspot/oauthRoutes';
import { hubspotWebhookRouter } from './hubspot/webhookRoutes';
import { asyncHandler } from './http/asyncHandler';
import { errorHandler, notFoundHandler } from './http/errorMiddleware';
import { rawBodyParser } from './http/rawBody';
import { oxidPairingRouter } from './oxid/pairingRoutes';
import { oxidWebhookRouter } from './oxid/webhookRoutes';
import { devRouter } from './dev/devRoutes';

export function createApp(): Express {
  const app = express();

  // The webhook v3 signature covers the URI HubSpot called, so the original
  // protocol and host have to survive the hosting proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.get(
    '/healthz',
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      const queue = await syncJobsRepo.countByStatus();
      res.json({ status: 'ok', time: new Date().toISOString(), queue });
    }),
  );

  // Webhooks first, with raw bodies: signature verification needs the exact
  // bytes, so these must not reach a JSON parser.
  app.use('/webhooks/hubspot', rawBodyParser(), hubspotWebhookRouter);
  app.use('/webhooks/oxid', rawBodyParser(), oxidWebhookRouter);

  app.use(express.json({ limit: '1mb' }));

  app.use('/oauth', oauthRouter);
  app.use('/oxid', oxidPairingRouter);
  app.use('/dev', devRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
