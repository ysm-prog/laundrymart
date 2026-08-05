"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { count, describeDbError, done, fail, firstIssue, money, toObject } from "@/lib/actions";
import { ITEM_CATEGORIES } from "./categories";

const itemSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required").max(40),
  name: z.string().trim().min(2, "Name is required"),
  category: z.enum(ITEM_CATEGORIES),
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
    .select("id, sku, name")
    .single();

  if (error) return fail("/items", describeDbError(error));

  await recordAudit(session, {
    entity: "item", entityId: data.id, action: "create", summary: `${data.sku} ${data.name}`,
  });
  revalidatePath("/items");
  return done("/items", `Item ${data.sku} created.`);
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

  if (error) return fail(`/items/${id.data}`, describeDbError(error));

  await recordAudit(session, {
    entity: "item", entityId: id.data, action: "update", summary: parsed.data.sku,
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
