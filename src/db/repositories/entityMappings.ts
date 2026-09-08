import { Prisma, type EntityMapping } from '@prisma/client';
import { prisma } from '../prisma';
import type { SyncOrigin } from '../../types';

export type EntityMappingRow = EntityMapping;

export type EntityMappingLinkInput = {
  hubspotContactId?: string | null;
  oxidCustomerId?: string | null;
  oxidRecordId?: string | null;
};

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

  findByOxidRecordId(
    integrationId: string,
    oxidRecordId: string,
  ): Promise<EntityMappingRow | null> {
    return prisma.entityMapping.findUnique({
      where: { integrationId_oxidRecordId: { integrationId, oxidRecordId } },
    });
  },

  create(input: {
    integrationId: string;
    hubspotContactId?: string | null;
    oxidCustomerId?: string | null;
    oxidRecordId?: string | null;
  }): Promise<EntityMappingRow> {
    return prisma.entityMapping.create({
      data: {
        integrationId: input.integrationId,
        hubspotContactId: input.hubspotContactId ?? null,
        oxidCustomerId: input.oxidCustomerId ?? null,
        oxidRecordId: input.oxidRecordId ?? null,
      },
    });
  },

  /**
   * Absorbs `absorbId` into `keepId` (same integration), clearing unique keys on
   * the absorbed row first so MySQL does not reject the merge.
   */
  async mergeMappings(
    integrationId: string,
    keepId: string,
    absorbId: string,
  ): Promise<EntityMappingRow> {
    if (keepId === absorbId) {
      const same = await this.findById(integrationId, keepId);
      if (!same) throw new Error(`entity mapping ${keepId} not found`);
      return same;
    }

    return prisma.$transaction(async (tx) => {
      const keep = await tx.entityMapping.findFirst({
        where: { id: keepId, integrationId },
      });
      const absorb = await tx.entityMapping.findFirst({
        where: { id: absorbId, integrationId },
      });
      if (!keep || !absorb) {
        throw new Error(`cannot merge mappings ${keepId} <- ${absorbId}`);
      }

      // Free unique slots on the row we are about to delete.
      await tx.entityMapping.update({
        where: { id: absorb.id },
        data: { hubspotContactId: null, oxidCustomerId: null, oxidRecordId: null },
      });

      const merged = await tx.entityMapping.update({
        where: { id: keep.id },
        data: {
          hubspotContactId: keep.hubspotContactId ?? absorb.hubspotContactId,
          oxidCustomerId: keep.oxidCustomerId ?? absorb.oxidCustomerId,
          oxidRecordId: keep.oxidRecordId ?? absorb.oxidRecordId,
          lastSyncedAt: keep.lastSyncedAt ?? absorb.lastSyncedAt,
          lastSyncedHash: keep.lastSyncedHash ?? absorb.lastSyncedHash,
          sourceOfLastWrite: keep.sourceOfLastWrite ?? absorb.sourceOfLastWrite,
        },
      });

      await tx.entityMapping.delete({ where: { id: absorb.id } });
      return merged;
    });
  },

  /** Fills in whichever side was still unknown once the counterpart is created. */
  async linkCounterpart(
    integrationId: string,
    id: string,
    input: EntityMappingLinkInput,
  ): Promise<EntityMappingRow> {
    const data = {
      ...(input.hubspotContactId !== undefined ? { hubspotContactId: input.hubspotContactId } : {}),
      ...(input.oxidCustomerId !== undefined ? { oxidCustomerId: input.oxidCustomerId } : {}),
      ...(input.oxidRecordId !== undefined ? { oxidRecordId: input.oxidRecordId } : {}),
    };

    try {
      await prisma.entityMapping.updateMany({
        where: { id, integrationId },
        data,
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }

      // Another mapping already owns one of the unique remote ids — merge it in.
      let keepId = id;
      if (input.oxidCustomerId) {
        const other = await this.findByOxidCustomerId(integrationId, input.oxidCustomerId);
        if (other && other.id !== keepId) {
          await this.mergeMappings(integrationId, keepId, other.id);
        }
      }
      if (input.hubspotContactId) {
        const other = await this.findByHubspotContactId(integrationId, input.hubspotContactId);
        if (other && other.id !== keepId) {
          await this.mergeMappings(integrationId, keepId, other.id);
        }
      }
      if (input.oxidRecordId) {
        const other = await this.findByOxidRecordId(integrationId, input.oxidRecordId);
        if (other && other.id !== keepId) {
          await this.mergeMappings(integrationId, keepId, other.id);
        }
      }

      await prisma.entityMapping.updateMany({
        where: { id: keepId, integrationId },
        data,
      });
    }

    const linked = await this.findById(integrationId, id);
    if (!linked) throw new Error(`entity mapping ${id} not found after link`);
    return linked;
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
