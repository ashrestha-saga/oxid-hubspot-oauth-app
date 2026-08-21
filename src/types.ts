/** Direction of a single sync operation: where the data came from, where it goes. */
export type SyncDirection = 'hubspot_to_oxid' | 'oxid_to_hubspot';

/** The system that originated a write. */
export type SyncOrigin = 'hubspot' | 'oxid';

export type IntegrationStatus = 'pending' | 'active' | 'paused' | 'error';

export type SyncEventStatus =
  | 'success'
  | 'error'
  | 'skipped_loop'
  | 'skipped_no_email'
  | 'skipped_unsupported';

export type SyncJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export function originOf(direction: SyncDirection): SyncOrigin {
  return direction === 'hubspot_to_oxid' ? 'hubspot' : 'oxid';
}

export function destinationOf(direction: SyncDirection): SyncOrigin {
  return direction === 'hubspot_to_oxid' ? 'oxid' : 'hubspot';
}
