import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { defaultPriceList, priceListFor, type LaundryPriceRow } from "@/lib/domain/laundry-billing";
import type { ItemType } from "@/lib/domain/laundry-orders";
import { PriceTable, type PriceRowValue } from "../../../invoices/prices/price-table";

export const metadata = { title: "Laundry prices" };
export const dynamic = "force-dynamic";

/**
 * One customer's own laundry prices.
 *
 * A row here beats the tenant default; a blank row means "charge them the usual
 * price", which is why the default is shown beside every field rather than
 * being something the operator has to remember or go and look up.
 */
export default async function CustomerPricesPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");

  const supabase = await createClient();

  const { data: customer } = await supabase
    .from("customers").select("id, business_name").eq("id", id)
    .maybeSingle<{ id: string; business_name: string }>();
  if (!customer) notFound();

  // One read for both lists: the customer's rows and the tenant default arrive
  // together, exactly as the invoice generator reads them.
  const { data } = await supabase
    .from("laundry_prices")
    .select("customer_id, item_type, unit_price, bag_price, taxable")
    .or(`customer_id.eq.${id},customer_id.is.null`)
    .returns<LaundryPriceRow[]>();

  const rows = data ?? [];
  const own = rows.filter((row) => row.customer_id === id);

  const toValues = (source: Map<ItemType, { unitPrice: number; bagPrice: number | null; taxable: boolean }>) =>
    new Map<ItemType, PriceRowValue>([...source].map(([itemType, price]) => [itemType, {
      unitPrice: price.unitPrice, bagPrice: price.bagPrice, taxable: price.taxable,
    }]));

  // `own` only, so a price inherited from the default renders as a blank field
  // with the usual price beneath it — the screen never shows an override that
  // was not actually set.
  const values = toValues(priceListFor(id, own));
  const defaults = toValues(defaultPriceList(rows));

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
          what the monthly invoice run uses for their jobs.
        </Notice>

        <PriceTable
          title={`Prices for ${customer.business_name}`}
          description="Blank means the usual price, shown under each kind of laundry."
          values={values}
          defaults={defaults}
          customerId={id}
          returnTo={`/customers/${id}/prices`}
          writable={writable}
          submitLabel="Save their prices"
        />
      </div>
    </PageContainer>
  );
}
