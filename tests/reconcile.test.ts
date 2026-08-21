import './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileIntegration, runReconcileOnce } from '../src/jobs/reconcile';
import {
  resetStubOxidStore,
  seedStubCustomer,
} from '../src/oxid/adapters/stubOxidClient';
import { resetOxidClientFactory, setOxidClientFactory, type OxidClient } from '../src/oxid/client';
import { contactHash } from '../src/sync/hash';
import { addIntegration, fakeState, resetFakeDb, fakeEntityMappingsRepo } from './helpers/fakeDb';
import { resetFakeHubspot, seedFakeHubspotContact } from './helpers/fakeHubspot';

beforeEach(() => {
  resetFakeDb();
  resetFakeHubspot();
  resetStubOxidStore();
  resetOxidClientFactory();
});

function seedShopCustomer(integrationId: string, id: string, email: string) {
  seedStubCustomer(integrationId, {
    id,
    email,
    firstName: 'Anna',
    lastName: 'Beispiel',
    phone: null,
    updatedAt: new Date().toISOString(),
  });
}

describe('reconcileIntegration', () => {
  it('queues both sides and advances the watermark', async () => {
    const integration = addIntegration({ portalId: 1000 });
    seedFakeHubspotContact(integration.id, {
      properties: { email: 'hs@example.com', firstname: 'Hs' },
    });
    seedShopCustomer(integration.id, 'oxid-1', 'shop@example.com');

    const now = new Date();
    const summary = await reconcileIntegration(integration, now);

    expect(summary).toMatchObject({ hubspotScanned: 1, oxidScanned: 1, queued: 2, errors: 0 });
    expect(fakeState.jobs.map((job) => job.direction).sort()).toEqual([
      'hubspot_to_oxid',
      'oxid_to_hubspot',
    ]);
    expect(fakeState.integrations[0]?.lastReconciledAt).toEqual(now);
  });

  it('carries the mapped fields with the job so no re-read is needed', async () => {
    const integration = addIntegration({ portalId: 1001 });
    seedShopCustomer(integration.id, 'oxid-2', 'shop2@example.com');

    await reconcileIntegration(integration);

    expect(fakeState.jobs[0]?.payload).toMatchObject({
      id: 'oxid-2',
      fields: { email: 'shop2@example.com', firstName: 'Anna' },
    });
  });

  it('skips records whose content is already the last synced content', async () => {
    const integration = addIntegration({ portalId: 1002 });
    seedShopCustomer(integration.id, 'oxid-3', 'known@example.com');

    const mapping = await fakeEntityMappingsRepo.create({
      integrationId: integration.id,
      oxidCustomerId: 'oxid-3',
    });
    await fakeEntityMappingsRepo.recordSync(integration.id, mapping.id, {
      hash: contactHash({
        email: 'known@example.com',
        firstName: 'Anna',
        lastName: 'Beispiel',
        phone: null,
      }),
      source: 'oxid',
    });

    const summary = await reconcileIntegration(integration);

    expect(summary.oxidScanned).toBe(1);
    expect(summary.queued).toBe(0);
    expect(fakeState.jobs).toHaveLength(0);
  });

  it('queues a record whose content drifted from the last sync', async () => {
    const integration = addIntegration({ portalId: 1003 });
    seedShopCustomer(integration.id, 'oxid-4', 'drift@example.com');

    const mapping = await fakeEntityMappingsRepo.create({
      integrationId: integration.id,
      oxidCustomerId: 'oxid-4',
    });
    await fakeEntityMappingsRepo.recordSync(integration.id, mapping.id, {
      hash: 'a-stale-hash',
      source: 'oxid',
    });

    expect((await reconcileIntegration(integration)).queued).toBe(1);
  });

  it('holds the watermark back when one side fails, so nothing is lost', async () => {
    const integration = addIntegration({ portalId: 1004 });
    setOxidClientFactory(
      () =>
        ({
          mode: 'stub',
          findCustomerByEmail: async () => null,
          getCustomer: async () => null,
          createCustomer: async () => {
            throw new Error('unused');
          },
          updateCustomer: async () => {
            throw new Error('unused');
          },
          listModifiedSince: async () => {
            throw new Error('shop unreachable');
          },
        }) as unknown as OxidClient,
    );

    const summary = await reconcileIntegration(integration);

    expect(summary.errors).toBe(1);
    expect(fakeState.integrations[0]?.lastReconciledAt).toBeNull();
  });

  it('looks back over an overlapping window rather than a hard boundary', async () => {
    const lastReconciledAt = new Date('2026-08-04T10:00:00.000Z');
    const integration = addIntegration({ portalId: 1005, lastReconciledAt });

    let requested: Date | null = null;
    setOxidClientFactory(
      () =>
        ({
          mode: 'stub',
          findCustomerByEmail: async () => null,
          getCustomer: async () => null,
          createCustomer: async () => {
            throw new Error('unused');
          },
          updateCustomer: async () => {
            throw new Error('unused');
          },
          listModifiedSince: async (since: Date) => {
            requested = since;
            return [];
          },
        }) as unknown as OxidClient,
    );

    await reconcileIntegration(integration);

    expect(requested).toEqual(new Date('2026-08-04T09:59:00.000Z'));
  });
});

describe('runReconcileOnce', () => {
  it('covers every active integration and skips the others', async () => {
    const active = addIntegration({ portalId: 1010 });
    const paused = addIntegration({ portalId: 1011, status: 'paused' });
    seedShopCustomer(active.id, 'oxid-a', 'a@example.com');
    seedShopCustomer(paused.id, 'oxid-b', 'b@example.com');

    const summaries = await runReconcileOnce();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.integrationId).toBe(active.id);
    expect(fakeState.jobs.every((job) => job.integrationId === active.id)).toBe(true);
  });

  it('does not start a second pass while one is still running', async () => {
    addIntegration({ portalId: 1012 });

    const [first, second] = await Promise.all([runReconcileOnce(), runReconcileOnce()]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
