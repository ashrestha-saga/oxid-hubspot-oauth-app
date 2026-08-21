import type { SyncDirection } from '../types';

/**
 * Identifies the record a job is about. Two jobs sharing a key are the same work
 * and are never processed concurrently, which is what stops two edits of one
 * contact from racing each other into the destination.
 */
export function dedupeKeyFor(direction: SyncDirection, recordId: string): string {
  return `${direction}:${recordId}`;
}
