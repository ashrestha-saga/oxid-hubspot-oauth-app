import { env } from '../config/env';
import { entityMappingsRepo } from '../db/repositories/entityMappings';
import { integrationsRepo, type IntegrationRow } from '../db/repositories/integrations';
import { syncJobsRepo } from '../db/repositories/syncJobs';
import { hubspotClientFor } from '../hubspot/client';
import { logger } from '../lib/logger';
import { oxidClientFor } from '../oxid/client';
import { fromHubspot, fromOxid, hubspotReadProperties } from '../sync/fieldMap';
import { contactHash } from '../sync/hash';
import { dedupeKeyFor } from '../sync/queue';
import type { SourceRecord } from '../sync/syncContact';
import type { SyncDirection, SyncOrigin } from '../types';

/**
 * Overlap the previous window by a minute. Both systems report modification
 * times from their own clocks, so a strict boundary can drop a record that was
 * written a hair before the last run started.
 */
const WINDOW_OVERLAP_MS = 60 * 1000;

/** First run has no watermark; look back this far rather than over all history. */
const FIRST_RUN_LOOKBACK_MS = 60 * 60 * 1000;

export interface ReconcileSummary {
  integrationId: string;
  hubspotScanned: number;
  oxidScanned: number;
  queued: number;
  errors: number;
}

function windowStart(integration: IntegrationRow, now: Date): Date {
  const base = integration.lastReconciledAt ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  return new Date(base.getTime() - WINDOW_OVERLAP_MS);
}

/**
 * Enqueues a record unless the mapping already records this exact content.
 *
 * `syncContact` would skip those anyway, so filtering here keeps the queue (and
 * the audit log) free of thousands of no-op entries every 15 minutes.
 */
async function enqueueIfChanged(
  integrationId: string,
  direction: SyncDirection,
  origin: SyncOrigin,
  record: SourceRecord,
): Promise<boolean> {
  const hash = contactHash(record.fields ?? {});

  const mapping =
    origin === 'hubspot'
      ? await entityMappingsRepo.findByHubspotContactId(integrationId, record.id)
      : await entityMappingsRepo.findByOxidCustomerId(integrationId, record.id);

  if (mapping && mapping.lastSyncedHash === hash) return false;

  await syncJobsRepo.enqueue({
    integrationId,
    direction,
    dedupeKey: dedupeKeyFor(direction, record.id),
    payload: { ...record },
  });
  return true;
}

export async function reconcileIntegration(
  integration: IntegrationRow,
  now = new Date(),
): Promise<ReconcileSummary> {
  const since = windowStart(integration, now);
  const summary: ReconcileSummary = {
    integrationId: integration.id,
    hubspotScanned: 0,
    oxidScanned: 0,
    queued: 0,
    errors: 0,
  };

  try {
    const contacts = await hubspotClientFor(integration.id).listModifiedSince(
      since,
      hubspotReadProperties,
    );
    summary.hubspotScanned = contacts.length;

    for (const contact of contacts) {
      const queued = await enqueueIfChanged(integration.id, 'hubspot_to_oxid', 'hubspot', {
        id: contact.id,
        fields: fromHubspot(contact),
      });
      if (queued) summary.queued += 1;
    }
  } catch (error) {
    summary.errors += 1;
    logger.error({ err: error, integrationId: integration.id }, 'reconcile: HubSpot scan failed');
  }

  try {
    const customers = await oxidClientFor(integration).listModifiedSince(since);
    summary.oxidScanned = customers.length;

    for (const customer of customers) {
      const queued = await enqueueIfChanged(integration.id, 'oxid_to_hubspot', 'oxid', {
        id: customer.id,
        fields: fromOxid(customer),
      });
      if (queued) summary.queued += 1;
    }
  } catch (error) {
    summary.errors += 1;
    logger.error({ err: error, integrationId: integration.id }, 'reconcile: OXID scan failed');
  }

  // Only advance the watermark when both sides were scanned cleanly, otherwise
  // the failed side's window would be lost for good.
  if (summary.errors === 0) {
    await integrationsRepo.setLastReconciledAt(integration.id, now);
  }

  logger.info(summary, 'reconcile pass finished');
  return summary;
}

let running = false;

/** Runs one full reconciliation pass over every active integration. */
export async function runReconcileOnce(now = new Date()): Promise<ReconcileSummary[]> {
  // Overlap guard: a pass that outlives its interval must not be started twice.
  if (running) {
    logger.warn('reconcile still running, skipping this interval');
    return [];
  }
  running = true;

  try {
    const integrations = await integrationsRepo.listActive();
    const summaries: ReconcileSummary[] = [];

    for (const integration of integrations) {
      summaries.push(await reconcileIntegration(integration, now));
    }
    return summaries;
  } catch (error) {
    logger.error({ err: error }, 'reconcile pass failed');
    return [];
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startReconcileSchedule(): void {
  if (timer) return;

  const intervalMs = env.RECONCILE_INTERVAL_MINUTES * 60 * 1000;
  logger.info({ intervalMinutes: env.RECONCILE_INTERVAL_MINUTES }, 'reconcile schedule started');

  timer = setInterval(() => {
    void runReconcileOnce();
  }, intervalMs);
  timer.unref();
}

export function stopReconcileSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
