import { randomUUID } from 'node:crypto';
import type { EntityMappingRow } from '../../src/db/repositories/entityMappings';
import type { IntegrationRow } from '../../src/db/repositories/integrations';
import type { PairingRequestRow } from '../../src/db/repositories/pairingRequests';
import type { SyncEventInput } from '../../src/db/repositories/syncEvents';
import type { EnqueueInput, SyncJobRow } from '../../src/db/repositories/syncJobs';
import { encrypt } from '../../src/lib/crypto';
import type { IntegrationStatus } from '../../src/types';

/**
 * In-memory stand-in for the repository layer.
 *
 * Mirrors the real repositories closely enough to exercise the sync engine and
 * every route - including the tenant scoping, which is the whole point of
 * testing it - without needing a live Postgres.
 */
export interface SyncEventRecord extends SyncEventInput {
  id: string;
  createdAt: Date;
}

const state = {
  integrations: [] as IntegrationRow[],
  mappings: [] as EntityMappingRow[],
  events: [] as SyncEventRecord[],
  jobs: [] as SyncJobRow[],
  pairings: [] as PairingRequestRow[],
};

export function resetFakeDb(): void {
  state.integrations = [];
  state.mappings = [];
  state.events = [];
  state.jobs = [];
  state.pairings = [];
}

export const fakeState = state;

// --- fixtures ---------------------------------------------------------------

export interface IntegrationFixture {
  portalId: string | number | bigint;
  status?: IntegrationStatus;
  oxidShopId?: string | null;
  oxidBaseUrl?: string | null;
  oxidApiKey?: string | null;
  oxidWebhookSecret?: string | null;
  hubspotAccessToken?: string | null;
  hubspotRefreshToken?: string | null;
  hubspotTokenExpiresAt?: Date | null;
  lastReconciledAt?: Date | null;
}

export function addIntegration(fixture: IntegrationFixture): IntegrationRow {
  const now = new Date();
  const row: IntegrationRow = {
    id: randomUUID(),
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
    oxidShopId: fixture.oxidShopId ?? randomUUID(),
    oxidBaseUrl: fixture.oxidBaseUrl ?? 'https://shop.example.com',
    oxidApiKey: encrypt(fixture.oxidApiKey ?? 'shop-api-key'),
    oxidAccessToken: null,
    oxidTokenExpiresAt: null,
    oxidWebhookSecret: encrypt(fixture.oxidWebhookSecret ?? 'shop-webhook-secret'),
    status: fixture.status ?? 'active',
    lastReconciledAt: fixture.lastReconciledAt ?? null,
    createdAt: now,
    updatedAt: now,
  };

  state.integrations.push(row);
  return row;
}

// --- repositories -----------------------------------------------------------

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
  async listAwaitingOxidPairing() {
    return state.integrations.filter(
      (row) => row.oxidShopId === null && row.hubspotAccessToken !== null,
    );
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

    const now = new Date();
    const row: IntegrationRow = {
      id: randomUUID(),
      name: input.name ?? null,
      hubspotPortalId: BigInt(input.portalId),
      hubspotAccessToken: encrypt(input.accessToken),
      hubspotRefreshToken: encrypt(input.refreshToken),
      hubspotTokenExpiresAt: input.expiresAt,
      oxidShopId: null,
      oxidBaseUrl: null,
      oxidApiKey: null,
      oxidAccessToken: null,
      oxidTokenExpiresAt: null,
      oxidWebhookSecret: null,
      status: 'pending',
      lastReconciledAt: null,
      createdAt: now,
      updatedAt: now,
    };
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
  async attachOxidShop(
    id: string,
    input: {
      oxidShopId: string;
      oxidBaseUrl: string;
      oxidApiKey: string;
      oxidWebhookSecret: string;
    },
  ) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    if (state.integrations.some((entry) => entry.id !== id && entry.oxidShopId === input.oxidShopId)) {
      throw new Error('duplicate oxid_shop_id');
    }
    row.oxidShopId = input.oxidShopId;
    row.oxidBaseUrl = input.oxidBaseUrl;
    row.oxidApiKey = encrypt(input.oxidApiKey);
    row.oxidWebhookSecret = encrypt(input.oxidWebhookSecret);
    row.oxidAccessToken = null;
    row.oxidTokenExpiresAt = null;
    row.status = 'active';
    return row;
  },
  async updateOxidToken(id: string, input: { accessToken: string; expiresAt: Date }) {
    const row = state.integrations.find((entry) => entry.id === id);
    if (!row) throw new Error(`no integration ${id}`);
    row.oxidAccessToken = encrypt(input.accessToken);
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
  }) {
    const now = new Date();
    const row: EntityMappingRow = {
      id: randomUUID(),
      integrationId: input.integrationId,
      hubspotContactId: input.hubspotContactId ?? null,
      oxidCustomerId: input.oxidCustomerId ?? null,
      lastSyncedAt: null,
      lastSyncedHash: null,
      sourceOfLastWrite: null,
      createdAt: now,
      updatedAt: now,
    };
    state.mappings.push(row);
    return row;
  },
  async linkCounterpart(
    integrationId: string,
    id: string,
    input: { hubspotContactId?: string | null; oxidCustomerId?: string | null },
  ) {
    const row = await fakeEntityMappingsRepo.findById(integrationId, id);
    if (!row) return 0;
    if (input.hubspotContactId !== undefined) row.hubspotContactId = input.hubspotContactId;
    if (input.oxidCustomerId !== undefined) row.oxidCustomerId = input.oxidCustomerId;
    return 1;
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

export const fakePairingRequestsRepo = {
  async create(input: {
    token: string;
    portalId: string | number | bigint;
    oxidShopUrl: string;
    expiresAt: Date;
  }) {
    const row: PairingRequestRow = {
      id: randomUUID(),
      token: input.token,
      hubspotPortalId: BigInt(input.portalId),
      oxidShopUrl: input.oxidShopUrl,
      used: false,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
    state.pairings.push(row);
    return row;
  },
  async findByToken(token: string) {
    return state.pairings.find((row) => row.token === token) ?? null;
  },
  async consume(token: string, now = new Date()) {
    const row = state.pairings.find(
      (entry) => entry.token === token && !entry.used && entry.expiresAt > now,
    );
    if (!row) return null;
    row.used = true;
    return row;
  },
  async deleteExpired(now = new Date()) {
    const before = state.pairings.length;
    state.pairings = state.pairings.filter((row) => row.expiresAt >= now);
    return before - state.pairings.length;
  },
};
