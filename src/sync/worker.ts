import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { env } from '../config/env';
import { syncJobsRepo, type SyncJobRow } from '../db/repositories/syncJobs';
import { isAppError, describeError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { SyncDirection } from '../types';
import { syncContact, type SourceRecord, type SyncContactResult } from './syncContact';

/** Jobs whose worker died are returned to the pool after this long. */
const STALE_LOCK_MS = 5 * 60 * 1000;

export interface WorkerOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** Jobs to drain per tick before yielding. */
  batchSize?: number;
}

export class SyncWorker {
  readonly id = `${hostname()}-${randomUUID().slice(0, 8)}`;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(options: WorkerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? env.SYNC_WORKER_POLL_MS;
    this.maxAttempts = options.maxAttempts ?? env.SYNC_JOB_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? 10;
  }

  start(): void {
    if (this.timer) return;
    logger.info({ workerId: this.id, pollIntervalMs: this.pollIntervalMs }, 'sync worker started');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Never hold the event loop open just to poll an empty queue.
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight job finish rather than abandoning it mid-write.
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** One polling pass. Returns how many jobs were processed. */
  async tick(): Promise<number> {
    if (this.ticking || this.stopped) return 0;
    this.ticking = true;

    try {
      const reclaimed = await syncJobsRepo.reclaimStale(STALE_LOCK_MS);
      if (reclaimed > 0) logger.warn({ reclaimed }, 'reclaimed stale sync jobs');

      let processed = 0;
      for (let i = 0; i < this.batchSize; i += 1) {
        const job = await syncJobsRepo.claimNext(this.id);
        if (!job) break;
        await this.process(job);
        processed += 1;
      }
      return processed;
    } catch (error) {
      logger.error({ err: error }, 'sync worker tick failed');
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  private async process(job: SyncJobRow): Promise<SyncContactResult | null> {
    const sourceRecord = job.payload as unknown as SourceRecord;

    try {
      const result = await syncContact({
        integrationId: job.integrationId,
        direction: job.direction as SyncDirection,
        sourceRecord,
      });
      await syncJobsRepo.markDone(job.id);
      return result;
    } catch (error) {
      const described = describeError(error);
      // Transient failures (429, 5xx, network) are worth another attempt;
      // a malformed record or revoked token is not.
      const retryable = isAppError(error) ? error.retryable : true;

      const updated = await syncJobsRepo.markFailed(job.id, described.message, {
        maxAttempts: this.maxAttempts,
        retryable,
      });

      logger.error(
        {
          err: error,
          jobId: job.id,
          integrationId: job.integrationId,
          attempts: updated.attempts,
          status: updated.status,
          retryable,
        },
        'sync job failed',
      );
      return null;
    }
  }
}

let singleton: SyncWorker | null = null;

export function startSyncWorker(options?: WorkerOptions): SyncWorker {
  if (!singleton) {
    singleton = new SyncWorker(options);
    singleton.start();
  }
  return singleton;
}

export async function stopSyncWorker(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}
