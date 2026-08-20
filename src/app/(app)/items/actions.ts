"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import {
  count, describeDbError, done, fail, firstIssue, money, optionalText, toObject,
} from "@/lib/actions";
import { ITEM_TYPES } from "@/lib/domain/laundry-orders";
import { ITEM_CATEGORIES } from "./categories";

/**
 * A boolean from a `<select>`, which posts the string.
 *
 * MYOB's "Item I Sell" / "Item I Buy" are genuinely two independent flags —
 * both, neither and either all occur — so they are two fields rather than one
 * choice, and each is read the same way.
 */
const flag = z.preprocess((value) => value === "true" || value === true, z.boolean());

const itemSchema = z.object({
  // The code staff actually type. Uniqueness is the database's (a
  // case-insensitive unique index per laundry), because two people can type the
  // same code at the same moment and only one of them can be told by a screen —
  // the action turns that refusal into a sentence below.
  item_code: z.string().trim().min(1, "An item code is required").max(20)
    .refine((value) => !/\s/.test(value), "An item code cannot contain spaces"),
  sku: z.string().trim().min(1, "SKU is required").max(40),
  name: z.string().trim().min(2, "Name is required"),
  description: optionalText,
  category: z.enum(ITEM_CATEGORIES),
  laundry_category: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.enum(ITEM_TYPES).nullable(),
  ),
  is_sell: flag,
  is_buy: flag,
  sell_price: money,
  cost_price: money,
  tax_code: optionalText,
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
