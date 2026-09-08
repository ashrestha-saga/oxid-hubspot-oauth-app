import { Prisma, type CompanyMapping } from '@prisma/client';
import { prisma } from '../prisma';
import type { SyncOrigin } from '../../types';

export type CompanyMappingRow = CompanyMapping;

export const companyMappingsRepo = {
  findById(integrationId: string, id: string): Promise<CompanyMappingRow | null> {
    return prisma.companyMapping.findFirst({ where: { id, integrationId } });
  },

  findByCompanyKey(
    integrationId: string,
    companyKey: string,
  ): Promise<CompanyMappingRow | null> {
    return prisma.companyMapping.findUnique({
      where: { integrationId_companyKey: { integrationId, companyKey } },
    });
  },

  findByHubspotCompanyId(
    integrationId: string,
    hubspotCompanyId: string,
  ): Promise<CompanyMappingRow | null> {
    return prisma.companyMapping.findUnique({
      where: { integrationId_hubspotCompanyId: { integrationId, hubspotCompanyId } },
    });
  },

  async create(input: {
    integrationId: string;
    companyKey: string;
    companyName?: string | null;
    hubspotCompanyId?: string | null;
  }): Promise<CompanyMappingRow> {
    try {
      return await prisma.companyMapping.create({
        data: {
          integrationId: input.integrationId,
          companyKey: input.companyKey,
          companyName: input.companyName ?? null,
          hubspotCompanyId: input.hubspotCompanyId ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findByCompanyKey(input.integrationId, input.companyKey);
        if (existing) return existing;
      }
      throw error;
    }
  },

  async upsertByCompanyKey(input: {
    integrationId: string;
    companyKey: string;
    companyName?: string | null;
    hubspotCompanyId?: string | null;
  }): Promise<CompanyMappingRow> {
    const existing = await this.findByCompanyKey(input.integrationId, input.companyKey);
    if (existing) {
      return prisma.companyMapping.update({
        where: { id: existing.id },
        data: {
          ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
          ...(input.hubspotCompanyId !== undefined
            ? { hubspotCompanyId: input.hubspotCompanyId }
            : {}),
        },
      });
    }
    return this.create(input);
  },

  recordSync(
    integrationId: string,
    id: string,
    input: { hash: string; source: SyncOrigin; at?: Date },
  ): Promise<number> {
    return prisma.companyMapping
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
};
