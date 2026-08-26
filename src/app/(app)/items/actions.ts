"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  count, describeDbError, done, fail, firstIssue, money, optionalText, optionalUuid, toObject,
} from "@/lib/actions";
import { ITEM_TYPES } from "@/lib/domain/laundry-orders";
import { MAX_ITEM_CODE } from "@/lib/domain/items";
import { ITEM_CATEGORIES } from "./categories";

/**
 * A boolean from a `<select>`, which posts the string.
 *
 * MYOB's "Item I Sell" / "Item I Buy" are genuinely two independent flags —
 * both, neither and either all occur — so they are two fields rather than one
 * choice, and each is read the same way.
 */
const flag = z.preprocess((value) => value === "true" || value === true, z.boolean());

/**
 * **Not posted** and **posted empty** are two different answers, and 0044's
 * optional fields have to tell them apart.
 *
 * One schema serves both item forms, and the add form deliberately asks only two
 * of 0044's fifteen questions (§25 — an add form asking thirty is the wall of
 * inputs `FormSection` exists to prevent). So a field the add form never renders
 * arrives `undefined` and must be **left to the column default**, while the same
 * field cleared on the detail form arrives `""` and must be **written as null**.
 *
 * `undefined` and `null` are not interchangeable here, which is the opposite of
 * the call `optionalText` makes: it folds both to `undefined`, and because
 * `JSON.stringify` drops undefined keys, a field it governs cannot be *cleared*
 * once set — clearing it posts `""`, which becomes `undefined`, which is never
 * sent. That is long-standing behaviour across every form in the app and is not
 * changed here; these new fields simply do not inherit it, because a price basis
 * that cannot be put back to "not stated" is a field with a one-way door on it.
 */
const clearable = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(
  (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return typeof value === "string" && value.trim() === "" ? null : value;
  },
  inner.nullable().optional(),
);

/**
 * MYOB's "Selling price is" / "Buying price is", or nothing.
 *
 * The two values match the `chk_items_sell_price_basis` and
 * `chk_items_buy_price_basis` check constraints exactly, so anything else is
 * refused here with a sentence rather than by the database with a constraint
 * name. **Not stated** is the honest answer for every one of this laundry's 254
 * imported items, so null has to be as saveable as either value.
 */
const priceBasis = clearable(z.enum(["inclusive", "exclusive"]));

/**
 * An optional positive number from an `<input type="number">`.
 *
 * Distinct from `money`, which turns a blank into 0. Zero items per selling unit
 * is not a quantity anybody means, so storing 0 for "nobody said" would make the
 * two indistinguishable — and `chk_items_buy_units_per` refuses it outright.
 */
const optionalNumber = clearable(z.coerce.number().positive("That has to be more than zero"));

/**
 * An account or supplier chosen from a select whose placeholder posts `""`.
 *
 * `optionalUuid` for the shape; `clearable` for the reason above, so "Not coded"
 * can be chosen *back* after an account has been set. The neighbouring
 * `income_account_id` deliberately still uses the shared `optionalUuid` — this
 * change adds fields, it does not alter how an existing one saves.
 */
const clearableUuid = clearable(z.string().uuid());

