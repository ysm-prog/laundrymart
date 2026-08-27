"use server";

import { revalidatePath } from "next/cache";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, returnTo } from "@/lib/actions";
import { checkItemCode, itemLabel } from "@/lib/domain/items";
import { laundryPriceItemType, type PricedItem } from "@/lib/domain/laundry-prices";
import { ITEM_TYPES } from "@/lib/domain/laundry-orders";
import { parsePriceForm, PRESENT_FIELD } from "./price-form";

/**
 * Save a laundry price list — the tenant's usual prices, or one customer's own.
 *
 * Both screens post the same rows to this one action; `customer_id` is what says
 * which list is being written. Guarded by `invoices.write`, which is the Owner
 * and the Office manager alone and matches the roles 0018/0033 let touch the
 * table: a price list is a finance record, and the screen must not offer what
 * the database will refuse.
 *
 * **Scoped to the rows the form was showing.** The old nine-category form posted
 * every row every time, so it could diff against the whole list. This one shows
 * a searched slice of 254 items, so it diffs against *the items it posted* —
 * `present`. Saving from a search must not delete the prices of everything that
 * happened not to match it.
 *
 * Written as read → update / insert / delete rather than as an upsert. The
 * unique index is `(tenant_id, customer_id, item_type, item_id) nulls not
 * distinct`, and inferring a partial index over nullable columns through
 * PostgREST's `on_conflict=` is exactly the sort of thing that works in testing
 * and surprises in production. Diffing against what is there also means a save
 * never has a window with no prices in it, which a delete-then-insert would.
 */
export async function saveLaundryPrices(formData: FormData): Promise<void> {
  const session = await assertCapability("invoices.write");

  const rawCustomer = formData.get("customer_id");
  const customerId = typeof rawCustomer === "string" && rawCustomer.trim() !== ""
    ? rawCustomer.trim()
    : null;
  const path = returnTo(formData, customerId ? `/customers/${customerId}/prices` : "/invoices/prices");

  const present = [...new Set(
    formData.getAll(PRESENT_FIELD).map((raw) => String(raw).trim()).filter(Boolean),
  )];
  if (present.length === 0) return fail(path, "That form posted no prices to save.");

  const supabase = await createClient();

  // The items the form claims to have shown, read back rather than trusted.
  // Two things depend on this and both are load-bearing: `item_type` is NOT NULL
  // on the price row and is **derived** from the item's own category rather than
  // posted, and an id from another laundry resolves to nothing here instead of
  // writing a price into somebody else's list.
  //
  // **The tenant is named rather than left to RLS** (§23): `is_member()` is true
  // of every laundry for a platform admin, and this read feeds a write.
  const { data: items, error: itemError } = await supabase
    .from("items")
    .select("id, item_code, name, laundry_category")
    .eq("tenant_id", session.tenantId)
    .is("deleted_at", null)
    .in("id", present)
    .returns<Array<PricedItem & { id: string }>>();
  if (itemError) return fail(path, describeDbError(itemError));

  const byId = new Map((items ?? []).map((item) => [item.id, item]));
  const unknown = present.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    // Named as a count rather than as ids: the operator cannot act on a UUID,
    // and the honest statement is that the screen and the item list disagree.
    return fail(path, `${unknown.length} of those items are no longer in your item list. `
      + "Reload the page and try again.");
  }

  const labels = new Map([...byId].map(([id, item]) => [id, itemLabel(item)]));
  const parsed = parsePriceForm(formData, labels);
  if (!parsed.ok) return fail(path, parsed.error);

  // The rows for this scope *and these items only*. `is("customer_id", null)`
  // rather than `eq(…, null)`: the usual list is the rows with no customer, and
  // PostgREST spells that as IS NULL.
  const scope = supabase
    .from("laundry_prices").select("id, item_id")
    .eq("tenant_id", session.tenantId)
    .in("item_id", present);
  const { data: existing, error: readError } = await (
    customerId ? scope.eq("customer_id", customerId) : scope.is("customer_id", null)
  ).returns<Array<{ id: string; item_id: string }>>();
  if (readError) return fail(path, describeDbError(readError));

  const idByItem = new Map((existing ?? []).map((row) => [row.item_id, row.id]));

  const inserts = [];
  for (const entry of parsed.entries) {
    const row = {
      unit_price: entry.unitPrice,
      bag_price: entry.bagPrice,
      taxable: entry.taxable,
    };
    const id = idByItem.get(entry.itemId);
    if (id) {
      const { error } = await supabase.from("laundry_prices").update(row).eq("id", id);
      if (error) return fail(path, describeDbError(error));
    } else {
      inserts.push({
        ...row,
        tenant_id: session.tenantId,
        created_by: session.userId,
        customer_id: customerId,
        item_id: entry.itemId,
        item_type: laundryPriceItemType(byId.get(entry.itemId)!),
      });
    }
  }

  if (inserts.length > 0) {
    const { error } = await supabase.from("laundry_prices").insert(inserts);
    if (error) return fail(path, describeDbError(error));
  }

  // Clearing a customer's row puts them back on the usual price; clearing a row
  // on the usual list leaves that item unpriced, which the pricer reports rather
  // than billing at zero.
  const removals = parsed.cleared
    .map((itemId) => idByItem.get(itemId))
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
      : `Usual laundry prices: ${parsed.entries.length} priced, ${removals.length} cleared`,
    metadata: { customerId, priced: parsed.entries.length, cleared: removals.length },
  });

  revalidatePath(path);
  // Says where the change lands, because that is the question this screen is
  // asked: an owner who has just re-rated towels wants to know whether the job
  // they are about to approve picks it up.
  return done(path, customerId
    ? "Saved this customer's laundry prices. New jobs for them are priced from these rates."
    : "Saved your usual laundry prices. New jobs are priced from these rates.");
}

