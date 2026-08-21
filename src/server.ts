import { createApp } from './app';
import { env } from './config/env';
import { activateAllPendingDevIntegrations, devBypassEnabled } from './dev/devBypass';
import { disconnectPrisma } from './db/prisma';
import { logger } from './lib/logger';
import { startReconcileSchedule, stopReconcileSchedule } from './jobs/reconcile';
import { startSyncWorker, stopSyncWorker } from './sync/worker';

const app = createApp();
let server: ReturnType<typeof app.listen>;

async function start(): Promise<void> {
  if (devBypassEnabled()) {
    const activated = await activateAllPendingDevIntegrations();
    logger.warn(
      { activated, oxidShopId: env.DEV_OXID_SHOP_ID },
      'DEV_BYPASS_PAIRING enabled — stub OXID shop auto-paired; GET /dev/webhook-credentials for signing secret',
    );
  }

  server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, baseUrl: env.BASE_URL, oxidClientMode: env.OXID_CLIENT_MODE },
      'server listening',
    );
  });
}

void start();

if (env.RUN_WORKER_IN_WEB) {
  startSyncWorker();
  startReconcileSchedule();
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  stopReconcileSchedule();
  await stopSyncWorker();
  await disconnectPrisma();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
