import type { CanonicalContact } from '../sync/fieldMap';
import type { TenantFieldMap } from '../sync/tenantFieldMap';
import { ExternalApiError } from '../lib/errors';
import type { OxidCustomer } from './client';

export const USER_API_UPDATE_PATH = '/index.php?cl=userapi&fnc=updateUsers';
export const USER_API_INSERT_PATH = '/index.php?cl=userapi&fnc=insertUsers';

export interface OxidUserApiResponse {
  status?: string;
  message?: string;
  data?: unknown[];
  errors?: Record<string, unknown> | unknown[];
}

/** Thrown when updateUsers reports the user does not exist (caller may insert). */
export class OxidUserNotFoundError extends Error {
  readonly code = 'oxid_user_not_found';

  constructor(message = 'User not found') {
    super(message);
    this.name = 'OxidUserNotFoundError';
  }
}

export function userApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Maps HubSpot canonical contact fields to OXID User API column names using the
 * tenant field map (`oxusername`, `oxfname`, …).
 *
 * Write-only safety: skips `oxid` and dotted paths (e.g. `child_ids.0.oxfon`).
 * Those are valid for reading samples / id config, but not User API columns.
 */
export function buildOxidUserRecord(
  contact: CanonicalContact,
  map: TenantFieldMap,
  email: string,
): Record<string, string | number> {
  const normalizedEmail = email.trim().toLowerCase();
  const record: Record<string, string | number> = {
    oxusername: normalizedEmail,
    oxactive: 1,
  };

  for (const binding of map.fields) {
    if (!binding.oxidPath || binding.canonical === 'email' || binding.canonical === 'oxidId') {
      continue;
    }
    if (!isWritableOxidUserPath(binding.oxidPath)) continue;
    const value = contact[binding.canonical];
    if (value === undefined || value === null || value === '') continue;
    record[binding.oxidPath] = value;
  }

  return record;
}

/** Paths that may appear in field maps for reads but must not be sent to User API. */
export function isWritableOxidUserPath(oxidPath: string): boolean {
  if (oxidPath === 'oxid' || oxidPath === 'OXID') return false;
  if (oxidPath.includes('.')) return false;
  return true;
}

function messageFromBody(body: OxidUserApiResponse): string {
  if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();

  if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
    const parts = Object.entries(body.errors).flatMap(([key, value]) => {
      if (typeof value === 'string') return [`${key}: ${value}`];
      if (Array.isArray(value)) return value.map((entry) => `${key}: ${String(entry)}`);
      return [`${key}: ${JSON.stringify(value)}`];
    });
    if (parts.length > 0) return parts.join('; ');
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return body.errors.map((entry) => String(entry)).join('; ');
  }

  return 'OXID User API request failed';
}

export function isUserNotFoundMessage(message: string): boolean {
  return /user(\s*\([^)]+\))?\s+not found/i.test(message) || /user not found/i.test(message);
}

export function parseUserApiResponse(body: OxidUserApiResponse): OxidCustomer {
  const status = (body.status ?? '').toLowerCase();
  const message = messageFromBody(body);

  if (status !== 'success') {
    if (isUserNotFoundMessage(message)) {
      throw new OxidUserNotFoundError(message);
    }
    throw new ExternalApiError(message, {
      system: 'oxid',
      status: 200,
      details: body,
    });
  }

  const row = Array.isArray(body.data) ? body.data[0] : null;
  if (!row || typeof row !== 'object') {
    if (isUserNotFoundMessage(message)) {
      throw new OxidUserNotFoundError(message);
    }
    throw new ExternalApiError('OXID User API returned success without user data', {
      system: 'oxid',
      status: 200,
      details: body,
    });
  }

  return oxidCustomerFromApiRow(row as Record<string, unknown>);
}

export function oxidCustomerFromApiRow(row: Record<string, unknown>): OxidCustomer {
  const id =
    (typeof row.oxid === 'string' && row.oxid) ||
    (typeof row.OXID === 'string' && row.OXID) ||
    (typeof row.oxusername === 'string' && row.oxusername) ||
    (typeof row.OXUSERNAME === 'string' && row.OXUSERNAME) ||
    'unknown';

  return {
    id,
    email:
      (typeof row.oxusername === 'string' ? row.oxusername : null) ??
      (typeof row.OXUSERNAME === 'string' ? row.OXUSERNAME : null),
    firstName:
      (typeof row.oxfname === 'string' ? row.oxfname : null) ??
      (typeof row.OXFNAME === 'string' ? row.OXFNAME : null),
    lastName:
      (typeof row.oxlname === 'string' ? row.oxlname : null) ??
      (typeof row.OXLNAME === 'string' ? row.OXLNAME : null),
    phone:
      (typeof row.oxfon === 'string' ? row.oxfon : null) ??
      (typeof row.OXFON === 'string' ? row.OXFON : null),
    updatedAt:
      (typeof row.oxtimestamp === 'string' ? row.oxtimestamp : null) ??
      (typeof row.OXTIMESTAMP === 'string' ? row.OXTIMESTAMP : null) ??
      new Date().toISOString(),
  };
}
