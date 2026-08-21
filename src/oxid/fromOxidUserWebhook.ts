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
  oxcompany?: string | null;
  oxfon?: string | null;
  [key: string]: unknown;
}

export interface OxidRawUserRecord extends OxidAddressLike {
  /** Internal OXID object id, when present on the parent user row. */
  oxid?: string | null;
  /** Customer number — stable business id, used as fallback record key. */
  mcustnr?: string | number | null;
  oxusername?: string | null;
  oxfname?: string | null;
  oxlname?: string | null;
  oxcreate?: string | null;
  oxtimestamp?: string | null;
  child_ids?: OxidAddressLike[] | null;
}

export interface OxidUserWebhookRecord {
  id: string;
  fields: CanonicalContact;
  updatedAt: string | null;
}

function textValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/** `oxstreet` + `oxstreetnr` as a single HubSpot address line. */
export function formatOxidStreet(row: OxidAddressLike): string | null {
  const street = textValue(row.oxstreet);
  const number = textValue(row.oxstreetnr);
  if (street && number) return `${street} ${number}`;
  return street ?? number;
}

/** Prefer the parent user row, then fall back through `child_ids`. */
export function pickOxidField(
  user: OxidRawUserRecord,
  read: (row: OxidAddressLike) => string | null,
): string | null {
  const fromUser = read(user);
  if (fromUser) return fromUser;

  for (const child of user.child_ids ?? []) {
    const value = read(child);
    if (value) return value;
  }

  return null;
}

function firstPhone(user: OxidRawUserRecord): string | null {
  return normalizeValue('phone', pickOxidField(user, (row) => textValue(row.oxfon)));
}

/**
 * Resolves the record id used in entity_mappings.oxid_customer_id.
 *
 * Prefer the internal `oxid` id when the shop sends it; otherwise fall back to
 * `mcustnr`, which is what many OXID modules expose on the parent user object.
 */
export function oxidUserRecordId(user: OxidRawUserRecord): string | null {
  const oxid = typeof user.oxid === 'string' ? user.oxid.trim() : '';
  if (oxid) return oxid;

  if (user.mcustnr !== null && user.mcustnr !== undefined) {
    const mcustnr = String(user.mcustnr).trim();
    if (mcustnr) return mcustnr;
  }

  return null;
}

/**
 * Maps a raw OXID `users` object onto canonical contact fields.
 *
 * Address and company fields are read from the parent user first, then from
 * `child_ids` delivery addresses when the parent row does not carry them.
 */
export function fromOxidUserWebhook(user: OxidRawUserRecord): OxidUserWebhookRecord {
  const id = oxidUserRecordId(user);
  if (!id) {
    throw new Error('raw OXID user payload has no oxid or mcustnr id');
  }

  const fields = normalizeContact({
    email: normalizeValue('email', user.oxusername),
    firstName: normalizeValue('firstName', user.oxfname),
    lastName: normalizeValue('lastName', user.oxlname),
    phone: firstPhone(user),
    company: normalizeValue('company', pickOxidField(user, (row) => textValue(row.oxcompany))),
    address: normalizeValue('address', pickOxidField(user, formatOxidStreet)),
    city: normalizeValue('city', pickOxidField(user, (row) => textValue(row.oxcity))),
    zip: normalizeValue('zip', pickOxidField(user, (row) => textValue(row.oxzip))),
    country: normalizeValue(
      'country',
      pickOxidField(user, (row) => textValue(row.oxcountryid)),
    ),
  });

  const updatedAt =
    (typeof user.oxtimestamp === 'string' && user.oxtimestamp.trim()) ||
    (typeof user.oxcreate === 'string' && user.oxcreate.trim()) ||
    null;

  return { id, fields, updatedAt };
}
