import { randomUUID } from 'node:crypto';
import type { EntityMappingRow } from '../../src/db/repositories/entityMappings';
import type { IntegrationRow } from '../../src/db/repositories/integrations';
import type { SyncEventInput } from '../../src/db/repositories/syncEvents';
import type { EnqueueInput, SyncJobRow } from '../../src/db/repositories/syncJobs';
import { encrypt } from '../../src/lib/crypto';
import type { IntegrationStatus } from '../../src/types';

export interface SyncEventRecord extends SyncEventInput {
  id: string;
  createdAt: Date;
}

const state = {
  integrations: [] as IntegrationRow[],
  mappings: [] as EntityMappingRow[],
  events: [] as SyncEventRecord[],
  jobs: [] as SyncJobRow[],
};

export function resetFakeDb(): void {
  state.integrations = [];
  state.mappings = [];
  state.events = [];
  state.jobs = [];
}

export const fakeState = state;

export interface IntegrationFixture {
  portalId: string | number | bigint;
  status?: IntegrationStatus;
  oxidShopId?: string | null;
  oxidBaseUrl?: string | null;
  oxidOAuthClientId?: string | null;
  oxidOAuthClientSecret?: string | null;
  oxidAccessToken?: string | null;
  oxidRefreshToken?: string | null;
  oxidTokenExpiresAt?: Date | null;
  oxidWebhookSecret?: string | null;
  hubspotAccessToken?: string | null;
  hubspotRefreshToken?: string | null;
  hubspotTokenExpiresAt?: Date | null;
  lastReconciledAt?: Date | null;
}

