import { normalizeContact, normalizeValue, type CanonicalContact } from '../sync/fieldMap';

/**
 * Raw OXID user record as pushed by the shop module (see user.json at repo root).
 *
 * Field names follow OXID's database/API convention (`oxusername`, `oxfname`, …)
 * rather than the normalized camelCase contract. This adapter maps them onto the
 * canonical contact shape the sync engine understands.
 */
export interface OxidAddressLike {
  oxstreet?: string | null;
  oxstreetnr?: string | null;
  oxzip?: string | null;
  oxcity?: string | null;
  oxcountryid?: string | null;
  /** Country id string, or nested `{ oxtitle, oxisoalpha2, … }`. */
  oxcountry?: string | OxidCountryLike | null;
  oxcompany?: string | null;
  oxfon?: string | null;
  oxsal?: string | null;
  salutation?: OxidSalutationLike | null;
  [key: string]: unknown;
}

export interface OxidCountryLike {
  oxid?: string | null;
  oxtitle?: string | null;
  oxtitle_1?: string | null;
  oxisoalpha2?: string | null;
  oxisoalpha3?: string | null;
}

export interface OxidSalutationLike {
  id?: string | null;
  title?: string | null;
  title_1?: string | null;
}

export interface OxidRawUserRecord extends OxidAddressLike {
  /** Internal OXID object id, when present on the parent user row. */
  oxid?: string | null;
  /** Customer number — optional metadata; email (`oxusername`) is the record key. */
  mcustnr?: string | number | null;
  oxusername?: string | null;
  oxfname?: string | null;
  oxlname?: string | null;
  /** Salutation code from OXID (`MR` / `MRS` / …). */
  oxsal?: string | null;
  /** Nested salutation `{ id, title, title_1 }` from newer shop payloads. */
  salutation?: OxidSalutationLike | null;
  oxcreate?: string | null;
  oxtimestamp?: string | null;
  /** Legacy nested delivery rows. */
  child_ids?: OxidAddressLike[] | null;
  /** Alternate legacy name for delivery rows. */
  deliveryAddress?: OxidAddressLike[] | null;
  /** Current shop payloads use `oxaddress` for delivery addresses. */
  oxaddress?: OxidAddressLike[] | null;
}

/**
 * Keys we keep from an inbound OXID `users` webhook. Shop modules often push the
 * full oxuser row; sync only needs identity + mappable contact/address fields.
 */
export const NEEDFUL_OXID_USER_KEYS = [
  'oxid',
  'oxusername',
  'oxfname',
  'oxlname',
  'oxsal',
  'salutation',
  'oxfon',
  'oxmobfon',
  'oxprivfon',
  'oxcompany',
  'oxstreet',
  'oxstreetnr',
  'oxzip',
  'oxcity',
  'oxcountryid',
  'oxcountry',
  'oxstateid',
  'oxstate',
  'oxtimestamp',
  'oxcreate',
  'oxaddress',
  'child_ids',
  'deliveryAddress',
] as const;

const NEEDFUL_ADDRESS_KEYS = [
  'oxid',
  'oxsal',
  'salutation',
  'oxfon',
  'oxcompany',
  'oxstreet',
  'oxstreetnr',
  'oxzip',
  'oxcity',
  'oxcountryid',
  'oxcountry',
  'oxstateid',
  'oxstate',
] as const;

const NEEDFUL_COUNTRY_KEYS = ['oxid', 'oxtitle', 'oxtitle_1', 'oxisoalpha2', 'oxisoalpha3'] as const;
const NEEDFUL_SALUTATION_KEYS = ['id', 'title', 'title_1'] as const;

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const text = String(value).trim();
  return text || null;
}

/** Reads country from a string id/name or nested OXID country object. */
export function formatOxidCountry(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return textValue(value);
  const row = value as Record<string, unknown>;
  return (
    textValue(row.oxtitle) ??
    textValue(row.oxtitle_1) ??
    textValue(row.oxisoalpha2) ??
    textValue(row.oxid)
  );
}

/** Prefer nested salutation titles, then the flat `oxsal` code. */
export function formatOxidSalutation(row: {
  oxsal?: unknown;
  salutation?: unknown;
}): string | null {
  const nested = row.salutation;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const sal = nested as Record<string, unknown>;
    const fromNested =
      textValue(sal.title_1) ?? textValue(sal.title) ?? textValue(sal.id);
    if (fromNested) return fromNested;
  }
  return textValue(row.oxsal);
}

function pickSlimObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? picked : value;
}

