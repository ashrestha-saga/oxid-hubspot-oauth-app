import { vi } from 'vitest';
import {
  fakeEntityMappingsRepo,
  fakeIntegrationsRepo,
  fakePairingRequestsRepo,
  fakeSyncEventsRepo,
  fakeSyncJobsRepo,
} from './fakeDb';
import { fakeHubspotClientFor } from './fakeHubspot';

/**
 * Swaps the repository layer and the HubSpot client for in-memory fakes.
 *
 * Import this module (side-effect only) at the very top of a test file, before
 * anything that pulls in `src/`. Vitest hoists `vi.mock` calls, so the fakes are
 * in place no matter the import order.
 *
 * The secret accessors (`oxidWebhookSecret` and friends) are kept real, so the
 * tests still exercise actual encrypt/decrypt round-trips.
 */
vi.mock('../../src/db/repositories/integrations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/db/repositories/integrations')>();
  return { ...actual, integrationsRepo: fakeIntegrationsRepo };
});

vi.mock('../../src/db/repositories/entityMappings', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/db/repositories/entityMappings')>();
  return { ...actual, entityMappingsRepo: fakeEntityMappingsRepo };
});

vi.mock('../../src/db/repositories/syncEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/repositories/syncEvents')>();
  return { ...actual, syncEventsRepo: fakeSyncEventsRepo };
});

vi.mock('../../src/db/repositories/syncJobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/repositories/syncJobs')>();
  return { ...actual, syncJobsRepo: fakeSyncJobsRepo };
});

vi.mock('../../src/db/repositories/pairingRequests', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/db/repositories/pairingRequests')>();
  return { ...actual, pairingRequestsRepo: fakePairingRequestsRepo };
});

vi.mock('../../src/hubspot/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hubspot/client')>();
  return { ...actual, hubspotClientFor: fakeHubspotClientFor };
});

vi.mock('../../src/db/prisma', () => ({
  prisma: { $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]) },
  disconnectPrisma: vi.fn().mockResolvedValue(undefined),
}));
