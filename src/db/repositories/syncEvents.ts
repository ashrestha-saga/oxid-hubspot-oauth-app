import type { Prisma, SyncEvent } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../../lib/logger';
import type { SyncDirection, SyncEventStatus } from '../../types';

export type SyncEventRow = SyncEvent;

export interface SyncEventInput {
  integrationId: string | null;
  direction: SyncDirection;
  entityMappingId?: string | null;
  status: SyncEventStatus;
  detail?: Prisma.InputJsonValue;
}

export const syncEventsRepo = {
  /**
   * Audit logging must never take the sync down with it, so a failed insert is
   * logged and swallowed rather than propagated.
   */
  async log(input: SyncEventInput): Promise<void> {
    try {
      await prisma.syncEvent.create({
        data: {
          integrationId: input.integrationId,
          direction: input.direction,
          entityMappingId: input.entityMappingId ?? null,
          status: input.status,
          detail: input.detail ?? undefined,
        },
      });
    } catch (error) {
      logger.error({ err: error, event: input }, 'failed to write sync_event');
    }
  },

  listForIntegration(
    integrationId: string,
    options: { limit?: number; status?: SyncEventStatus } = {},
  ): Promise<SyncEventRow[]> {
    return prisma.syncEvent.findMany({
      where: { integrationId, ...(options.status ? { status: options.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 100,
    });
  },
};