function pickAddressRow(row: unknown): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const source = row as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of NEEDFUL_ADDRESS_KEYS) {
    if (!(key in source)) continue;
    if (key === 'oxcountry') {
      picked[key] = pickSlimObject(source[key], NEEDFUL_COUNTRY_KEYS);
      continue;
    }
    if (key === 'salutation') {
      picked[key] = pickSlimObject(source[key], NEEDFUL_SALUTATION_KEYS);
      continue;
    }
    picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? picked : null;
}

function pickAddressList(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(pickAddressRow)
    .filter((row): row is Record<string, unknown> => row !== null);
}

/** Delivery / child address rows across payload versions. */
export function oxidAddressRows(user: OxidRawUserRecord): OxidAddressLike[] {
  return user.oxaddress ?? user.child_ids ?? user.deliveryAddress ?? [];
}

/** Keeps only sync-relevant keys from a raw OXID `users` object. */
export function pickNeedfulOxidUser(user: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of NEEDFUL_OXID_USER_KEYS) {
    if (!(key in user)) continue;
    if (key === 'oxaddress' || key === 'child_ids' || key === 'deliveryAddress') {
      const rows = pickAddressList(user[key]);
      if (rows) picked[key] = rows;
      continue;
    }
    if (key === 'oxcountry') {
      picked[key] = pickSlimObject(user[key], NEEDFUL_COUNTRY_KEYS);
      continue;
    }
    if (key === 'salutation') {
      picked[key] = pickSlimObject(user[key], NEEDFUL_SALUTATION_KEYS);
      continue;
    }
    picked[key] = user[key];
  }
  return picked;
}

export interface OxidUserWebhookRecord {
  id: string;
  fields: CanonicalContact;
  updatedAt: string | null;
}

/** `oxstreet` + `oxstreetnr` as a single HubSpot address line. */
export function formatOxidStreet(row: OxidAddressLike): string | null {
  const street = textValue(row.oxstreet);
  const number = textValue(row.oxstreetnr);
  if (street && number) return `${street} ${number}`;
  return street ?? number;
}

/** Prefer the parent user row, then fall back through delivery addresses. */
export function pickOxidField(
  user: OxidRawUserRecord,
  read: (row: OxidAddressLike) => string | null,
): string | null {
  const fromUser = read(user);
  if (fromUser) return fromUser;

  for (const child of oxidAddressRows(user)) {
    const value = read(child);
    if (value) return value;
  }

  return null;
}

function firstPhone(user: OxidRawUserRecord): string | null {
  return normalizeValue(
    'phone',
    pickOxidField(
      user,
      (row) => textValue(row.oxfon) ?? textValue(row.oxmobfon) ?? textValue(row.oxprivfon),
    ),
  );
}

/**
 * Normalized email used as the cross-system record key (entity_mappings, dedupe).
 * OXID webhooks identify customers by `oxusername`, not mcustnr or oxid.
 */
export function oxidUserRecordId(user: OxidRawUserRecord): string | null {
  const raw = typeof user.oxusername === 'string' ? user.oxusername.trim() : '';
  if (!raw) return null;
  return normalizeValue('email', raw);
}

/**
 * Maps a raw OXID `users` object onto canonical contact fields.
 *
 * Address and company fields are read from the parent user first, then from
 * delivery address rows when the parent row does not carry them.
 */
export function fromOxidUserWebhook(user: OxidRawUserRecord): OxidUserWebhookRecord {
  const id = oxidUserRecordId(user);
  if (!id) {
    throw new Error('raw OXID user payload has no email (oxusername)');
  }

  const fields = normalizeContact({
    email: normalizeValue('email', user.oxusername),
    firstName: normalizeValue('firstName', user.oxfname),
    lastName: normalizeValue('lastName', user.oxlname),
    salutation: normalizeValue('salutation', formatOxidSalutation(user)),
    // oxid stays available on rawOxid for matching; not a default HubSpot field.
    phone: firstPhone(user),
    company: normalizeValue('company', pickOxidField(user, (row) => textValue(row.oxcompany))),
    address: normalizeValue('address', pickOxidField(user, formatOxidStreet)),
    city: normalizeValue('city', pickOxidField(user, (row) => textValue(row.oxcity))),
    zip: normalizeValue('zip', pickOxidField(user, (row) => textValue(row.oxzip))),
    country: normalizeValue(
      'country',
      pickOxidField(
        user,
        (row) => formatOxidCountry(row.oxcountry) ?? textValue(row.oxcountryid),
      ),
    ),
  });

  const updatedAt =
    (typeof user.oxtimestamp === 'string' && user.oxtimestamp.trim()) ||
    (typeof user.oxcreate === 'string' && user.oxcreate.trim()) ||
    null;

  return { id, fields, updatedAt };
}
