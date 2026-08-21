import { createHash } from 'node:crypto';
import { canonicalFields, normalizeValue, type CanonicalContact } from './fieldMap';

/**
 * Content fingerprint of a contact, over the mapped fields only.
 *
 * This is what makes loop detection work: if the hash of an incoming record
 * equals the hash we stored after the last write, both systems already hold
 * these values and there is nothing to do. Field order is fixed and values are
 * normalized, so the two systems produce the same hash for the same person.
 *
 * A missing field and an empty field hash identically on purpose - HubSpot and
 * OXID disagree on which of the two they report.
 */
export function contactHash(contact: CanonicalContact): string {
  const canonical = canonicalFields.map((field) => [
    field,
    normalizeValue(field, contact[field] ?? null) ?? '',
  ]);

  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
