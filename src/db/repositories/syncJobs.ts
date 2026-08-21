import type { Prisma, SyncJob } from '@prisma/client';
import { prisma } from '../prisma';
import type { SyncDirection } from '../../types';

export type SyncJobRow = SyncJob;

export interface EnqueueInput {
  integrationId: string;
  direction: SyncDirection;
  /** Identifies the record, e.g. `hubspot_to_oxid:12345`. Collapses duplicates. */
  dedupeKey: string;
  payload: Prisma.InputJsonValue;
  runAfter?: Date;
}

const BASE_RETRY_DELAY_MS = 5_000;

export function backoffDelayMs(attempts: number): number {
  // 5s, 20s, 45s, 80s, ... capped at 10 minutes.
  return Math.min(BASE_RETRY_DELAY_MS * attempts * attempts, 10 * 60 * 1000);
}

export const syncJobsRepo = {
  /**
   * Enqueues work, folding into an existing pending job for the same record if
   * one is waiting - a contact edited five times in a row only needs one sync,
   * and the payload is refreshed from the destination anyway.
   */
  async enqueue(input: EnqueueInput): Promise<{ jobId: string; deduped: boolean }> {
    const existing = await prisma.syncJob.findFirst({
      where: {
        integrationId: input.integrationId,
        dedupeKey: input.dedupeKey,
        status: 'pending',
      },
      orderBy: { createdAt: 'asc' },
    });

    if (existing) {
      await prisma.syncJob.update({
        where: { id: existing.id },
        data: { payload: input.payload, runAfter: input.runAfter ?? new Date() },
      });
      return { jobId: existing.id, deduped: true };
    }

    const created = await prisma.syncJob.create({
      data: {
        integrationId: input.integrationId,
        direction: input.direction,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        ...(input.runAfter ? { runAfter: input.runAfter } : {}),
      },
    });
    return { jobId: created.id, deduped: false };
  },

  /**
   * Claims the next due job for this worker.
   *
   * Portable across SQLite and Postgres: runs inside a transaction, walks the
   * oldest due candidates, skips any whose dedupe key is already processing, and
   * claims with `updateMany … WHERE status = 'pending'` so two workers racing
   * the same row leave one with `count === 0` and it tries the next candidate.
   */
  async claimNext(workerId: string, now = new Date()): Promise<SyncJobRow | null> {
    return prisma.$transaction(async (tx) => {
      const candidates = await tx.syncJob.findMany({
        where: { status: 'pending', runAfter: { lte: now } },
        orderBy: [{ runAfter: 'asc' }, { createdAt: 'asc' }],
        take: 25,
      });

      for (const candidate of candidates) {
        const blocked = await tx.syncJob.findFirst({
          where: {
            status: 'processing',
            integrationId: candidate.integrationId,
            dedupeKey: candidate.dedupeKey,
          },
          select: { id: true },
        });
        if (blocked) continue;

        const claimed = await tx.syncJob.updateMany({
          where: { id: candidate.id, status: 'pending' },
          data: {
            status: 'processing',
            lockedAt: now,
            lockedBy: workerId,
            attempts: { increment: 1 },
            updatedAt: now,
          },
        });
        if (claimed.count !== 1) continue;

        return tx.syncJob.findUnique({ where: { id: candidate.id } });
      }

      return null;
    });
  },

  markDone(id: string): Promise<SyncJobRow> {
    return prisma.syncJob.update({
      where: { id },
      data: { status: 'done', lastError: null, lockedAt: null, lockedBy: null },
    });
  },

  /** Schedules a retry, or gives up once `maxAttempts` is reached. */
  async markFailed(
    id: string,
    error: string,
    options: { maxAttempts: number; retryable: boolean },
  ): Promise<SyncJobRow> {
    const job = await prisma.syncJob.findUniqueOrThrow({ where: { id } });
    const exhausted = job.attempts >= options.maxAttempts;
    const giveUp = exhausted || !options.retryable;

    return prisma.syncJob.update({
      where: { id },
      data: {
        status: giveUp ? 'failed' : 'pending',
        lastError: error.slice(0, 4000),
        lockedAt: null,
        lockedBy: null,
        ...(giveUp ? {} : { runAfter: new Date(Date.now() + backoffDelayMs(job.attempts)) }),
      },
    });
  },

  /** Returns jobs whose worker died mid-flight to the pending pool. */
  async reclaimStale(olderThanMs: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanMs);
    const result = await prisma.syncJob.updateMany({
      where: { status: 'processing', lockedAt: { lt: cutoff } },
      data: { status: 'pending', lockedAt: null, lockedBy: null },
    });
    return result.count;
  },

  countByStatus(): Promise<Array<{ status: string; count: number }>> {
    return prisma.syncJob
      .groupBy({ by: ['status'], _count: { _all: true } })
      .then((rows) => rows.map((row) => ({ status: row.status, count: row._count._all })));
  },

  findById(id: string): Promise<SyncJobRow | null> {
    return prisma.syncJob.findUnique({ where: { id } });
  },

  deleteCompletedBefore(cutoff: Date): Promise<number> {
    return prisma.syncJob
      .deleteMany({ where: { status: 'done', updatedAt: { lt: cutoff } } })
      .then((result) => result.count);
  },
};
