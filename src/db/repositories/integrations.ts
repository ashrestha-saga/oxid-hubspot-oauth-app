import type { Integration } from '@prisma/client';
import { prisma } from '../prisma';
import { decrypt, encrypt } from '../../lib/crypto';
import { IntegrationNotReadyError } from '../../lib/errors';
import type { IntegrationStatus } from '../../types';

export type IntegrationRow = Integration;

export function toPortalId(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

export interface HubspotInstallInput {
  portalId: string | number | bigint;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  name?: string | null;
}

export interface OxidPairingInput {
  oxidShopId: string;
  oxidBaseUrl: string;
  oxidApiKey: string;
  oxidWebhookSecret: string;
}

export const integrationsRepo = {
  findById(id: string): Promise<IntegrationRow | null> {
    return prisma.integration.findUnique({ where: { id } });
  },

  findByPortalId(portalId: string | number | bigint): Promise<IntegrationRow | null> {
    return prisma.integration.findUnique({ where: { hubspotPortalId: toPortalId(portalId) } });
  },

  findByOxidShopId(oxidShopId: string): Promise<IntegrationRow | null> {
    return prisma.integration.findUnique({ where: { oxidShopId } });
  },

  listActive(): Promise<IntegrationRow[]> {
    return prisma.integration.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } });
  },

  /** HubSpot OAuth done but no OXID shop attached yet (dev bypass target). */
  listAwaitingOxidPairing(): Promise<IntegrationRow[]> {
    return prisma.integration.findMany({
      where: { oxidShopId: null, hubspotAccessToken: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Called at the end of the OAuth callback. Re-installing an already paired
   * portal refreshes the tokens without knocking the integration out of
   * 'active', so a merchant re-authorizing does not stop the sync.
   */
  upsertFromHubspotInstall(input: HubspotInstallInput): Promise<IntegrationRow> {
    const tokens = {
      hubspotAccessToken: encrypt(input.accessToken),
      hubspotRefreshToken: encrypt(input.refreshToken),
      hubspotTokenExpiresAt: input.expiresAt,
    };

    return prisma.integration.upsert({
      where: { hubspotPortalId: toPortalId(input.portalId) },
      create: {
        hubspotPortalId: toPortalId(input.portalId),
        name: input.name ?? null,
        status: 'pending',
        ...tokens,
      },
      update: {
        ...tokens,
        ...(input.name ? { name: input.name } : {}),
      },
    });
  },

  updateHubspotTokens(
    id: string,
    input: { accessToken: string; refreshToken: string; expiresAt: Date },
  ): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        hubspotAccessToken: encrypt(input.accessToken),
        hubspotRefreshToken: encrypt(input.refreshToken),
        hubspotTokenExpiresAt: input.expiresAt,
      },
    });
  },

  /** Completes a pairing: stores the shop credentials and activates the tenant. */
  attachOxidShop(id: string, input: OxidPairingInput): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        oxidShopId: input.oxidShopId,
        oxidBaseUrl: input.oxidBaseUrl,
        oxidApiKey: encrypt(input.oxidApiKey),
        oxidWebhookSecret: encrypt(input.oxidWebhookSecret),
        // A re-pair invalidates any cached bearer token minted from the old key.
        oxidAccessToken: null,
        oxidTokenExpiresAt: null,
        status: 'active',
      },
    });
  },

  updateOxidToken(
    id: string,
    input: { accessToken: string; expiresAt: Date },
  ): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        oxidAccessToken: encrypt(input.accessToken),
        oxidTokenExpiresAt: input.expiresAt,
      },
    });
  },

  clearOxidToken(id: string): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: { oxidAccessToken: null, oxidTokenExpiresAt: null },
    });
  },

  setStatus(id: string, status: IntegrationStatus): Promise<IntegrationRow> {
    return prisma.integration.update({ where: { id }, data: { status } });
  },

  setLastReconciledAt(id: string, at: Date): Promise<IntegrationRow> {
    return prisma.integration.update({ where: { id }, data: { lastReconciledAt: at } });
  },
};

// --- secret accessors -------------------------------------------------------
// Decryption lives next to the repository so no caller ever handles ciphertext.

export function hubspotAccessToken(row: IntegrationRow): string {
  if (!row.hubspotAccessToken) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no HubSpot access token`);
  }
  return decrypt(row.hubspotAccessToken);
}

export function hubspotRefreshToken(row: IntegrationRow): string {
  if (!row.hubspotRefreshToken) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no HubSpot refresh token`);
  }
  return decrypt(row.hubspotRefreshToken);
}

export function oxidApiKey(row: IntegrationRow): string {
  if (!row.oxidApiKey) {
    throw new IntegrationNotReadyError(`integration ${row.id} is not paired with an OXID shop`);
  }
  return decrypt(row.oxidApiKey);
}

export function oxidAccessToken(row: IntegrationRow): string | null {
  return row.oxidAccessToken ? decrypt(row.oxidAccessToken) : null;
}

export function oxidWebhookSecret(row: IntegrationRow): string {
  if (!row.oxidWebhookSecret) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no OXID webhook secret`);
  }
  return decrypt(row.oxidWebhookSecret);
}

export function oxidBaseUrl(row: IntegrationRow): string {
  if (!row.oxidBaseUrl) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no OXID base URL`);
  }
  return row.oxidBaseUrl.replace(/\/+$/, '');
}
