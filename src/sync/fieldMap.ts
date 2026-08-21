import type { HubspotContact, HubspotProperties } from '../hubspot/client';
import type { OxidCustomer, OxidCustomerInput } from '../oxid/client';

/**
 * The single source of truth for what a "contact" is in this integration.
 *
 * `canonical` is the internal name, and both systems are mapped onto it so the
 * sync engine never deals in HubSpot or OXID vocabulary.
 */
export const contactFieldMap = [
  { canonical: 'email', hubspot: 'email', oxid: 'email', direction: 'both' },
  { canonical: 'firstName', hubspot: 'firstname', oxid: 'firstName', direction: 'both' },
  { canonical: 'lastName', hubspot: 'lastname', oxid: 'lastName', direction: 'both' },
  { canonical: 'phone', hubspot: 'phone', oxid: 'phone', direction: 'both' },
  { canonical: 'company', hubspot: 'company', oxid: 'company', direction: 'both' },
  { canonical: 'address', hubspot: 'address', oxid: 'address', direction: 'both' },
  { canonical: 'city', hubspot: 'city', oxid: 'city', direction: 'both' },
  { canonical: 'zip', hubspot: 'zip', oxid: 'zip', direction: 'both' },
  { canonical: 'country', hubspot: 'country', oxid: 'country', direction: 'both' },
] as const;

export type ContactFieldMapping = (typeof contactFieldMap)[number];
export type CanonicalField = ContactFieldMapping['canonical'];
export type CanonicalContact = Partial<Record<CanonicalField, string | null>>;

/** Fields to request from HubSpot: the mapped ones plus what sync needs itself. */
export const hubspotReadProperties: string[] = [
  ...new Set([...contactFieldMap.map((field) => field.hubspot), 'email', 'lastmodifieddate']),
];

export const canonicalFields: CanonicalField[] = contactFieldMap.map((field) => field.canonical);

/**
 * HubSpot rejects spaced numbers like `+49 30 12345678`. Collapse to E.164-style
 * `+493012345678`, or `+18884827768 ext 123` when an extension is present.
 */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const extMatch = trimmed.match(/^(.+?)\s+(?:ext\.?|x)\s*(\d+)\s*$/i);
  const mainPart = (extMatch?.[1] ?? trimmed).trim();
  const extension = extMatch?.[2];

  let normalized: string;
  if (mainPart.startsWith('+')) {
    const digits = mainPart.slice(1).replace(/\D/g, '');
    if (!digits) return null;
    normalized = `+${digits}`;
  } else {
    const digits = mainPart.replace(/\D/g, '');
    if (!digits) return null;
    normalized = digits;
  }

  return extension ? `${normalized} ext ${extension}` : normalized;
}

/** Collapses whitespace in a single-line address field. */
export function normalizeAddress(value: string): string | null {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed || null;
}

/**
 * Collapses the cosmetic differences between the systems: HubSpot returns `''`
 * for an empty property while OXID returns `null`, and email casing differs
 * freely. Without this, identical records would produce different hashes and the
 * loop guard would never fire.
 */
export function normalizeValue(field: CanonicalField, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (field === 'email') return text.toLowerCase();
  if (field === 'phone') return normalizePhone(text);
  if (field === 'address') return normalizeAddress(text);
  return text;
}

export function normalizeContact(contact: CanonicalContact): CanonicalContact {
  const normalized: CanonicalContact = {};
  for (const field of canonicalFields) {
    if (field in contact) normalized[field] = normalizeValue(field, contact[field]);
  }
  return normalized;
}

function mappingsFor(direction: 'hubspot_to_oxid' | 'oxid_to_hubspot'): ContactFieldMapping[] {
  return contactFieldMap.filter(
    (field) => field.direction === 'both' || field.direction === direction,
  );
}

export function fromHubspot(contact: HubspotContact): CanonicalContact {
  const canonical: CanonicalContact = {};
  for (const field of contactFieldMap) {
    canonical[field.canonical] = normalizeValue(
      field.canonical,
      contact.properties[field.hubspot] ?? null,
    );
  }
  return canonical;
}

export function fromOxid(customer: OxidCustomer | Record<string, unknown>): CanonicalContact {
  const source = customer as Record<string, unknown>;
  const canonical: CanonicalContact = {};
  for (const field of contactFieldMap) {
    canonical[field.canonical] = normalizeValue(field.canonical, source[field.oxid] ?? null);
  }
  return canonical;
}

/** HubSpot clears a property when it is sent as `''`, not `null`. */
export function toHubspotProperties(contact: CanonicalContact): HubspotProperties {
  const properties: HubspotProperties = {};
  for (const field of mappingsFor('oxid_to_hubspot')) {
    const value = contact[field.canonical];
    if (value === undefined) continue;
    properties[field.hubspot] = value ?? '';
  }
  return properties;
}

export function toOxidInput(contact: CanonicalContact): OxidCustomerInput {
  const input: Record<string, string | null> = {};
  for (const field of mappingsFor('hubspot_to_oxid')) {
    const value = contact[field.canonical];
    if (value === undefined) continue;
    input[field.oxid] = value;
  }
  return input as OxidCustomerInput;
}

export function emailOf(contact: CanonicalContact): string | null {
  return normalizeValue('email', contact.email ?? null);
}
