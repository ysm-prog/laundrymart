"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/audit";
import { describeDbError, done, fail, firstIssue, optionalText, optionalUuid, toObject } from "@/lib/actions";
import { INVENTORY_STATES as STATES } from "./states";

const movementSchema = z.object({
  item_id: z.string().uuid("Choose an item"),
  owner_type: z.enum(["laundry_owned", "customer_owned"]),
  quantity: z.preprocess((v) => Number(v), z.number().int().positive("Quantity must be at least 1")),
  from_state: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(STATES).optional(),
  ),
  to_state: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(STATES).optional(),
  ),
  from_customer: optionalUuid,
  to_customer: optionalUuid,
  from_depot: optionalUuid,
  to_depot: optionalUuid,
  reason: z.enum([
    "pickup", "delivery", "unload", "wash", "dry", "fold", "pack", "dispatch",
    "repair", "damage", "loss", "write_off", "stock_count", "purchase", "manual",
  ]),
  notes: optionalText,
});

/** Manual stock movement — the same ledger the driver workflow writes to. */
export async function moveStock(formData: FormData): Promise<void> {
  const session = await assertCapability("inventory.write");
  const parsed = movementSchema.safeParse(toObject(formData));
  if (!parsed.success) fail("/inventory", firstIssue(parsed.error));

  if (!parsed.data.from_state && !parsed.data.to_state) {
    fail("/inventory", "Choose at least a source or a destination state.");
  }
  if (parsed.data.from_state === parsed.data.to_state) {
    fail("/inventory", "Source and destination states must differ.");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("move_inventory", {
    p_tenant: session.tenantId,
    p_item: parsed.data.item_id,
    p_owner_type: parsed.data.owner_type,
    p_quantity: parsed.data.quantity,
    p_from_state: parsed.data.from_state ?? null,
    p_to_state: parsed.data.to_state ?? null,
    p_reason: parsed.data.reason,
    p_from_customer: parsed.data.from_customer ?? null,
    p_from_depot: parsed.data.from_depot ?? null,
    p_from_vehicle: null,
    p_to_customer: parsed.data.to_customer ?? null,
    p_to_depot: parsed.data.to_depot ?? null,
    p_to_vehicle: null,
    p_job: null,
    p_pickup: null,
    p_delivery: null,
    p_notes: parsed.data.notes ?? null,
  });

  if (error) fail("/inventory", describeDbError(error));

  await recordAudit(session, {
    entity: "inventory_movement", action: "create",
    summary: `${parsed.data.quantity} × ${parsed.data.from_state ?? "new"} → ${parsed.data.to_state ?? "written off"}`,
    metadata: { reason: parsed.data.reason },
  });
  revalidatePath("/inventory");
  done("/inventory", "Stock movement recorded.");
}
