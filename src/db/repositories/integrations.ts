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

export interface OxidOAuthCredentialsInput {
  oxidBaseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface OxidOAuthCompleteInput {
  oxidShopId: string;
  oxidBaseUrl: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  webhookSecret: string;
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

  /** Persists shop URL + OAuth client creds before redirecting to OXID authorize. */
  saveOxidOAuthCredentials(id: string, input: OxidOAuthCredentialsInput): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        oxidBaseUrl: input.oxidBaseUrl,
        oxidOAuthClientId: encrypt(input.clientId),
        oxidOAuthClientSecret: encrypt(input.clientSecret),
      },
    });
  },

  /** Completes OXID OAuth: stores tokens, webhook secret, activates tenant. */
  attachOxidFromOAuth(id: string, input: OxidOAuthCompleteInput): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        oxidShopId: input.oxidShopId,
        oxidBaseUrl: input.oxidBaseUrl,
        oxidOAuthClientId: encrypt(input.clientId),
        oxidOAuthClientSecret: encrypt(input.clientSecret),
        oxidAccessToken: encrypt(input.accessToken),
        oxidRefreshToken: encrypt(input.refreshToken),
        oxidTokenExpiresAt: input.expiresAt,
        oxidWebhookSecret: encrypt(input.webhookSecret),
        status: 'active',
      },
    });
  },

  updateOxidTokens(
    id: string,
    input: { accessToken: string; refreshToken: string; expiresAt: Date },
  ): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        oxidAccessToken: encrypt(input.accessToken),
        oxidRefreshToken: encrypt(input.refreshToken),
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

  saveFieldMapping(
    id: string,
    input: {
      fieldMappingJson: string;
      mappingStatus: 'default' | 'custom';
      samplePayloadJson?: string | null;
    },
  ): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: {
        fieldMappingJson: input.fieldMappingJson,
        mappingStatus: input.mappingStatus,
        ...(input.samplePayloadJson !== undefined
          ? { samplePayloadJson: input.samplePayloadJson }
          : {}),
      },
    });
  },

  saveSamplePayload(id: string, samplePayloadJson: string): Promise<IntegrationRow> {
    return prisma.integration.update({
      where: { id },
      data: { samplePayloadJson },
    });
  },
};

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

export function oxidOAuthClientId(row: IntegrationRow): string {
  if (!row.oxidOAuthClientId) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no OXID OAuth client id`);
  }
  return decrypt(row.oxidOAuthClientId);
}

export function oxidOAuthClientSecret(row: IntegrationRow): string {
  if (!row.oxidOAuthClientSecret) {
    throw new IntegrationNotReadyError(`integration ${row.id} has no OXID OAuth client secret`);
  }
  return decrypt(row.oxidOAuthClientSecret);
}

export function oxidAccessToken(row: IntegrationRow): string | null {
  return row.oxidAccessToken ? decrypt(row.oxidAccessToken) : null;
}

export function oxidRefreshToken(row: IntegrationRow): string {
  if (!row.oxidRefreshToken) {
    throw new IntegrationNotReadyError(`integration ${row.id} is not connected to an OXID shop`);
  }
  return decrypt(row.oxidRefreshToken);
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

export function isOxidOAuthConnected(row: IntegrationRow): boolean {
  return row.status === 'active' && row.oxidRefreshToken !== null;
}
