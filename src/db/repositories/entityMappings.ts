import type { EntityMapping } from '@prisma/client';
import { prisma } from '../prisma';
import type { SyncOrigin } from '../../types';

export type EntityMappingRow = EntityMapping;

/**
 * Every method takes `integrationId` first: mappings are strictly tenant-scoped
 * and a lookup must never be able to reach another tenant's row.
 */
export const entityMappingsRepo = {
  findById(integrationId: string, id: string): Promise<EntityMappingRow | null> {
    return prisma.entityMapping.findFirst({ where: { id, integrationId } });
  },

  findByHubspotContactId(
    integrationId: string,
    hubspotContactId: string,
  ): Promise<EntityMappingRow | null> {
    return prisma.entityMapping.findUnique({
      where: { integrationId_hubspotContactId: { integrationId, hubspotContactId } },
    });
  },

  findByOxidCustomerId(
    integrationId: string,
    oxidCustomerId: string,
  ): Promise<EntityMappingRow | null> {
    return prisma.entityMapping.findUnique({
      where: { integrationId_oxidCustomerId: { integrationId, oxidCustomerId } },
    });
  },

  create(input: {
    integrationId: string;
    hubspotContactId?: string | null;
    oxidCustomerId?: string | null;
  }): Promise<EntityMappingRow> {
    return prisma.entityMapping.create({
      data: {
        integrationId: input.integrationId,
        hubspotContactId: input.hubspotContactId ?? null,
        oxidCustomerId: input.oxidCustomerId ?? null,
      },
    });
  },

  /** Fills in whichever side was still unknown once the counterpart is created. */
  linkCounterpart(
    integrationId: string,
    id: string,
    input: { hubspotContactId?: string | null; oxidCustomerId?: string | null },
  ): Promise<number> {
    return prisma.entityMapping
      .updateMany({
        where: { id, integrationId },
        data: {
          ...(input.hubspotContactId !== undefined
            ? { hubspotContactId: input.hubspotContactId }
            : {}),
          ...(input.oxidCustomerId !== undefined ? { oxidCustomerId: input.oxidCustomerId } : {}),
        },
      })
      .then((result) => result.count);
  },

  recordSync(
    integrationId: string,
    id: string,
    input: { hash: string; source: SyncOrigin; at?: Date },
  ): Promise<number> {
    return prisma.entityMapping
      .updateMany({
        where: { id, integrationId },
        data: {
          lastSyncedHash: input.hash,
          sourceOfLastWrite: input.source,
          lastSyncedAt: input.at ?? new Date(),
        },
      })
      .then((result) => result.count);
  },

  listByIntegration(integrationId: string): Promise<EntityMappingRow[]> {
    return prisma.entityMapping.findMany({
      where: { integrationId },
      orderBy: { createdAt: 'asc' },
    });
  },

  delete(integrationId: string, id: string): Promise<number> {
    return prisma.entityMapping
      .deleteMany({ where: { id, integrationId } })
      .then((result) => result.count);
  },
};
