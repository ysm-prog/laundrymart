import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import type { LaundryPriceRow } from "@/lib/domain/laundry-billing";
import { buildItemPriceRows } from "@/lib/domain/laundry-prices";
import { ItemPriceTable } from "../../../invoices/prices/item-price-table";
import {
  PRICE_LIST_ITEM_COLUMNS, type PriceListItem,
} from "../../../invoices/prices/items";

export const metadata = { title: "Laundry prices" };
export const dynamic = "force-dynamic";

/**
 * One customer's own laundry prices, by item code.
 *
 * A row here beats the usual price; a blank row means "charge them the usual
 * price", which is why that price is shown beside every field rather than being
 * something the operator has to remember or go and look up.
 */
export default async function CustomerPricesPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");

  const supabase = await createClient();

  const { data: customer } = await supabase
    .from("customers").select("id, business_name")
    // §23: a platform admin reads every laundry, and this id is posted back into
    // a write scoped to one — so a customer from another business must resolve
    // to nothing here rather than to a price list saved into the wrong tenant.
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<{ id: string; business_name: string }>();
  if (!customer) notFound();

  // One read for both lists: the customer's rows and the usual prices arrive
  // together, exactly as the pricer reads them.
  const [{ data: items }, { data: prices }] = await Promise.all([
    supabase
      .from("items")
      .select(PRICE_LIST_ITEM_COLUMNS)
      .eq("tenant_id", session.tenantId)
      .is("deleted_at", null)
      .eq("status", "active")
      .eq("is_sell", true)
      .order("item_code", { nullsFirst: false })
      .returns<PriceListItem[]>(),
    supabase
      .from("laundry_prices")
      .select("customer_id, item_type, item_id, unit_price, bag_price, taxable")
      .eq("tenant_id", session.tenantId)
      .or(`customer_id.eq.${id},customer_id.is.null`)
      .returns<LaundryPriceRow[]>(),
  ]);

  // The customer's own rows fill the fields; the tenant's fill the line beneath
  // each one — so a price inherited from the usual list renders as a blank field
  // with that price under it, and the screen never shows an override that was
  // not actually set.
  const rows = buildItemPriceRows(items ?? [], prices ?? [], id);

  return (
    <PageContainer width="form">
      <div className="space-y-6">
        <PageHeader
          title="Laundry prices"
          description={`What ${customer.business_name} is charged for the laundry they hand over.`}
          back={{ href: `/customers/${id}`, label: "Back to customer" }}
        />

        <Notice tone="info">
          Leave a price blank to charge this customer your usual price. Anything you enter here is
          what their jobs are priced at from now on — GST included.
        </Notice>

        <ItemPriceTable
          title={`Prices for ${customer.business_name}`}
          description="Blank means the usual price, shown under each item code."
          rows={rows}
          customerId={id}
          returnTo={`/customers/${id}/prices`}
          writable={writable}
          submitLabel="Save their prices"
        />
      </div>
    </PageContainer>
  );
}
