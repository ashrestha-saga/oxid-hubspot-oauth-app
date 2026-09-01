import express, { type Express } from 'express';
import { prisma } from './db/prisma';
import { syncJobsRepo } from './db/repositories/syncJobs';
import { oauthRouter } from './hubspot/oauthRoutes';
import { hubspotWebhookRouter } from './hubspot/webhookRoutes';
import { settingsRouter } from './hubspot/settingsRoutes';
import { asyncHandler } from './http/asyncHandler';
import { errorHandler, notFoundHandler } from './http/errorMiddleware';
import { rawBodyParser } from './http/rawBody';
import { oxidConnectRouter } from './oxid/connectRoutes';
import { oxidOAuthRouter } from './oxid/oauthRoutes';
import { oxidMappingRouter } from './oxid/mappingRoutes';
import { oxidWebhookRouter } from './oxid/webhookRoutes';

export function createApp(): Express {
  const app = express();

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

  app.use('/webhooks/hubspot', rawBodyParser(), hubspotWebhookRouter);
  app.use('/webhooks/oxid', rawBodyParser(), oxidWebhookRouter);
  app.use('/api/settings', rawBodyParser(), settingsRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use('/oauth', oauthRouter);
  app.use('/oxid', oxidConnectRouter);
  app.use('/oxid/oauth', oxidOAuthRouter);
  app.use('/oxid', oxidMappingRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
