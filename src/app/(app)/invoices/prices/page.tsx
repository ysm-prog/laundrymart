import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { Notice, PageContainer, PageHeader } from "@/components/ui";
import type { LaundryPriceRow } from "@/lib/domain/laundry-billing";
import { buildItemPriceRows } from "@/lib/domain/laundry-prices";
import { SubmitButton } from "@/components/form";
import { ItemPriceTable } from "./item-price-table";
import { AddItemCard } from "./add-item-card";
import { fillPricesFromItems } from "./actions";
import { PRICE_LIST_ITEM_COLUMNS, type PriceListItem } from "./items";

export const metadata = { title: "Laundry prices" };
export const dynamic = "force-dynamic";

/**
 * The laundry's usual price list: what a customer is charged for each **item
 * code**, unless they have a price of their own.
 *
 * Lives under Money rather than under Settings because it is a finance record —
 * it is gated on `invoices.write`, exactly like the table it writes (0018/0033),
 * and the pricer links here by name when it finds laundry it could not price.
 *
 * **Keyed on the item code since 2026-08-27, not on the nine kinds of laundry.**
 * The categories are what the screen could offer before the item master existed;
 * with 254 real codes in the list they are the wrong unit — a laundry charges
 * $0.22 for one black towel and $0.40 for another, and "towels" cannot say that.
 * `laundry_prices.item_id` has been able to hold the answer since 0032 and no
 * screen could write one, which is why the live rows number **zero** and the
 * price ended up inside the item code instead (`T22`, `T38`, `T40` — three
 * master records all named "Towels - Black").
 */
export default async function LaundryPricesPage() {
  const session = await requireCapability("invoices.read");
  const writable = can(session.role, "invoices.write");
  const canAddItems = can(session.role, "items.write");

  const supabase = await createClient();

  // Both reads name the tenant rather than leaning on RLS (§23): a platform
  // admin's session reads every laundry, an id from this list is posted straight
  // back into a write scoped to one, and the usual list is the rows with
  // `customer_id is null` — unfiltered, two laundries' defaults both come back.
  const [{ data: items }, { data: prices }] = await Promise.all([
    supabase
      .from("items")
      .select(PRICE_LIST_ITEM_COLUMNS)
      .eq("tenant_id", session.tenantId)
      .is("deleted_at", null)
      .eq("status", "active")
      // An item the laundry only *buys* is not something a customer is charged
      // for. This is the lever an owner has over the length of this list: untick
      // "I sell this" on the drums of detergent and the fan shafts and they stop
      // being offered here, without deleting stock records the plant still needs.
      .eq("is_sell", true)
      .order("item_code", { nullsFirst: false })
      .returns<PriceListItem[]>(),
    supabase
      .from("laundry_prices")
      .select("customer_id, item_type, item_id, unit_price, bag_price, taxable")
      .eq("tenant_id", session.tenantId)
      .is("customer_id", null)
      .returns<LaundryPriceRow[]>(),
  ]);

  const rows = buildItemPriceRows(items ?? [], prices ?? [], null);
  // How many could be filled in one press — the count the offer below quotes, so
  // it cannot promise a number the action would not deliver.
  const unpriced = rows.filter(
    (row) => row.price === null && Number(row.item.sell_price ?? 0) > 0,
  ).length;

  return (
    <PageContainer width="form">
      <div className="space-y-6">
        <PageHeader
          title="Laundry prices"
          description="What each item code costs. Used to bill the jobs you take in at the counter."
        />

        <Notice tone="info">
          These are your usual prices, by item code. A customer who has agreed something different
          gets their own list on their page — anything left blank there falls back to the price
          here. Enter what the customer pays, GST included.
        </Notice>

        {/*
          The one thing this screen must not overstate. A price change reaches
          every job that has not been approved yet — pricing a job, picking an
          item on its charges, adding an invoice line — and it deliberately does
          **not** rewrite a charge that approval has already frozen, because that
          is the amount a customer may already have been told. `0044` narrowed
          that guard to allow an account code and nothing else, so this is the
          database refusing, not the screen choosing.
        */}
        <Notice tone="warning" title="Where a change lands">
          A new price is used by every job you price or approve from now on, and by any charge or
          invoice line where you pick the item. A job you have <strong>already approved</strong>
          {" "}keeps the price it was approved at, even on a draft invoice — re-price it before
          approving, or take it off the draft, if the new rate should apply.
        </Notice>

        {writable && unpriced > 0 ? (
          /*
            The list starts empty on a laundry whose item master came from MYOB,
            and every row then reads "No price set" — while the app is in fact
            already billing those items at their MYOB rate, through
            `liveItemRate`'s fallback. That reads as an app with no prices in it,
            which is exactly how this screen was first reported.

            One press brings those prices onto the list, converted rather than
            copied: an item stating its price GST-exclusive is grossed up,
            because a list rate is what the customer pays. It never touches a row
            that already has a price, so it is safe to press twice and safe to
            press after re-rating a code.
          */
          <Notice tone="info" title={`${unpriced} item ${unpriced === 1 ? "code has" : "codes have"} a selling price and no rate here`}>
            <p className="mb-3">
              They are billing at the item&rsquo;s own selling price today. Bring those onto this
              list and you can see them, edit them, and set a different rate per customer. GST is
              added where the item&rsquo;s price is stated without it. Nothing you have already
              priced is changed.
            </p>
            <form action={fillPricesFromItems}>
              <SubmitButton variant="secondary" size="md" pendingLabel="Pricing…">
                Fill from my item prices
              </SubmitButton>
            </form>
          </Notice>
        ) : null}

        <ItemPriceTable
          title="Your usual prices"
          description="Price per piece for counted laundry, and an optional price per bag for bulk lots."
          rows={rows}
          writable={writable}
          submitLabel="Save usual prices"
        />

        {canAddItems ? <AddItemCard /> : null}
      </div>
    </PageContainer>
  );
}