/**
 * Add an item code, and price it in the same breath.
 *
 * **Why this lives on the price screen at all.** An owner setting up their rates
 * meets the gap here — they work down the list, find the code they charge for is
 * not in the item master, and had to leave for `/items`, add it, and come back
 * to a screen that had lost their other edits. Worse, the live data shows what
 * happens when that trip is inconvenient: `T22`, `T38` and `T40` are three item
 * codes all named "Towels - Black", because with no usable price list the only
 * place left to record a rate was the code itself.
 *
 * Gated on **`items.write`** rather than on `invoices.write`. They resolve to
 * the same two roles today — the Owner and the Office manager — but they are
 * different questions, and `0040` is the boundary that actually binds: a
 * capability without the policy behind it writes zero rows in silence. Asserted
 * separately so that if the two sets ever part company, this refuses out loud on
 * the one that governs the table it writes.
 */
export async function addItemCode(formData: FormData): Promise<void> {
  const session = await assertCapability("items.write");
  const path = returnTo(formData, "/invoices/prices");

  const read = (field: string) => String(formData.get(field) ?? "").trim();
  const code = read("item_code");
  const name = read("name");
  const category = read("laundry_category");

  if (!name) return fail(path, "Give the item a name.");

  const supabase = await createClient();

  // Every code in the laundry, so the screen can refuse a duplicate in the words
  // a person understands. The database holds the real constraint — `uq_items_code`
  // is unique per laundry and case-insensitive — because two people can type the
  // same code in the same second and only one of them can be told by a screen.
  const { data: taken, error: takenError } = await supabase
    .from("items").select("item_code")
    .eq("tenant_id", session.tenantId)
    .is("deleted_at", null)
    .not("item_code", "is", null)
    .returns<Array<{ item_code: string }>>();
  if (takenError) return fail(path, describeDbError(takenError));

  const check = checkItemCode(code, (taken ?? []).map((row) => row.item_code));
  if (!check.ok) return fail(path, check.reason);

  if (category && !(ITEM_TYPES as readonly string[]).includes(category)) {
    return fail(path, "Pick a kind of laundry from the list, or leave it blank.");
  }

  const { data: created, error } = await supabase
    .from("items")
    .insert({
      tenant_id: session.tenantId,
      item_code: code,
      // `sku` carries its own unique index and predates `item_code`. Set to the
      // same string so a hand-added item looks like an imported one; the two are
      // free to diverge afterwards, exactly as 0032's backfill left them.
      sku: code,
      name,
      // Blank is a real answer — a chemical or a fee is sellable and is not
      // laundry a customer hands in — and `sync_laundry_item_type` leaves a job
      // row's own answer alone when the item has no category.
      laundry_category: category || null,
      // This screen exists to price things the laundry sells. An item added from
      // it is one, and is offered by every picker from the moment it is saved.
      is_sell: true,
      status: "active",
    })
    .select("id, item_code, name, laundry_category")
    .single<PricedItem & { id: string }>();
  if (error) return fail(path, describeDbError(error));

  // The price is optional: an owner may be adding the code now and agreeing the
  // rate later. A code with no price is honest — the pricer reports it as
  // unpriced — where a zero would bill silently at nothing.
  const rawPrice = read("unit_price");
  const unitPrice = rawPrice === "" ? null : Number(rawPrice);
  if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
    return fail(path, "Enter a price of zero or more, or leave it blank.");
  }

  if (unitPrice !== null && unitPrice > 0) {
    const { error: priceError } = await supabase.from("laundry_prices").insert({
      tenant_id: session.tenantId,
      created_by: session.userId,
      customer_id: null,
      item_id: created.id,
      item_type: laundryPriceItemType(created),
      unit_price: unitPrice,
      bag_price: null,
      taxable: formData.get("taxable") !== null,
    });
    // The item exists either way, and saying so is the point: an owner told
    // only "could not save" would add the code a second time and be refused as
    // a duplicate, which is the one message that stops them finishing the job.
    if (priceError) {
      return fail(path, `Added ${itemLabel(created)}, but its price could not be saved: `
        + describeDbError(priceError));
    }
  }

  await recordAudit(session, {
    entity: "item",
    entityId: created.id,
    action: "create",
    summary: `Added item ${itemLabel(created)} from the laundry price list`,
    metadata: { itemCode: code, priced: unitPrice !== null && unitPrice > 0 },
  });

  revalidatePath(path);
  return done(path, `Added ${itemLabel(created)}.`, {
    href: `/items/${created.id}`, label: "Open the item",
  });
}
