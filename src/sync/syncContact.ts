import { Prisma } from '@prisma/client';
import {
  entityMappingsRepo,
  type EntityMappingRow,
} from '../db/repositories/entityMappings';
import { integrationsRepo, type IntegrationRow } from '../db/repositories/integrations';
import { syncEventsRepo } from '../db/repositories/syncEvents';
import { hubspotClientFor } from '../hubspot/client';
import { IntegrationNotReadyError, NotFoundError, describeError } from '../lib/errors';
import { logger } from '../lib/logger';
import { oxidClientFor } from '../oxid/client';
import { originOf, type SyncDirection, type SyncEventStatus, type SyncOrigin } from '../types';
import {
  emailOf,
  fromHubspot,
  fromOxid,
  hubspotReadProperties,
  normalizeContact,
  toHubspotProperties,
  toOxidInput,
  type CanonicalContact,
} from './fieldMap';
import { contactHash } from './hash';

export interface SourceRecord {
  /** Id in the originating system. */
  id: string;
  /** Mapped values, if the caller already has them. Omit to load from source. */
  fields?: CanonicalContact;
  /** Set for `customer.deleted` style events, which v1 does not propagate. */
  deleted?: boolean;
}

export interface SyncContactInput {
  integrationId: string;
  direction: SyncDirection;
  sourceRecord: SourceRecord;
}

export interface SyncContactResult {
  status: SyncEventStatus;
  entityMappingId?: string;
  hubspotContactId?: string | null;
  oxidCustomerId?: string | null;
  reason?: string;
}

async function loadIntegration(integrationId: string): Promise<IntegrationRow> {
  const integration = await integrationsRepo.findById(integrationId);
  if (!integration) throw new NotFoundError(`no integration ${integrationId}`);
  if (integration.status !== 'active') {
    throw new IntegrationNotReadyError(
      `integration ${integrationId} is '${integration.status}', not active`,
    );
  }
  return integration;
}

/** Reads the record from the system it originated in when only an id was given. */
async function hydrate(
  integration: IntegrationRow,
  origin: SyncOrigin,
  record: SourceRecord,
): Promise<CanonicalContact | null> {
  if (record.fields) return normalizeContact(record.fields);

  if (origin === 'hubspot') {
    const contact = await hubspotClientFor(integration.id).getContact(
      record.id,
      hubspotReadProperties,
    );
    return contact ? fromHubspot(contact) : null;
  }

  const customer = await oxidClientFor(integration).getCustomer(record.id);
  return customer ? fromOxid(customer) : null;
}

async function findOrCreateMapping(
  integrationId: string,
  origin: SyncOrigin,
  sourceId: string,
): Promise<EntityMappingRow> {
  const existing =
    origin === 'hubspot'
      ? await entityMappingsRepo.findByHubspotContactId(integrationId, sourceId)
      : await entityMappingsRepo.findByOxidCustomerId(integrationId, sourceId);

  if (existing) return existing;

  try {
    return await entityMappingsRepo.create({
      integrationId,
      ...(origin === 'hubspot' ? { hubspotContactId: sourceId } : { oxidCustomerId: sourceId }),
    });
  } catch (error) {
    // Unique violation: a concurrent sync created it first, so take theirs.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced =
        origin === 'hubspot'
          ? await entityMappingsRepo.findByHubspotContactId(integrationId, sourceId)
          : await entityMappingsRepo.findByOxidCustomerId(integrationId, sourceId);
      if (raced) return raced;
    }
    throw error;
  }
}

async function writeToHubspot(
  integration: IntegrationRow,
  mapping: EntityMappingRow,
  contact: CanonicalContact,
  email: string,
): Promise<string> {
  const client = hubspotClientFor(integration.id);
  const properties = toHubspotProperties(contact);

  if (mapping.hubspotContactId) {
    const existing = await client.getContact(mapping.hubspotContactId, ['email']);
    if (existing) {
      await client.updateContact(mapping.hubspotContactId, properties);
      return mapping.hubspotContactId;
    }
    // The contact was deleted or merged in HubSpot; fall through and re-match on
    // email so the mapping heals itself instead of failing forever.
    logger.warn(
      { integrationId: integration.id, hubspotContactId: mapping.hubspotContactId },
      'mapped HubSpot contact is gone, re-matching by email',
    );
  }

  const { contact: written } = await client.upsertContactByEmail(
    email,
    properties,
    hubspotReadProperties,
  );
  return written.id;
}

