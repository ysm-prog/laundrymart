"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, returnTo } from "@/lib/actions";
import { parsePriceForm } from "./price-form";

/**
 * Save a laundry price list — the tenant's default, or one customer's own.
 *
 * Both screens post the same nine rows to this one action; `customer_id` is
 * what says which list is being written. Guarded by `invoices.write`, matching
 * the four roles 0018 lets touch the table: a price list is a finance record,
 * and the screen must not offer what the database will refuse.
 *
 * Written as read → update / insert / delete rather than as an upsert. The
 * unique index is `(tenant_id, customer_id, item_type) nulls not distinct`, and
 * inferring an index over a nullable column through PostgREST's `on_conflict=`
 * is exactly the sort of thing that works in testing and surprises in
 * production. Diffing against what is there also means a save never has a
 * window with no prices in it, which a delete-then-insert would.
 */
export async function saveLaundryPrices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");

  const rawCustomer = formData.get("customer_id");
  const customerId = typeof rawCustomer === "string" && rawCustomer.trim() !== ""
    ? rawCustomer.trim()
    : null;
  const path = returnTo(formData, customerId ? `/customers/${customerId}/prices` : "/invoices/prices");

  const parsed = parsePriceForm(formData);
  if (!parsed.ok) return fail(path, parsed.error);

  const supabase = await createClient();

  // The rows for this scope only. `is("customer_id", null)` rather than
  // `eq(…, null)`: the default list is the rows with no customer, and PostgREST
  // spells that as IS NULL.
  const scope = supabase.from("laundry_prices").select("id, item_type");
  const { data: existing, error: readError } = await (
    customerId ? scope.eq("customer_id", customerId) : scope.is("customer_id", null)
  ).returns<Array<{ id: string; item_type: string }>>();
  if (readError) return fail(path, describeDbError(readError));

  const idByType = new Map((existing ?? []).map((row) => [row.item_type, row.id]));

  const inserts = [];
  for (const entry of parsed.entries) {
    const row = {
      unit_price: entry.unitPrice,
      bag_price: entry.bagPrice,
      taxable: entry.taxable,
    };
    const id = idByType.get(entry.itemType);
    if (id) {
      const { error } = await supabase.from("laundry_prices").update(row).eq("id", id);
      if (error) return fail(path, describeDbError(error));
    } else {
      inserts.push({
        ...row,
        tenant_id: session.tenantId,
        created_by: session.userId,
        customer_id: customerId,
        item_type: entry.itemType,
      });
    }
  }

  if (inserts.length > 0) {
    const { error } = await supabase.from("laundry_prices").insert(inserts);
    if (error) return fail(path, describeDbError(error));
  }

  // Clearing a customer's row puts them back on the default price; clearing a
  // default row leaves that kind of laundry unpriced, which the monthly run
  // reports rather than billing at zero.
  const removals = parsed.cleared
    .map((itemType) => idByType.get(itemType))
    .filter((id): id is string => Boolean(id));
  if (removals.length > 0) {
    const { error } = await supabase.from("laundry_prices").delete().in("id", removals);
    if (error) return fail(path, describeDbError(error));
  }

  await recordAudit(session, {
    entity: "laundry_price",
    entityId: customerId,
    action: "update",
    summary: customerId
      ? `Laundry prices for one customer: ${parsed.entries.length} priced, ${removals.length} cleared`
      : `Default laundry prices: ${parsed.entries.length} priced, ${removals.length} cleared`,
    metadata: { customerId, priced: parsed.entries.length, cleared: removals.length },
  });

  revalidatePath(path);
  return done(path, customerId
    ? "Saved this customer's laundry prices."
    : "Saved your default laundry prices.");
}
