import type { PairingRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { toPortalId } from './integrations';

export type PairingRequestRow = PairingRequest;

export const pairingRequestsRepo = {
  create(input: {
    token: string;
    portalId: string | number | bigint;
    oxidShopUrl: string;
    expiresAt: Date;
  }): Promise<PairingRequestRow> {
    return prisma.pairingRequest.create({
      data: {
        token: input.token,
        hubspotPortalId: toPortalId(input.portalId),
        oxidShopUrl: input.oxidShopUrl,
        expiresAt: input.expiresAt,
      },
    });
  },

  findByToken(token: string): Promise<PairingRequestRow | null> {
    return prisma.pairingRequest.findUnique({ where: { token } });
  },

  /**
   * Atomically claims a pairing token. The `used: false` + `expiresAt` predicates
   * are part of the UPDATE, so two concurrent callbacks with the same token can
   * never both succeed - the loser updates 0 rows and gets null back.
   */
  async consume(token: string, now = new Date()): Promise<PairingRequestRow | null> {
    const result = await prisma.pairingRequest.updateMany({
      where: { token, used: false, expiresAt: { gt: now } },
      data: { used: true },
    });
    if (result.count === 0) return null;
    return prisma.pairingRequest.findUnique({ where: { token } });
  },

  deleteExpired(now = new Date()): Promise<number> {
    return prisma.pairingRequest
      .deleteMany({ where: { expiresAt: { lt: now } } })
      .then((result) => result.count);
  },
};
