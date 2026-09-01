import { z } from 'zod';
import {
  canonicalFields,
  contactFieldMap,
  normalizeContact,
  normalizeValue,
  type CanonicalContact,
  type CanonicalField,
} from './fieldMap';
import type { HubspotContact, HubspotProperties } from '../hubspot/client';
import type { OxidCustomer, OxidCustomerInput } from '../oxid/client';
import {
  formatOxidStreet,
  oxidUserRecordId,
  pickOxidField,
  type OxidRawUserRecord,
} from '../oxid/fromOxidUserWebhook';

export type FieldTransform = 'none' | 'oxid_street' | 'oxid_pick_with_children';

export interface FieldBinding {
  canonical: CanonicalField;
  /** Dot path into the OXID user/customer object. Null = leave unmapped. */
  oxidPath: string | null;
  hubspotProperty: string;
  transform: FieldTransform;
}

export interface TenantFieldMap {
  version: 1;
  /**
   * Paths tried in order to resolve the OXID record id (on the users/customer object).
   * Example: ["oxid", "mcustnr"]
   */
  oxidIdPaths: string[];
  fields: FieldBinding[];
}

export type MappingStatus = 'default' | 'custom';

export interface DiscoveredKey {
  path: string;
  sample: string | null;
}

const fieldBindingSchema = z.object({
  canonical: z.enum([
    'email',
    'firstName',
    'lastName',
    'phone',
    'company',
    'address',
    'city',
    'zip',
    'country',
  ]),
  oxidPath: z.string().min(1).nullable(),
  hubspotProperty: z.string().min(1),
  transform: z.enum(['none', 'oxid_street', 'oxid_pick_with_children']).default('none'),
});

export const tenantFieldMapSchema = z.object({
  version: z.literal(1),
  oxidIdPaths: z.array(z.string().min(1)).min(1),
  fields: z.array(fieldBindingSchema).min(1),
});

/** Built-in map matching today's OXID `users` + HubSpot contact properties. */
export function defaultTenantFieldMap(): TenantFieldMap {
  return {
    version: 1,
    oxidIdPaths: ['oxid', 'mcustnr'],
    fields: contactFieldMap.map((field) => {
      const oxidPath =
        field.canonical === 'email'
          ? 'oxusername'
          : field.canonical === 'firstName'
            ? 'oxfname'
            : field.canonical === 'lastName'
              ? 'oxlname'
              : field.canonical === 'phone'
                ? 'oxfon'
                : field.canonical === 'company'
                  ? 'oxcompany'
                  : field.canonical === 'address'
                    ? 'oxstreet'
                    : field.canonical === 'city'
                      ? 'oxcity'
                      : field.canonical === 'zip'
                        ? 'oxzip'
                      : field.canonical === 'country'
                          ? 'oxcountryid'
                          : 'email';

      const transform: FieldTransform =
        field.canonical === 'address'
          ? 'oxid_street'
          : field.canonical === 'phone' ||
              field.canonical === 'company' ||
              field.canonical === 'city' ||
              field.canonical === 'zip' ||
              field.canonical === 'country'
            ? 'oxid_pick_with_children'
            : 'none';

      return {
        canonical: field.canonical,
        oxidPath,
        hubspotProperty: field.hubspot,
        transform,
      };
    }),
  };
}

export function parseTenantFieldMap(json: string | null | undefined): TenantFieldMap {
  if (!json) return defaultTenantFieldMap();
  try {
    const parsed = tenantFieldMapSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return defaultTenantFieldMap();
    return ensureAllCanonicalFields(parsed.data);
  } catch {
    return defaultTenantFieldMap();
  }
}

/** Guarantees every canonical field exists once (fills gaps from defaults). */
export function ensureAllCanonicalFields(map: TenantFieldMap): TenantFieldMap {
  const defaults = defaultTenantFieldMap();
  const byCanonical = new Map(map.fields.map((field) => [field.canonical, field]));
  return {
    version: 1,
    oxidIdPaths: map.oxidIdPaths.length > 0 ? map.oxidIdPaths : defaults.oxidIdPaths,
    fields: canonicalFields.map(
      (canonical) =>
        byCanonical.get(canonical) ??
        defaults.fields.find((field) => field.canonical === canonical)!,
    ),
  };
}

