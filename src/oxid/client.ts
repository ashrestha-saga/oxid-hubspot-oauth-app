import { env } from '../config/env';
import type { IntegrationRow } from '../db/repositories/integrations';
import { StubOxidClient } from './adapters/stubOxidClient';
import { OxapiClient } from './adapters/oxapiClient';

export interface OxidCustomer {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  /** ISO-8601, used by the reconciliation job. */
  updatedAt: string | null;
}

export interface OxidCustomerInput {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

/**
 * Everything the sync engine needs from an OXID shop.
 *
 * This is the seam for the shop-side API: the engine, the webhooks and the
 * reconciliation job all talk to this interface, so swapping the stub for the
 * real shop API touches exactly one file.
 */
export interface OxidClient {
  readonly mode: 'stub' | 'oxapi';
  findCustomerByEmail(email: string): Promise<OxidCustomer | null>;
  getCustomer(id: string): Promise<OxidCustomer | null>;
  createCustomer(input: OxidCustomerInput): Promise<OxidCustomer>;
  updateCustomer(id: string, input: OxidCustomerInput): Promise<OxidCustomer>;
  listModifiedSince(since: Date): Promise<OxidCustomer[]>;
}

type OxidClientFactory = (integration: IntegrationRow) => OxidClient;

let factory: OxidClientFactory = (integration) =>
  env.OXID_CLIENT_MODE === 'oxapi' ? new OxapiClient(integration) : new StubOxidClient(integration);

export function oxidClientFor(integration: IntegrationRow): OxidClient {
  return factory(integration);
}

/** Test seam: lets a test inject a fake shop without touching env. */
export function setOxidClientFactory(next: OxidClientFactory): void {
  factory = next;
}

export function resetOxidClientFactory(): void {
  factory = (integration) =>
    env.OXID_CLIENT_MODE === 'oxapi'
      ? new OxapiClient(integration)
      : new StubOxidClient(integration);
}
