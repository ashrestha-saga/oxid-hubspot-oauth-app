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
  normalizeContact,
  type CanonicalContact,
} from './fieldMap';
import { contactHash } from './hash';
import {
  canonicalFromHubspot,
  canonicalFromOxidCustomer,
  canonicalFromOxidUser,
  hubspotPropertiesFromMap,
  parseTenantFieldMap,
  toHubspotPropertiesWithMap,
} from './tenantFieldMap';

export interface SourceRecord {
  /** Id in the originating system. */
  id: string;
  /** Mapped values, if the caller already has them. Omit to load from source. */
  fields?: CanonicalContact;
  /**
   * Raw OXID `users` (or customer) object so the worker can re-apply the
   * tenant's current field map at sync time.
   */
  rawOxid?: Record<string, unknown>;
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
  const map = parseTenantFieldMap(integration.fieldMappingJson);

  // Prefer remapping from the raw OXID payload with the tenant's current map.
  if (origin === 'oxid' && record.rawOxid) {
    try {
      return canonicalFromOxidUser(record.rawOxid, map).fields;
    } catch {
      // Fall through to pre-mapped fields / live fetch.
    }
  }

  if (record.fields) return normalizeContact(record.fields);

  if (origin === 'hubspot') {
    const contact = await hubspotClientFor(integration.id).getContact(
      record.id,
      hubspotPropertiesFromMap(map),
    );
    return contact ? canonicalFromHubspot(contact, map) : null;
  }

  const customer = await oxidClientFor(integration).getCustomer(record.id);
  return customer ? canonicalFromOxidCustomer(customer, map) : null;
}

async function findOrCreateMapping(
  integrationId: string,
  origin: SyncOrigin,
  sourceId: string,
  email: string,
): Promise<EntityMappingRow> {
  if (origin === 'hubspot') {
    const byHubspot = await entityMappingsRepo.findByHubspotContactId(integrationId, sourceId);
    const byEmail = await entityMappingsRepo.findByOxidCustomerId(integrationId, email);

    if (byHubspot && byEmail && byHubspot.id !== byEmail.id) {
      // Half-mapped rows from earlier syncs — collapse into the HubSpot row.
      return entityMappingsRepo.mergeMappings(integrationId, byHubspot.id, byEmail.id);
    }
    if (byHubspot) return byHubspot;
    if (byEmail) {
      await entityMappingsRepo.linkCounterpart(integrationId, byEmail.id, {
        hubspotContactId: sourceId,
      });
      const linked = await entityMappingsRepo.findById(integrationId, byEmail.id);
      if (linked) return linked;
      return byEmail;
    }

    return createMapping(integrationId, { hubspotContactId: sourceId });
  }

  const byEmail = await entityMappingsRepo.findByOxidCustomerId(integrationId, email);
  if (byEmail) return byEmail;

  return createMapping(integrationId, { oxidCustomerId: email });
}

async function createMapping(
  integrationId: string,
  input: { hubspotContactId?: string | null; oxidCustomerId?: string | null },
): Promise<EntityMappingRow> {
  try {
    return await entityMappingsRepo.create({ integrationId, ...input });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      if (input.hubspotContactId) {
        const raced = await entityMappingsRepo.findByHubspotContactId(
          integrationId,
          input.hubspotContactId,
        );
        if (raced) return raced;
      }
      if (input.oxidCustomerId) {
        const raced = await entityMappingsRepo.findByOxidCustomerId(
          integrationId,
          input.oxidCustomerId,
        );
        if (raced) return raced;
      }
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
  const map = parseTenantFieldMap(integration.fieldMappingJson);
  const properties = toHubspotPropertiesWithMap(contact, map);
  const readProperties = hubspotPropertiesFromMap(map);

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
    readProperties,
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
  const map = parseTenantFieldMap(integration.fieldMappingJson);
  const result = await client.upsertCustomerByEmail(email, contact, map, {
    oxidRecordId: mapping.oxidRecordId,
  });
  return result.id;
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

  const contact = await hydrate(integration, origin, sourceRecord);

  if (!contact) {
    await syncEventsRepo.log({
      integrationId,
      direction,
      status: 'error',
      detail: { reason: 'source record not found', sourceId: sourceRecord.id },
    });
    return { status: 'error', reason: 'source record not found' };
  }

  const email = emailOf(contact);
  if (!email) {
    await syncEventsRepo.log({
      integrationId,
      direction,
      status: 'skipped_no_email',
      detail: { reason: 'record has no email', sourceId: sourceRecord.id },
    });
    return { status: 'skipped_no_email', reason: 'no email' };
  }

  const mapping = await findOrCreateMapping(integrationId, origin, sourceRecord.id, email);

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

    const oxidFromPayload =
      sourceRecord.rawOxid && typeof sourceRecord.rawOxid.oxid === 'string'
        ? sourceRecord.rawOxid.oxid
        : null;

    const link =
      direction === 'oxid_to_hubspot'
        ? {
            hubspotContactId: destinationId,
            ...(oxidFromPayload ? { oxidRecordId: oxidFromPayload } : {}),
          }
        : {
            oxidCustomerId: email,
            // Store OXID object id for future update-by-oxid; User API writes still use email.
            ...(destinationId.includes('@') ? {} : { oxidRecordId: destinationId }),
          };

    const linked = await entityMappingsRepo.linkCounterpart(integrationId, mapping.id, link);
    await entityMappingsRepo.recordSync(integrationId, linked.id, { hash, source: origin });

    const result: SyncContactResult = {
      status: 'success',
      entityMappingId: linked.id,
      hubspotContactId:
        direction === 'oxid_to_hubspot' ? destinationId : linked.hubspotContactId,
      oxidCustomerId: email,
    };

    await syncEventsRepo.log({
      integrationId,
      direction,
      entityMappingId: linked.id,
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
