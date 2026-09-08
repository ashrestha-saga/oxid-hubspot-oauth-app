import { z } from 'zod';
import { type CanonicalContact, emailOf } from '../sync/fieldMap';
import {
  canonicalFromOxidCustomer,
  canonicalFromOxidUser,
  defaultTenantFieldMap,
  type TenantFieldMap,
} from '../sync/tenantFieldMap';
import { pickNeedfulOxidUser } from './fromOxidUserWebhook';
import type { SourceRecord } from '../sync/syncContact';

const webhookEventSchema = z.enum([
  'customer.created',
  'customer.updated',
  'customer.deleted',
]);

/** Normalized camelCase customer (docs/oxid-module-contract.md section 2.2). */
export const oxidWebhookNormalizedSchema = z.object({
  event: webhookEventSchema.default('customer.updated'),
  occurredAt: z.string().optional(),
  shopId: z.string().optional(),
  customer: z.object({
    id: z.string().optional(),
    email: z.string().min(1),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    phone: z.string().nullish(),
    company: z.string().nullish(),
    address: z.string().nullish(),
    city: z.string().nullish(),
    zip: z.string().nullish(),
    country: z.string().nullish(),
    updatedAt: z.string().nullish(),
  }),
});

/** Raw OXID user row (`oxusername`, `oxfname`, …) as in user.json. */
export const oxidRawUserSchema = z
  .object({
    oxid: z.string().nullish(),
    mcustnr: z.union([z.string(), z.number()]).nullish(),
    oxusername: z.string().nullish(),
    oxfname: z.string().nullish(),
    oxlname: z.string().nullish(),
    oxsal: z.string().nullish(),
    salutation: z
      .object({
        id: z.string().nullish(),
        title: z.string().nullish(),
        title_1: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    oxfon: z.string().nullish(),
    oxcreate: z.string().nullish(),
    oxtimestamp: z.string().nullish(),
    oxaddress: z.array(z.record(z.unknown())).nullish(),
    child_ids: z
      .array(
        z
          .object({
            oxid: z.string().nullish(),
            oxfon: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
    deliveryAddress: z
      .array(
        z
          .object({
            oxid: z.string().nullish(),
            oxfon: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough()
  .refine(
    (user) => {
      const email = typeof user.oxusername === 'string' ? user.oxusername.trim() : '';
      return email.length > 0;
    },
    { message: 'users must include oxusername (email)' },
  );

export const oxidWebhookRawUsersSchema = z.object({
  event: webhookEventSchema.default('customer.updated'),
  occurredAt: z.string().optional(),
  shopId: z.string().optional(),
  users: oxidRawUserSchema,
});

export const oxidWebhookBareUsersSchema = z.object({
  users: oxidRawUserSchema,
});

export type OxidWebhookNormalizedPayload = z.infer<typeof oxidWebhookNormalizedSchema>;
export type OxidWebhookRawUsersPayload = z.infer<typeof oxidWebhookRawUsersSchema>;

export type ParsedOxidWebhook =
  | { format: 'normalized'; payload: OxidWebhookNormalizedPayload }
  | { format: 'raw_users'; payload: OxidWebhookRawUsersPayload }
  | { format: 'bare_users'; payload: z.infer<typeof oxidWebhookBareUsersSchema> };

/** @deprecated use oxidWebhookNormalizedSchema — kept for existing imports/tests */
export const oxidWebhookSchema = oxidWebhookNormalizedSchema;
export type OxidWebhookPayload = OxidWebhookNormalizedPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts any supported OXID webhook body: normalized `customer`, wrapped
 * `users` (with event/shopId/occurredAt), or bare `{ users }` only.
 */
export function parseOxidWebhook(body: unknown): ParsedOxidWebhook | null {
  const normalized = oxidWebhookNormalizedSchema.safeParse(body);
  if (normalized.success) return { format: 'normalized', payload: normalized.data };

  if (!isRecord(body) || !('users' in body)) return null;

  const users = oxidRawUserSchema.safeParse(body.users);
  if (!users.success) return null;

  const keys = Object.keys(body);
  const isBareOnly = keys.length === 1 && keys[0] === 'users';
  if (isBareOnly) {
    return { format: 'bare_users', payload: { users: users.data } };
  }

  const hasWrapperMeta = 'event' in body || 'shopId' in body || 'occurredAt' in body;
  if (!hasWrapperMeta) return null;

  const wrapped = oxidWebhookRawUsersSchema.safeParse(body);
  if (!wrapped.success) return null;

  return { format: 'raw_users', payload: wrapped.data };
}

export function webhookEventFrom(parsed: ParsedOxidWebhook): string {
  if (parsed.format === 'bare_users') return 'customer.updated';
  return parsed.payload.event ?? 'customer.updated';
}

export function shopIdFrom(parsed: ParsedOxidWebhook): string | undefined {
  if (parsed.format === 'bare_users') return undefined;
  return parsed.payload.shopId;
}

/** Builds the sync job payload from any supported webhook format. */
export function sourceRecordFromWebhook(
  parsed: ParsedOxidWebhook,
  map = defaultTenantFieldMap(),
): SourceRecord {
  const event = webhookEventFrom(parsed);

  if (parsed.format === 'normalized') {
    const customer = parsed.payload.customer as Record<string, unknown>;
    const fields: CanonicalContact = canonicalFromOxidCustomer(customer, map);
    const id = emailOf(fields);
    if (!id) {
      throw new Error('normalized OXID customer payload requires email');
    }
    return {
      id,
      fields,
      rawOxid: customer,
      deleted: event === 'customer.deleted',
    };
  }

  const users =
    parsed.format === 'raw_users' ? parsed.payload.users : parsed.payload.users;
  const needful = pickNeedfulOxidUser(users as Record<string, unknown>);
  const mapped = canonicalFromOxidUser(needful, map);

  return {
    id: mapped.id,
    fields: mapped.fields,
    rawOxid: needful,
    deleted: event === 'customer.deleted',
  };
}

/** @deprecated use sourceRecordFromWebhook */
export function sourceRecordFrom(payload: OxidWebhookNormalizedPayload): SourceRecord {
  return sourceRecordFromWebhook({ format: 'normalized', payload });
}