function baseIntegrationRow(partial: Partial<IntegrationRow>): IntegrationRow {
  const now = new Date();
  return {
    id: randomUUID(),
    name: null,
    hubspotPortalId: null,
    hubspotAccessToken: null,
    hubspotRefreshToken: null,
    hubspotTokenExpiresAt: null,
    oxidShopId: null,
    oxidShopName: null,
    oxidBaseUrl: null,
    oxidOAuthClientId: null,
    oxidOAuthClientSecret: null,
    oxidAccessToken: null,
    oxidRefreshToken: null,
    oxidTokenExpiresAt: null,
    oxidWebhookSecret: null,
    fieldMappingJson: null,
    samplePayloadJson: null,
    mappingStatus: 'default',
    status: 'pending',
    lastReconciledAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export function addIntegration(fixture: IntegrationFixture): IntegrationRow {
  const now = new Date();
  const row = baseIntegrationRow({
    name: `portal-${fixture.portalId}`,
    hubspotPortalId: BigInt(fixture.portalId),
    hubspotAccessToken: fixture.hubspotAccessToken
      ? encrypt(fixture.hubspotAccessToken)
      : encrypt('test-access-token'),
    hubspotRefreshToken: fixture.hubspotRefreshToken
      ? encrypt(fixture.hubspotRefreshToken)
      : encrypt('test-refresh-token'),
    hubspotTokenExpiresAt:
      fixture.hubspotTokenExpiresAt ?? new Date(now.getTime() + 60 * 60 * 1000),
    oxidShopId: fixture.oxidShopId === null ? null : (fixture.oxidShopId ?? randomUUID()),
    oxidBaseUrl: fixture.oxidBaseUrl ?? 'https://shop.example.com',
    oxidOAuthClientId:
      fixture.oxidOAuthClientId === null
        ? null
        : encrypt(fixture.oxidOAuthClientId ?? 'shop-client-id'),
    oxidOAuthClientSecret:
      fixture.oxidOAuthClientSecret === null
        ? null
        : encrypt(fixture.oxidOAuthClientSecret ?? 'shop-client-secret'),
    oxidAccessToken: fixture.oxidAccessToken ? encrypt(fixture.oxidAccessToken) : null,
    oxidRefreshToken:
      fixture.oxidRefreshToken === null
        ? null
        : encrypt(fixture.oxidRefreshToken ?? 'shop-refresh-token'),
    oxidTokenExpiresAt: fixture.oxidTokenExpiresAt ?? new Date(now.getTime() + 3600 * 1000),
    oxidWebhookSecret:
      fixture.oxidWebhookSecret === null
        ? null
        : encrypt(fixture.oxidWebhookSecret ?? 'shop-webhook-secret'),
    status: fixture.status ?? 'active',
    lastReconciledAt: fixture.lastReconciledAt ?? null,
  });

  state.integrations.push(row);
  return row;
}

export const fakeIntegrationsRepo = {
  async findById(id: string) {
    return state.integrations.find((row) => row.id === id) ?? null;
  },
  async findByPortalId(portalId: string | number | bigint) {
    const wanted = BigInt(portalId);
    return state.integrations.find((row) => row.hubspotPortalId === wanted) ?? null;
  },
  async findByOxidShopId(oxidShopId: string) {
    return state.integrations.find((row) => row.oxidShopId === oxidShopId) ?? null;
  },
  async listActive() {
    return state.integrations.filter((row) => row.status === 'active');
  },
  async upsertFromHubspotInstall(input: {
    portalId: string | number | bigint;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    name?: string | null;
  }) {
    const existing = await fakeIntegrationsRepo.findByPortalId(input.portalId);
    if (existing) {
      existing.hubspotAccessToken = encrypt(input.accessToken);
      existing.hubspotRefreshToken = encrypt(input.refreshToken);
      existing.hubspotTokenExpiresAt = input.expiresAt;
      if (input.name) existing.name = input.name;
      return existing;
    }

    const row = baseIntegrationRow({
      name: input.name ?? null,
      hubspotPortalId: BigInt(input.portalId),
      hubspotAccessToken: encrypt(input.accessToken),
      hubspotRefreshToken: encrypt(input.refreshToken),
      hubspotTokenExpiresAt: input.expiresAt,
      status: 'pending',
    });
    state.integrations.push(row);
    return row;
  },
  async updateHubspotTokens(
    id: string,
    input: { accessToken: string; refreshToken: string; expiresAt: Date },
  ) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.hubspotAccessToken = encrypt(input.accessToken);
    row.hubspotRefreshToken = encrypt(input.refreshToken);
    row.hubspotTokenExpiresAt = input.expiresAt;
    return row;
  },
  async saveOxidOAuthCredentials(
    id: string,
    input: { oxidBaseUrl: string; clientId: string; clientSecret: string },
  ) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.oxidBaseUrl = input.oxidBaseUrl;
    row.oxidOAuthClientId = encrypt(input.clientId);
    row.oxidOAuthClientSecret = encrypt(input.clientSecret);
    return row;
  },
  async attachOxidFromOAuth(
    id: string,
    input: {
      oxidShopId: string;
      oxidShopName?: string | null;
      oxidBaseUrl: string;
      clientId: string;
      clientSecret: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
      webhookSecret: string;
    },
  ) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.oxidShopId = input.oxidShopId;
    if (input.oxidShopName !== undefined) {
      row.oxidShopName = input.oxidShopName;
    }
    row.oxidBaseUrl = input.oxidBaseUrl;
    row.oxidOAuthClientId = encrypt(input.clientId);
    row.oxidOAuthClientSecret = encrypt(input.clientSecret);
    row.oxidAccessToken = encrypt(input.accessToken);
    row.oxidRefreshToken = encrypt(input.refreshToken);
    row.oxidTokenExpiresAt = input.expiresAt;
    row.oxidWebhookSecret = encrypt(input.webhookSecret);
    row.status = 'active';
    return row;
  },
  async updateOxidTokens(
    id: string,
    input: { accessToken: string; refreshToken: string; expiresAt: Date },
  ) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.oxidAccessToken = encrypt(input.accessToken);
    row.oxidRefreshToken = encrypt(input.refreshToken);
    row.oxidTokenExpiresAt = input.expiresAt;
    return row;
  },
  async clearOxidToken(id: string) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.oxidAccessToken = null;
    row.oxidTokenExpiresAt = null;
    return row;
  },
  async setStatus(id: string, status: IntegrationStatus) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.status = status;
    return row;
  },
  async setLastReconciledAt(id: string, at: Date) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.lastReconciledAt = at;
    return row;
  },
  async saveFieldMapping(
    id: string,
    input: {
      fieldMappingJson: string;
      mappingStatus: 'default' | 'custom';
      samplePayloadJson?: string | null;
    },
  ) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.fieldMappingJson = input.fieldMappingJson;
    row.mappingStatus = input.mappingStatus;
    if (input.samplePayloadJson !== undefined) {
      row.samplePayloadJson = input.samplePayloadJson;
    }
    return row;
  },
  async saveSamplePayload(id: string, samplePayloadJson: string) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.samplePayloadJson = samplePayloadJson;
    return row;
  },
};

