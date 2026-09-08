import { createHash } from 'node:crypto';
import type { HubspotProperties } from '../hubspot/client';
import type { CanonicalContact } from './fieldMap';

/**
 * Company fields we push OXID → HubSpot Company objects.
 * Drawn from the contact/user payload (OXID has no separate company entity).
 */
export interface CanonicalCompany {
  name: string;
  address?: string | null;
  city?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}

export const companyHubspotProperties = [
  'name',
  'address',
  'city',
  'zip',
  'country',
  'phone',
] as const;

/** Normalize a company name into a stable match key. */
export function companyKeyOf(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build a company record from a synced contact when `company` (oxcompany) is set.
 * Returns null when there is no usable company name.
 */
export function companyFromContact(contact: CanonicalContact): CanonicalCompany | null {
  const name = contact.company?.trim();
  if (!name) return null;

  return {
    name,
    address: contact.address ?? null,
    city: contact.city ?? null,
    zip: contact.zip ?? null,
    country: contact.country ?? null,
    phone: contact.phone ?? null,
  };
}

export function toHubspotCompanyProperties(company: CanonicalCompany): HubspotProperties {
  const properties: HubspotProperties = { name: company.name };
  if (company.address !== undefined) properties.address = company.address ?? '';
  if (company.city !== undefined) properties.city = company.city ?? '';
  if (company.zip !== undefined) properties.zip = company.zip ?? '';
  if (company.country !== undefined) properties.country = company.country ?? '';
  if (company.phone !== undefined) properties.phone = company.phone ?? '';
  return properties;
}

export function companyHash(company: CanonicalCompany): string {
  const canonical = [
    ['name', company.name.trim()],
    ['address', company.address?.trim() ?? ''],
    ['city', company.city?.trim() ?? ''],
    ['zip', company.zip?.trim() ?? ''],
    ['country', company.country?.trim() ?? ''],
    ['phone', company.phone?.trim() ?? ''],
  ];
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
