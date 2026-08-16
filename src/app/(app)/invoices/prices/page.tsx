import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import { defaultPriceList, type LaundryPriceRow } from "@/lib/domain/laundry-billing";
import { PriceTable, type PriceRowValue } from "./price-table";
import type { ItemType } from "@/lib/domain/laundry-orders";

export const metadata = { title: "Laundry prices" };
export const dynamic = "force-dynamic";

/**
 * The tenant's default price list: what a customer is charged for each kind of
 * laundry unless they have a price of their own.
 *
 * Lives under Invoices rather than under Settings because it is a finance
 * record — it is gated on `invoices.write`, exactly like the table it writes
 * (0018), and the monthly run links here by name when it finds laundry it could
 * not price.
 */
export default async function LaundryPricesPage() {
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");

  const supabase = await createClient();
  const { data } = await supabase
    .from("laundry_prices")
    .select("customer_id, item_type, unit_price, bag_price, taxable")
    .is("customer_id", null)
    .returns<LaundryPriceRow[]>();

  // Resolved through the same function the invoice generator uses, so the screen
  // cannot show a price the run would not charge.
  const resolved = defaultPriceList(data ?? []);
  const values = new Map<ItemType, PriceRowValue>(
    [...resolved].map(([itemType, price]) => [itemType, {
      unitPrice: price.unitPrice, bagPrice: price.bagPrice, taxable: price.taxable,
    }]),
  );

  return (
    <PageContainer width="form">
      <div className="space-y-6">
        <PageHeader
          title="Laundry prices"
          description="What each kind of laundry costs. Used to bill the jobs you take in at the counter."
        />

        <Notice tone="info">
          These are your usual prices. A customer who has agreed something different gets their own
          list on their page — anything left blank there falls back to the price here.
          A kind of laundry with no price is left off the invoice and reported when you run
          the month, rather than being billed at nothing.
        </Notice>

        <PriceTable
          title="Your usual prices"
          description="Price per piece for counted laundry, and an optional price per bag for bulk lots."
          values={values}
          writable={writable}
          submitLabel="Save usual prices"
        />
      </div>
    </PageContainer>
  );
}
