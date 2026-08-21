import { disconnectPrisma } from './db/prisma';
import { logger } from './lib/logger';
import { startReconcileSchedule, stopReconcileSchedule } from './jobs/reconcile';
import { startSyncWorker, stopSyncWorker } from './sync/worker';

// Standalone worker process: run this instead of the in-web worker by setting
// RUN_WORKER_IN_WEB=false on the web instances.
startSyncWorker();
startReconcileSchedule();

logger.info('worker process started');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
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