export function hubspotPropertiesFromMap(map: TenantFieldMap): string[] {
  return [...new Set([...map.fields.map((field) => field.hubspotProperty), 'email', 'lastmodifieddate'])];
}

export function getByPath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.').filter(Boolean);
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Reads an OXID field with optional child_ids fallback / street concat.
 * `user` is the raw users object (or a normalized customer-shaped record).
 */
export function readOxidBinding(
  user: Record<string, unknown>,
  binding: FieldBinding,
): string | null {
  if (!binding.oxidPath) return null;

  if (binding.transform === 'oxid_street') {
    return pickOxidField(user as OxidRawUserRecord, formatOxidStreet);
  }

  if (binding.transform === 'oxid_pick_with_children') {
    const leaf = binding.oxidPath.includes('.')
      ? binding.oxidPath.slice(binding.oxidPath.lastIndexOf('.') + 1)
      : binding.oxidPath;
    return pickOxidField(user as OxidRawUserRecord, (row) =>
      textOrNull((row as Record<string, unknown>)[leaf]),
    );
  }

  return textOrNull(getByPath(user, binding.oxidPath));
}

export function resolveOxidRecordId(
  user: Record<string, unknown>,
  map: TenantFieldMap,
): string | null {
  for (const path of map.oxidIdPaths) {
    const value = textOrNull(getByPath(user, path));
    if (value) return value;
  }
  // Backward-compatible fallback for standard OXID payloads.
  return oxidUserRecordId(user as OxidRawUserRecord);
}

/** Map a raw OXID `users` object using a tenant field map. */
export function canonicalFromOxidUser(
  user: Record<string, unknown>,
  map: TenantFieldMap,
): { id: string; fields: CanonicalContact; updatedAt: string | null } {
  const id = resolveOxidRecordId(user, map);
  if (!id) {
    throw new Error('OXID payload has no record id for the configured oxidIdPaths');
  }

  const fields: CanonicalContact = {};
  for (const binding of map.fields) {
    fields[binding.canonical] = normalizeValue(
      binding.canonical,
      readOxidBinding(user, binding),
    );
  }

  const updatedAt =
    textOrNull(user.oxtimestamp) ?? textOrNull(user.oxcreate) ?? textOrNull(user.updatedAt) ?? null;

  return { id, fields: normalizeContact(fields), updatedAt };
}

/** Map a normalized camelCase customer / OxidCustomer using oxidPath as property names. */
export function canonicalFromOxidCustomer(
  customer: OxidCustomer | Record<string, unknown>,
  map: TenantFieldMap,
): CanonicalContact {
  const source = customer as Record<string, unknown>;
  const fields: CanonicalContact = {};
  for (const binding of map.fields) {
    // For normalized customers, prefer canonical property names when oxidPath is OXID-db style.
    const direct = binding.oxidPath ? getByPath(source, binding.oxidPath) : undefined;
    const fallback = source[binding.canonical];
    fields[binding.canonical] = normalizeValue(binding.canonical, direct ?? fallback ?? null);
  }
  return normalizeContact(fields);
}

export function canonicalFromHubspot(contact: HubspotContact, map: TenantFieldMap): CanonicalContact {
  const fields: CanonicalContact = {};
  for (const binding of map.fields) {
    fields[binding.canonical] = normalizeValue(
      binding.canonical,
      contact.properties[binding.hubspotProperty] ?? null,
    );
  }
  return normalizeContact(fields);
}

export function toHubspotPropertiesWithMap(
  contact: CanonicalContact,
  map: TenantFieldMap,
): HubspotProperties {
  const properties: HubspotProperties = {};
  for (const binding of map.fields) {
    const value = contact[binding.canonical];
    if (value === undefined) continue;
    properties[binding.hubspotProperty] = value ?? '';
  }
  return properties;
}