export const fakeEntityMappingsRepo = {
  async findById(integrationId: string, id: string) {
    return (
      state.mappings.find((row) => row.id === id && row.integrationId === integrationId) ?? null
    );
  },
  async findByHubspotContactId(integrationId: string, hubspotContactId: string) {
    return (
      state.mappings.find(
        (row) => row.integrationId === integrationId && row.hubspotContactId === hubspotContactId,
      ) ?? null
    );
  },
  async findByOxidCustomerId(integrationId: string, oxidCustomerId: string) {
    return (
      state.mappings.find(
        (row) => row.integrationId === integrationId && row.oxidCustomerId === oxidCustomerId,
      ) ?? null
    );
  },
  async create(input: {
    integrationId: string;
    hubspotContactId?: string | null;
    oxidCustomerId?: string | null;
    oxidRecordId?: string | null;
  }) {
    const now = new Date();
    // Simulate unique constraints used in production.
    if (input.hubspotContactId) {
      const clash = state.mappings.find(
        (row) =>
          row.integrationId === input.integrationId &&
          row.hubspotContactId === input.hubspotContactId,
      );
      if (clash) {
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
    }
    if (input.oxidCustomerId) {
      const clash = state.mappings.find(
        (row) =>
          row.integrationId === input.integrationId && row.oxidCustomerId === input.oxidCustomerId,
      );
      if (clash) {
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
    }
    const row: EntityMappingRow = {
      id: randomUUID(),
      integrationId: input.integrationId,
      hubspotContactId: input.hubspotContactId ?? null,
      oxidCustomerId: input.oxidCustomerId ?? null,
      oxidRecordId: input.oxidRecordId ?? null,
      lastSyncedAt: null,
      lastSyncedHash: null,
      sourceOfLastWrite: null,
      createdAt: now,
      updatedAt: now,
    };
    state.mappings.push(row);
    return row;
  },
  async mergeMappings(integrationId: string, keepId: string, absorbId: string) {
    if (keepId === absorbId) {
      const same = await fakeEntityMappingsRepo.findById(integrationId, keepId);
      if (!same) throw new Error(`entity mapping ${keepId} not found`);
      return same;
    }
    const keep = await fakeEntityMappingsRepo.findById(integrationId, keepId);
    const absorb = await fakeEntityMappingsRepo.findById(integrationId, absorbId);
    if (!keep || !absorb) throw new Error(`cannot merge mappings ${keepId} <- ${absorbId}`);

    keep.hubspotContactId = keep.hubspotContactId ?? absorb.hubspotContactId;
    keep.oxidCustomerId = keep.oxidCustomerId ?? absorb.oxidCustomerId;
    keep.oxidRecordId = keep.oxidRecordId ?? absorb.oxidRecordId;
    keep.lastSyncedAt = keep.lastSyncedAt ?? absorb.lastSyncedAt;
    keep.lastSyncedHash = keep.lastSyncedHash ?? absorb.lastSyncedHash;
    keep.sourceOfLastWrite = keep.sourceOfLastWrite ?? absorb.sourceOfLastWrite;
    keep.updatedAt = new Date();

    state.mappings = state.mappings.filter((row) => row.id !== absorb.id);
    return keep;
  },
  async linkCounterpart(
    integrationId: string,
    id: string,
    input: {
      hubspotContactId?: string | null;
      oxidCustomerId?: string | null;
      oxidRecordId?: string | null;
    },
  ) {
    const row = await fakeEntityMappingsRepo.findById(integrationId, id);
    if (!row) throw new Error(`entity mapping ${id} not found`);

    let keep = row;
    if (input.oxidCustomerId) {
      const other = state.mappings.find(
        (entry) =>
          entry.integrationId === integrationId &&
          entry.id !== keep.id &&
          entry.oxidCustomerId === input.oxidCustomerId,
      );
      if (other) keep = await fakeEntityMappingsRepo.mergeMappings(integrationId, keep.id, other.id);
    }
    if (input.hubspotContactId) {
      const other = state.mappings.find(
        (entry) =>
          entry.integrationId === integrationId &&
          entry.id !== keep.id &&
          entry.hubspotContactId === input.hubspotContactId,
      );
      if (other) keep = await fakeEntityMappingsRepo.mergeMappings(integrationId, keep.id, other.id);
    }
    if (input.oxidRecordId) {
      const other = state.mappings.find(
        (entry) =>
          entry.integrationId === integrationId &&
          entry.id !== keep.id &&
          entry.oxidRecordId === input.oxidRecordId,
      );
      if (other) keep = await fakeEntityMappingsRepo.mergeMappings(integrationId, keep.id, other.id);
    }

    if (input.hubspotContactId !== undefined) keep.hubspotContactId = input.hubspotContactId;
    if (input.oxidCustomerId !== undefined) keep.oxidCustomerId = input.oxidCustomerId;
    if (input.oxidRecordId !== undefined) keep.oxidRecordId = input.oxidRecordId;
    keep.updatedAt = new Date();
    return keep;
  },
  async findByOxidRecordId(integrationId: string, oxidRecordId: string) {
    return (
      state.mappings.find(
        (row) => row.integrationId === integrationId && row.oxidRecordId === oxidRecordId,
      ) ?? null
    );
  },
  async recordSync(
    integrationId: string,
    id: string,
    input: { hash: string; source: 'hubspot' | 'oxid'; at?: Date },
  ) {
    const row = await fakeEntityMappingsRepo.findById(integrationId, id);
    if (!row) return 0;
    row.lastSyncedHash = input.hash;
    row.sourceOfLastWrite = input.source;
    row.lastSyncedAt = input.at ?? new Date();
    return 1;
  },
  async listByIntegration(integrationId: string) {
    return state.mappings.filter((row) => row.integrationId === integrationId);
  },
  async delete(integrationId: string, id: string) {
    const before = state.mappings.length;
    state.mappings = state.mappings.filter(
      (row) => !(row.id === id && row.integrationId === integrationId),
    );
    return before - state.mappings.length;
  },
};

export const fakeSyncEventsRepo = {
  async log(input: SyncEventInput) {
    state.events.push({ ...input, id: randomUUID(), createdAt: new Date() });
  },
  async listForIntegration(integrationId: string) {
    return state.events.filter((row) => row.integrationId === integrationId);
  },
};

export const fakeSyncJobsRepo = {
  async enqueue(input: EnqueueInput) {
    const existing = state.jobs.find(
      (row) =>
        row.integrationId === input.integrationId &&
        row.dedupeKey === input.dedupeKey &&
        row.status === 'pending',
    );

    if (existing) {
      existing.payload = input.payload as SyncJobRow['payload'];
      existing.runAfter = input.runAfter ?? new Date();
      return { jobId: existing.id, deduped: true };
    }

    const now = new Date();
    const row: SyncJobRow = {
      id: randomUUID(),
      integrationId: input.integrationId,
      direction: input.direction,
      dedupeKey: input.dedupeKey,
      payload: input.payload as SyncJobRow['payload'],
      status: 'pending',
      attempts: 0,
      runAfter: input.runAfter ?? now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    state.jobs.push(row);
    return { jobId: row.id, deduped: false };
  },
  async claimNext(workerId: string, now = new Date()) {
    const busyKeys = new Set(
      state.jobs
        .filter((row) => row.status === 'processing')
        .map((row) => `${row.integrationId}:${row.dedupeKey}`),
    );

    const job = state.jobs
      .filter(
        (row) =>
          row.status === 'pending' &&
          row.runAfter <= now &&
          !busyKeys.has(`${row.integrationId}:${row.dedupeKey}`),
      )
      .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())[0];

    if (!job) return null;
    job.status = 'processing';
    job.lockedAt = now;
    job.lockedBy = workerId;
    job.attempts += 1;
    return job;
  },
  async markDone(id: string) {
    const job = state.jobs.find((row) => row.id === id);
    if (!job) throw new Error(`no job ${id}`);
    job.status = 'done';
    job.lockedAt = null;
    job.lockedBy = null;
    job.lastError = null;
    return job;
  },
  async markFailed(id: string, error: string, options: { maxAttempts: number; retryable: boolean }) {
    const job = state.jobs.find((row) => row.id === id);
    if (!job) throw new Error(`no job ${id}`);
    const giveUp = job.attempts >= options.maxAttempts || !options.retryable;
    job.status = giveUp ? 'failed' : 'pending';
    job.lastError = error;
    job.lockedAt = null;
    job.lockedBy = null;
    if (!giveUp) job.runAfter = new Date(Date.now() + 10);
    return job;
  },
  async reclaimStale() {
    return 0;
  },
  async countByStatus() {
    const counts = new Map<string, number>();
    for (const job of state.jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
    return [...counts.entries()].map(([status, count]) => ({ status, count }));
  },
  async findById(id: string) {
    return state.jobs.find((row) => row.id === id) ?? null;
  },
  async deleteCompletedBefore() {
    return 0;
  },
};
