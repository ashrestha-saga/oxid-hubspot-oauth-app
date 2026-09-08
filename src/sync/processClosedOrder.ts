import type { IntegrationRow } from '../db/repositories/integrations';
import { syncEventsRepo } from '../db/repositories/syncEvents';
import type { HubspotProperties } from '../hubspot/client';
import { hubspotClientFor } from '../hubspot/client';
import { describeError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { ClosedOrder, ClosedOrderItem } from '../oxid/orderWebhookPayload';
import { associateContactWithCompany } from './associateContactCompany';
import type { CanonicalContact } from './fieldMap';
import { ensureContactFromOrder } from './ensureContactFromOrder';
import { syncCompanyFromContact } from './syncCompany';

export interface ProcessClosedOrderInput {
  integration: IntegrationRow;
  order: ClosedOrder;
}

export interface ProcessClosedOrderResult {
  success: true;
  deal_id: string;
  contact_id: string;
  company_id: string | null;
  owner_id: null;
  line_item_ids: string[];
  contact_created: boolean;
}

function dealName(order: ClosedOrder): string {
  const shop = order.shopName?.trim() || 'Shop';
  const nr = order.orderNumber?.trim() || order.oxidOrderId;
  return `${shop} - Bestellung ${nr}`;
}

function lineItemProperties(item: ClosedOrderItem): HubspotProperties {
  const properties: HubspotProperties = {
    name: item.name,
    quantity: String(item.quantity),
    price: String(item.price),
  };
  if (item.description) properties.description = item.description;
  if (item.articleNumber) properties.artikelnummer = item.articleNumber;
  if (item.discount) properties.discount = String(item.discount);
  if (item.billingStartDate) properties.hs_billing_start_date = item.billingStartDate;
  if (item.billingFrequency) {
    properties.hs_recurring_billing_period = item.billingFrequency;
  }
  if (item.productUrl) properties.hs_product_url = item.productUrl;
  return properties;
}

/**
 * OXID closed order → HubSpot: ensure contact + company, create Closed Won deal + line items.
 * Owner resolution is skipped (owner_id always null).
 */
export async function processClosedOrder(
  input: ProcessClosedOrderInput,
): Promise<ProcessClosedOrderResult> {
  const { integration, order } = input;
  const client = hubspotClientFor(integration.id);

  const contactResult = await ensureContactFromOrder({
    integrationId: integration.id,
    contact: order.contact,
  });

  const contactForCompany: CanonicalContact = {
    email: order.contact.email,
    firstName: order.contact.firstName,
    lastName: order.contact.lastName,
    phone: order.contact.phone,
    company: order.companyName,
    address: order.contact.address,
    city: order.contact.city,
    zip: order.contact.zip,
    country: order.contact.country,
  };

  let companyId: string | null = null;
  try {
    const companyResult = await syncCompanyFromContact({
      integration,
      contact: contactForCompany,
    });
    if (companyResult.hubspotCompanyId) {
      companyId = companyResult.hubspotCompanyId;
      await associateContactWithCompany({
        integrationId: integration.id,
        hubspotContactId: contactResult.hubspotContactId,
        hubspotCompanyId: companyResult.hubspotCompanyId,
      });
    }
  } catch (error) {
    logger.warn(
      { err: error, integrationId: integration.id, orderId: order.oxidOrderId },
      'closed order: company upsert/association failed; continuing with deal',
    );
  }

  const dealProperties: HubspotProperties = {
    dealname: dealName(order),
    dealstage: 'closedwon',
    pipeline: 'default',
    closedate: order.orderDateIso,
    amount: String(order.amount),
  };

  const deal = await client.createDeal(dealProperties, {
    contactId: contactResult.hubspotContactId,
    companyId,
  });

  const lineItemIds: string[] = [];
  for (const item of order.items) {
    try {
      const lineItem = await client.createLineItem(lineItemProperties(item), deal.id);
      lineItemIds.push(lineItem.id);
    } catch (error) {
      logger.error(
        {
          err: error,
          integrationId: integration.id,
          dealId: deal.id,
          articleNumber: item.articleNumber,
        },
        'closed order: line item create failed',
      );
      throw error;
    }
  }

  await syncEventsRepo.log({
    integrationId: integration.id,
    direction: 'oxid_to_hubspot',
    status: 'success',
    detail: {
      kind: 'closed_order',
      oxidOrderId: order.oxidOrderId,
      dealId: deal.id,
      contactId: contactResult.hubspotContactId,
      companyId,
      lineItemIds,
    },
  });

  logger.info(
    {
      integrationId: integration.id,
      oxidOrderId: order.oxidOrderId,
      dealId: deal.id,
      contactId: contactResult.hubspotContactId,
      companyId,
      lineItemCount: lineItemIds.length,
    },
    'closed order processed',
  );

  return {
    success: true,
    deal_id: deal.id,
    contact_id: contactResult.hubspotContactId,
    company_id: companyId,
    owner_id: null,
    line_item_ids: lineItemIds,
    contact_created: contactResult.created,
  };
}

export function describeClosedOrderError(error: unknown): string {
  return describeError(error).message;
}