async function writeToOxid(
  integration: IntegrationRow,
  mapping: EntityMappingRow,
  contact: CanonicalContact,
  email: string,
): Promise<string> {
  const client = oxidClientFor(integration);
  const input = toOxidInput(contact);

  if (mapping.oxidCustomerId) {
    const existing = await client.getCustomer(mapping.oxidCustomerId);
    if (existing) {
      const updated = await client.updateCustomer(mapping.oxidCustomerId, input);
      return updated.id;
    }
    logger.warn(
      { integrationId: integration.id, oxidCustomerId: mapping.oxidCustomerId },
      'mapped OXID customer is gone, re-matching by email',
    );
  }

  const byEmail = await client.findCustomerByEmail(email);
  if (byEmail) {
    const updated = await client.updateCustomer(byEmail.id, input);
    return updated.id;
  }

  const created = await client.createCustomer({ ...input, email });
  return created.id;
}

/**
 * The one and only sync path. Both directions come through here so there is a
 * single place where loop detection, mapping and auditing happen.
 */
export async function syncContact(input: SyncContactInput): Promise<SyncContactResult> {
  const { integrationId, direction, sourceRecord } = input;
  const origin = originOf(direction);
  const integration = await loadIntegration(integrationId);

  if (sourceRecord.deleted) {
    // Contact deletion propagation is deliberately out of scope for v1.
    await syncEventsRepo.log({
      integrationId,
      direction,
      status: 'skipped_unsupported',
      detail: { reason: 'delete events are not propagated in v1', sourceId: sourceRecord.id },
    });
    return { status: 'skipped_unsupported', reason: 'delete not supported' };
  }

  const mapping = await findOrCreateMapping(integrationId, origin, sourceRecord.id);
  const contact = await hydrate(integration, origin, sourceRecord);

  if (!contact) {
    await syncEventsRepo.log({
      integrationId,
      direction,
      entityMappingId: mapping.id,
      status: 'error',
      detail: { reason: 'source record not found', sourceId: sourceRecord.id },
    });
    return { status: 'error', entityMappingId: mapping.id, reason: 'source record not found' };
  }

  const email = emailOf(contact);
  if (!email) {
    // Email is the natural key for first-sync matching on both sides.
    await syncEventsRepo.log({
      integrationId,
      direction,
      entityMappingId: mapping.id,
      status: 'skipped_no_email',
      detail: { reason: 'record has no email', sourceId: sourceRecord.id },
    });
    return { status: 'skipped_no_email', entityMappingId: mapping.id, reason: 'no email' };
  }

  const hash = contactHash(contact);

  // Loop guard. An echo arrives with the *opposite* origin of the write that
  // caused it, so origin must play no part here: matching content alone means
  // the destination already holds these values and any write would be a no-op.
  if (mapping.lastSyncedHash === hash) {
    await syncEventsRepo.log({
      integrationId,
      direction,
      entityMappingId: mapping.id,
      status: 'skipped_loop',
      detail: { hash, sourceId: sourceRecord.id, previousWriteBy: mapping.sourceOfLastWrite },
    });
    return {
      status: 'skipped_loop',
      entityMappingId: mapping.id,
      hubspotContactId: mapping.hubspotContactId,
      oxidCustomerId: mapping.oxidCustomerId,
    };
  }

  try {
    const destinationId =
      direction === 'oxid_to_hubspot'
        ? await writeToHubspot(integration, mapping, contact, email)
        : await writeToOxid(integration, mapping, contact, email);

    const link =
      direction === 'oxid_to_hubspot'
        ? { hubspotContactId: destinationId }
        : { oxidCustomerId: destinationId };

    await entityMappingsRepo.linkCounterpart(integrationId, mapping.id, link);
    await entityMappingsRepo.recordSync(integrationId, mapping.id, { hash, source: origin });

    const result: SyncContactResult = {
      status: 'success',
      entityMappingId: mapping.id,
      hubspotContactId:
        direction === 'oxid_to_hubspot' ? destinationId : mapping.hubspotContactId,
      oxidCustomerId: direction === 'hubspot_to_oxid' ? destinationId : mapping.oxidCustomerId,
    };

    await syncEventsRepo.log({
      integrationId,
      direction,
      entityMappingId: mapping.id,
      status: 'success',
      detail: {
        sourceId: sourceRecord.id,
        destinationId,
        hash,
        fields: Object.keys(contact),
      },
    });

    logger.info(
      { integrationId, direction, sourceId: sourceRecord.id, destinationId },
      'contact synced',
    );

    return result;
  } catch (error) {
    const described = describeError(error);
    await syncEventsRepo.log({
      integrationId,
      direction,
      entityMappingId: mapping.id,
      status: 'error',
      detail: { sourceId: sourceRecord.id, message: described.message, code: described.code },
    });
    throw error;
  }
}
