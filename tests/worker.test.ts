import './helpers/mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalApiError, NotFoundError } from '../src/lib/errors';
import { addIntegration, fakeState, resetFakeDb } from './helpers/fakeDb';
import { fakeSyncJobsRepo } from './helpers/fakeDb';

const syncContact = vi.hoisted(() => vi.fn());

vi.mock('../src/sync/syncContact', () => ({ syncContact }));

const { SyncWorker } = await import('../src/sync/worker');

beforeEach(() => {
  resetFakeDb();
  syncContact.mockReset();
  syncContact.mockResolvedValue({ status: 'success' });
});

async function enqueue(integrationId: string, recordId: string) {
  return fakeSyncJobsRepo.enqueue({
    integrationId,
    direction: 'oxid_to_hubspot',
    dedupeKey: `oxid_to_hubspot:${recordId}`,
    payload: { id: recordId, fields: { email: `${recordId}@example.com` } },
  });
}

describe('SyncWorker', () => {
  it('drains pending jobs and marks them done', async () => {
    const integration = addIntegration({ portalId: 900 });
    await enqueue(integration.id, 'c-1');
    await enqueue(integration.id, 'c-2');

    const processed = await new SyncWorker().tick();

    expect(processed).toBe(2);
    expect(syncContact).toHaveBeenCalledTimes(2);
    expect(fakeState.jobs.every((job) => job.status === 'done')).toBe(true);
  });

  it('passes the queued payload through as the source record', async () => {
    const integration = addIntegration({ portalId: 901 });
    await enqueue(integration.id, 'c-9');

    await new SyncWorker().tick();

    expect(syncContact).toHaveBeenCalledWith({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      sourceRecord: { id: 'c-9', fields: { email: 'c-9@example.com' } },
    });
  });

  it('reschedules a transient failure for another attempt', async () => {
    const integration = addIntegration({ portalId: 902 });
    await enqueue(integration.id, 'c-3');
    syncContact.mockRejectedValueOnce(
      new ExternalApiError('rate limited', { system: 'hubspot', status: 429 }),
    );

    await new SyncWorker().tick();

    const job = fakeState.jobs[0];
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/rate limited/);
  });

  it('gives up immediately on a failure that cannot succeed on retry', async () => {
    const integration = addIntegration({ portalId: 903 });
    await enqueue(integration.id, 'c-4');
    syncContact.mockRejectedValueOnce(new NotFoundError('no such integration'));

    await new SyncWorker().tick();

    expect(fakeState.jobs[0]?.status).toBe('failed');
    expect(fakeState.jobs[0]?.attempts).toBe(1);
  });

  it('stops retrying once max attempts are used up', async () => {
    const integration = addIntegration({ portalId: 904 });
    await enqueue(integration.id, 'c-5');
    syncContact.mockRejectedValue(
      new ExternalApiError('upstream down', { system: 'oxid', status: 503 }),
    );

    const worker = new SyncWorker({ maxAttempts: 2 });
    await worker.tick();
    expect(fakeState.jobs[0]?.status).toBe('pending');

    // Second attempt reaches the cap.
    (fakeState.jobs[0] as { runAfter: Date }).runAfter = new Date(0);
    await worker.tick();
    expect(fakeState.jobs[0]?.status).toBe('failed');
    expect(fakeState.jobs[0]?.attempts).toBe(2);
  });

  it('never runs two jobs for the same record at the same time', async () => {
    const integration = addIntegration({ portalId: 905 });
    await enqueue(integration.id, 'c-6');
    await fakeSyncJobsRepo.claimNext('worker-a');

    // A second pending job for the same record exists, but the first is in flight.
    await fakeSyncJobsRepo.enqueue({
      integrationId: integration.id,
      direction: 'oxid_to_hubspot',
      dedupeKey: 'oxid_to_hubspot:c-6',
      payload: { id: 'c-6' },
    });

    expect(await fakeSyncJobsRepo.claimNext('worker-b')).toBeNull();
  });

  it('does not process one tenant\'s job under another tenant', async () => {
    const tenantA = addIntegration({ portalId: 906 });
    const tenantB = addIntegration({ portalId: 907 });
    await enqueue(tenantA.id, 'c-7');

    await new SyncWorker().tick();

    expect(syncContact).toHaveBeenCalledTimes(1);
    expect(syncContact.mock.calls[0]?.[0]).toMatchObject({ integrationId: tenantA.id });
    expect(syncContact.mock.calls[0]?.[0]).not.toMatchObject({ integrationId: tenantB.id });
  });

  it('survives a tick with nothing to do', async () => {
    expect(await new SyncWorker().tick()).toBe(0);
  });
});