const itemSchema = z.object({
  // The code staff actually type. Uniqueness is the database's (a
  // case-insensitive unique index per laundry), because two people can type the
  // same code at the same moment and only one of them can be told by a screen —
  // the action turns that refusal into a sentence below.
  item_code: z.string().trim().min(1, "An item code is required").max(MAX_ITEM_CODE)
    .refine((value) => !/\s/.test(value), "An item code cannot contain spaces"),
  sku: z.string().trim().min(1, "SKU is required").max(40),
  name: z.string().trim().min(2, "Name is required"),
  description: optionalText,
  category: z.enum(ITEM_CATEGORIES),
  laundry_category: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.enum(ITEM_TYPES).nullable(),
  ),
  /**
   * MYOB's "Use item description on sales and purchases" (0044). A `<select>`
   * rather than a checkbox, because an unticked checkbox posts *nothing* and
   * this form is also the edit form — a checkbox turned off would be
   * indistinguishable from a field the form never sent, which is how a save
   * silently reverts a value.
   */
  use_item_description: flag,
  is_sell: flag,
  is_buy: flag,
  sell_price: money,
  cost_price: money,
  /** The **selling** tax code. `buy_tax_code` below is the buying one (0044). */
  tax_code: optionalText,
  /*
   * The selling half of MYOB's item page. The first three are 0043's columns
   * getting their first writer; the fourth is 0044's.
   *
   * `sell_price_basis` is what `priceBasisHint` reads on an invoice line — the
   * one line of text saying whether the rate already contains GST. Optional
   * everywhere: 254 of this laundry's items carry no basis, so "not stated" is
   * the ordinary answer and must stay saveable.
   */
  sell_price_basis: priceBasis,
  selling_unit: optionalText,
  items_per_selling_unit: optionalNumber,
  cost_of_sales_account_id: clearableUuid,
  /* The buying half, mirroring the selling half field for field. */
  buy_price_basis: priceBasis,
  buy_unit: optionalText,
  buy_units_per: optionalNumber,
  buy_tax_code: optionalText,
  expense_account_id: clearableUuid,
  supplier_item_code: optionalText,
  /* Restocking. `reorder_level` (when to order) is below and stays as it was. */
  track_stock: flag,
  asset_account_id: clearableUuid,
  primary_supplier_id: clearableUuid,
  /** How *much* to order, per buying unit — not the same number as `reorder_level`. */
  default_reorder_qty: money,
  /*
   * MYOB's "Income Account for Tracking Sales", and the item's code as it is in
   * **Xero** (0036 + 0037). Both optional and both null by default: an item
   * nobody has coded behaves exactly as it did before, which is what makes this
   * safe to add to an item list already in use.
   *
   * `optionalUuid` because the select's placeholder posts `""`, and refusing to
   * save until somebody picks would put the item master behind the chart of
   * accounts. Cross-tenant safety is the FK plus RLS: an account id from another
   * laundry is invisible to this session, so the insert fails on the foreign key
   * rather than silently coding to somebody else's books.
   */
  income_account_id: optionalUuid,
  xero_item_code: optionalText,
  myob_item_id: optionalText,
  ownership_type: z.enum(["laundry_owned", "customer_owned", "either"]),
  replacement_cost: money,
  rental_price: money,
  wash_only_price: money,
  weight_kg: money,
  reorder_level: count,
  status: z.enum(["active", "inactive"]),
});

export async function createItem(formData: FormData): Promise<void> {
  const session = await assertCapability("items.write");
  const parsed = itemSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail("/items", firstIssue(parsed.error));

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("items")
    .insert({ ...parsed.data, tenant_id: session.tenantId, created_by: session.userId })
    .select("id, item_code, name")
    .single();

  // 23505 here is the item-code index, and "duplicate key value violates unique
  // constraint" is not a sentence anybody can act on.
  if (error) {
    return fail("/items", error.code === "23505"
      ? `The item code ${parsed.data.item_code} is already in use.`
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "item", entityId: data.id, action: "create",
    summary: `${data.item_code} ${data.name}`,
  });
  revalidatePath("/items");
  return done("/items", `Item ${data.item_code} created.`);
}

export async function updateItem(formData: FormData): Promise<void> {
  const session = await assertCapability("items.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/items", "That item could not be found.");

  const parsed = itemSchema.safeParse(toObject(formData));
  if (!parsed.success) return fail(`/items/${id.data}`, firstIssue(parsed.error));

  const supabase = await createClient();
  const { error } = await supabase
    .from("items").update(parsed.data)
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) {
    return fail(`/items/${id.data}`, error.code === "23505"
      ? `The item code ${parsed.data.item_code} is already in use.`
      : describeDbError(error));
  }

  await recordAudit(session, {
    entity: "item", entityId: id.data, action: "update", summary: parsed.data.item_code,
  });
  revalidatePath("/items");
  return done(`/items/${id.data}`, "Item updated.");
}

/**
 * Soft delete. A database trigger refuses when the item sits on an active
 * agreement (§7.5), so the check can't be bypassed by another code path.
 */
export async function archiveItem(formData: FormData): Promise<void> {
  const session = await assertCapability("items.write");
  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return fail("/items", "That item could not be found.");

  const supabase = await createClient();
  const { error } = await supabase
    .from("items")
    .update({ status: "archived", deleted_at: new Date().toISOString() })
    .eq("id", id.data).eq("tenant_id", session.tenantId);

  if (error) return fail(`/items/${id.data}`, describeDbError(error));

  await recordAudit(session, { entity: "item", entityId: id.data, action: "delete" });
  revalidatePath("/items");
  return done("/items", "Item archived.");
}