export function toOxidInputWithMap(
  contact: CanonicalContact,
  map: TenantFieldMap,
): OxidCustomerInput {
  const input: Record<string, string | null> = {};
  for (const binding of map.fields) {
    const value = contact[binding.canonical];
    if (value === undefined) continue;
    // OXID API adapter expects camelCase OxidCustomerInput keys.
    input[binding.canonical] = value;
  }
  return input as OxidCustomerInput;
}

/** Flatten a JSON value into dotted paths for the mapping UI. */
export function discoverKeys(value: unknown, prefix = '', depth = 0): DiscoveredKey[] {
  if (depth > 6) return [];
  if (value === null || value === undefined) {
    return prefix ? [{ path: prefix, sample: null }] : [];
  }
  if (typeof value !== 'object') {
    return [{ path: prefix, sample: textOrNull(value) }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [{ path: prefix, sample: '[]' }] : [];
    // Index the first element so nested address rows are mappable.
    return discoverKeys(value[0], prefix ? `${prefix}.0` : '0', depth + 1);
  }

  const keys: DiscoveredKey[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object') {
      keys.push(...discoverKeys(child, path, depth + 1));
    } else {
      keys.push({ path, sample: textOrNull(child) });
    }
  }
  return keys;
}

/**
 * Unwraps `{ users: {...} }` samples so discovered paths match oxidPath
 * (relative to the users object), while also exposing wrapper keys if present.
 */
export function discoverOxidPayloadKeys(payload: unknown): {
  keys: DiscoveredKey[];
  usersObject: Record<string, unknown> | null;
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { keys: [], usersObject: null };
  }
  const root = payload as Record<string, unknown>;
  if (root.users && typeof root.users === 'object' && !Array.isArray(root.users)) {
    const users = root.users as Record<string, unknown>;
    return { keys: discoverKeys(users), usersObject: users };
  }
  return { keys: discoverKeys(root), usersObject: root };
}

/** Suggest oxid paths from discovered keys using common OXID / camelCase names. */
export function suggestMapFromKeys(keys: DiscoveredKey[]): TenantFieldMap {
  const paths = new Set(keys.map((key) => key.path));
  const has = (...candidates: string[]) => candidates.find((candidate) => paths.has(candidate)) ?? null;

  const base = defaultTenantFieldMap();
  const suggestions: Partial<Record<CanonicalField, string | null>> = {
    email: has('oxusername', 'email', 'users.oxusername'),
    firstName: has('oxfname', 'firstName', 'firstname'),
    lastName: has('oxlname', 'lastName', 'lastname'),
    phone: has('oxfon', 'phone', 'child_ids.0.oxfon'),
    company: has('oxcompany', 'company', 'child_ids.0.oxcompany'),
    address: has('oxstreet', 'address', 'child_ids.0.oxstreet'),
    city: has('oxcity', 'city', 'child_ids.0.oxcity'),
    zip: has('oxzip', 'zip', 'child_ids.0.oxzip'),
    country: has('oxcountryid', 'country', 'child_ids.0.oxcountryid'),
  };

  const oxidIdPaths = ['oxid', 'mcustnr', 'id'].filter((path) => paths.has(path));
  return {
    version: 1,
    oxidIdPaths: oxidIdPaths.length > 0 ? oxidIdPaths : base.oxidIdPaths,
    fields: base.fields.map((field) => ({
      ...field,
      oxidPath: suggestions[field.canonical] ?? field.oxidPath,
    })),
  };
}

export function previewMappedContact(
  payload: unknown,
  map: TenantFieldMap,
): { id: string | null; fields: CanonicalContact; hubspotProperties: HubspotProperties } {
  const { usersObject } = discoverOxidPayloadKeys(payload);
  if (!usersObject) {
    return { id: null, fields: {}, hubspotProperties: {} };
  }
  try {
    const mapped = canonicalFromOxidUser(usersObject, map);
    return {
      id: mapped.id,
      fields: mapped.fields,
      hubspotProperties: toHubspotPropertiesWithMap(mapped.fields, map),
    };
  } catch {
    return { id: null, fields: {}, hubspotProperties: {} };
  }
}
