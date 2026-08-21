import { randomUUID } from 'node:crypto';
import type { IntegrationRow } from '../../db/repositories/integrations';
import { logger } from '../../lib/logger';
import type { OxidClient, OxidCustomer, OxidCustomerInput } from '../client';

/**
 * In-memory stand-in for a real OXID shop.
 *
 * Lets the whole pipeline - webhooks, sync engine, reconciliation, tests - run
 * end to end before the shop API is available. State is per integration, so
 * multi-tenant isolation is exercised too. Every call is logged, which makes it
 * a usable trace of what the engine would have done against a real shop.
 */
const stores = new Map<string, Map<string, OxidCustomer>>();

function storeFor(integrationId: string): Map<string, OxidCustomer> {
  let store = stores.get(integrationId);
  if (!store) {
    store = new Map();
    stores.set(integrationId, store);
  }
  return store;
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

export class StubOxidClient implements OxidClient {
  readonly mode = 'stub' as const;
  private readonly integrationId: string;

  constructor(integration: IntegrationRow | { id: string }) {
    this.integrationId = integration.id;
  }

  async findCustomerByEmail(email: string): Promise<OxidCustomer | null> {
    const target = normalizeEmail(email);
    for (const customer of storeFor(this.integrationId).values()) {
      if (normalizeEmail(customer.email) === target) return { ...customer };
    }
    return null;
  }

  async getCustomer(id: string): Promise<OxidCustomer | null> {
    const found = storeFor(this.integrationId).get(id);
    return found ? { ...found } : null;
  }

  async createCustomer(input: OxidCustomerInput): Promise<OxidCustomer> {
    const customer: OxidCustomer = {
      id: `stub-${randomUUID()}`,
      email: input.email ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phone: input.phone ?? null,
      updatedAt: new Date().toISOString(),
    };

    storeFor(this.integrationId).set(customer.id, customer);
    logger.info(
      { integrationId: this.integrationId, customerId: customer.id },
      '[stub OXID] created customer',
    );
    return { ...customer };
  }

  async updateCustomer(id: string, input: OxidCustomerInput): Promise<OxidCustomer> {
    const store = storeFor(this.integrationId);
    const existing = store.get(id);
    // A real shop would 404 here; creating on demand keeps the stub usable when a
    // mapping outlives the fake store (e.g. after a restart).
    const merged: OxidCustomer = {
      id,
      email: input.email ?? existing?.email ?? null,
      firstName: input.firstName ?? existing?.firstName ?? null,
      lastName: input.lastName ?? existing?.lastName ?? null,
      phone: input.phone ?? existing?.phone ?? null,
      updatedAt: new Date().toISOString(),
    };

    store.set(id, merged);
    logger.info(
      { integrationId: this.integrationId, customerId: id },
      '[stub OXID] updated customer',
    );
    return { ...merged };
  }

  async listModifiedSince(since: Date): Promise<OxidCustomer[]> {
    return [...storeFor(this.integrationId).values()]
      .filter((customer) => !customer.updatedAt || new Date(customer.updatedAt) >= since)
      .map((customer) => ({ ...customer }));
  }
}

// --- test / dev helpers -----------------------------------------------------

export function seedStubCustomer(integrationId: string, customer: OxidCustomer): void {
  storeFor(integrationId).set(customer.id, customer);
}

export function stubCustomers(integrationId: string): OxidCustomer[] {
  return [...storeFor(integrationId).values()].map((customer) => ({ ...customer }));
}

export function resetStubOxidStore(): void {
  stores.clear();
}
