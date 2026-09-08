import { z } from 'zod';

const text = z.union([z.string(), z.number()]).nullish();

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const textValue = String(value).trim();
  return textValue.length > 0 ? textValue : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function joinStreet(street: string | null, streetNr: string | null): string | null {
  const parts = [street, streetNr].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** HubSpot allow-list for hs_recurring_billing_period. */
export const HUBSPOT_BILLING_FREQUENCIES = new Set([
  'weekly',
  'every_two_weeks',
  'monthly',
  'quarterly',
  'every_four_months',
  'semi_annually',
  'annually',
  'every_two_years',
  'every_three_years',
]);

const oxidOrderItemSchema = z
  .object({
    oxid: text,
    oxamount: text,
    oxartnum: text,
    oxtitle: text,
    oxshortdesc: text,
    oxnetprice: text,
    oxbrutprice: text,
    unit_discount: text,
    billing_start_date: text,
    billing_frequency: text,
    url: text,
    product_url: text,
    oxurl: text,
  })
  .passthrough();

const oxidOrderUserSchema = z
  .object({
    oxid: text,
    oxusername: text,
    oxcompany: text,
    oxfname: text,
    oxlname: text,
    oxstreet: text,
    oxstreetnr: text,
    oxcity: text,
    oxzip: text,
    oxfon: text,
    country: text,
  })
  .passthrough();

const oxidBillingAddressSchema = z
  .object({
    oxbillcompany: text,
    oxbillfname: text,
    oxbilllname: text,
    oxbillstreet: text,
    oxbillstreetnr: text,
    oxbillcity: text,
    oxbillzip: text,
    oxbillfon: text,
    oxbillemail: text,
  })
  .passthrough()
  .nullish();

const oxidOrderSchema = z
  .object({
    oxid: text,
    oxordernr: text,
    oxorderdate: text,
    oxtotalordersum: text,
    oxcurrency: text,
    oxstorno: text,
    shopname: text,
    user: oxidOrderUserSchema,
    items: z.array(oxidOrderItemSchema).min(1),
    billingAddress: oxidBillingAddressSchema,
  })
  .passthrough();

export const oxidOrderWebhookSchema = z.object({
  orders: oxidOrderSchema,
});

export interface ClosedOrderItem {
  oxid: string | null;
  name: string;
  description: string | null;
  articleNumber: string | null;
  quantity: number;
  price: number;
  discount: number;
  billingStartDate: string | null;
  billingFrequency: string | null;
  productUrl: string | null;
}

export interface ClosedOrderContactDetails {
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  company: string;
}

export interface ClosedOrder {
  oxidOrderId: string;
  orderNumber: string | null;
  orderDateIso: string;
  amount: number;
  currency: string | null;
  shopName: string | null;
  companyName: string;
  contact: ClosedOrderContactDetails;
  items: ClosedOrderItem[];
  raw: unknown;
}

function toIsoDate(value: string | null): string {
  if (!value) return new Date().toISOString();
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function prefer(
  primary: unknown,
  fallback: unknown,
): string | null {
  return asString(primary) ?? asString(fallback);
}

export type ParseClosedOrderResult =
  | { ok: true; order: ClosedOrder }
  | { ok: false; message: string };

/**
 * Validates and normalizes an OXID closed-order webhook body.
 * Identity is always orders.user.oxusername (never billing email).
 */
export function parseClosedOrderWebhook(body: unknown): ParseClosedOrderResult {
  const parsed = oxidOrderWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: 'invalid payload: expected { orders: { user, items, … } }' };
  }

  const orders = parsed.data.orders;
  const email = asString(orders.user.oxusername)?.toLowerCase() ?? null;
  if (!email || !email.includes('@')) {
    return { ok: false, message: 'orders.user.oxusername (email) is required' };
  }

  const companyName =
    asString(orders.billingAddress?.oxbillcompany) ?? asString(orders.user.oxcompany);
  if (!companyName) {
    return { ok: false, message: 'company name is required (billingAddress.oxbillcompany or user.oxcompany)' };
  }

  const oxidOrderId = asString(orders.oxid);
  if (!oxidOrderId) {
    return { ok: false, message: 'orders.oxid is required' };
  }

  if (!orders.items.length) {
    return { ok: false, message: 'orders.items must be a non-empty array' };
  }

  const billing = orders.billingAddress ?? undefined;
  const contact: ClosedOrderContactDetails = {
    email,
    firstName: prefer(billing?.oxbillfname, orders.user.oxfname),
    lastName: prefer(billing?.oxbilllname, orders.user.oxlname),
    phone: prefer(billing?.oxbillfon, orders.user.oxfon),
    address: joinStreet(
      prefer(billing?.oxbillstreet, orders.user.oxstreet),
      prefer(billing?.oxbillstreetnr, orders.user.oxstreetnr),
    ),
    city: prefer(billing?.oxbillcity, orders.user.oxcity),
    zip: prefer(billing?.oxbillzip, orders.user.oxzip),
    country: asString(orders.user.country),
    company: companyName,
  };

  const items: ClosedOrderItem[] = orders.items.map((item) => {
    const price =
      asNumber(item.oxbrutprice) ?? asNumber(item.oxnetprice) ?? 0;
    const frequencyRaw = asString(item.billing_frequency)?.toLowerCase() ?? null;
    const billingFrequency =
      frequencyRaw && HUBSPOT_BILLING_FREQUENCIES.has(frequencyRaw) ? frequencyRaw : null;

    return {
      oxid: asString(item.oxid),
      name: asString(item.oxtitle) ?? 'Order Item',
      description: asString(item.oxshortdesc),
      articleNumber: asString(item.oxartnum),
      quantity: asNumber(item.oxamount) ?? 1,
      price,
      discount: asNumber(item.unit_discount) ?? 0,
      billingStartDate: toIsoDate(
        asString(item.billing_start_date) ?? asString(orders.oxorderdate),
      ),
      billingFrequency,
      productUrl:
        asString(item.url) ?? asString(item.product_url) ?? asString(item.oxurl),
    };
  });

  return {
    ok: true,
    order: {
      oxidOrderId,
      orderNumber: asString(orders.oxordernr),
      orderDateIso: toIsoDate(asString(orders.oxorderdate)),
      amount: asNumber(orders.oxtotalordersum) ?? 0,
      currency: asString(orders.oxcurrency),
      shopName: asString(orders.shopname),
      companyName,
      contact,
      items,
      raw: body,
    },
  };
}

export interface ClosedOrderJobPayload {
  kind: 'closed_order';
  order: ClosedOrder;
}
