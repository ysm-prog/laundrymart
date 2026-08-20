import { z } from "zod";
import { optionalUuid } from "@/lib/actions";

/**
 * The priced lines the contract wizard posts as JSON in one hidden field — the
 * same compose-locally-commit-once shape the dispatch planner and the job form
 * use.
 *
 * It lives here rather than in `actions.ts` so the contract can be asserted
 * against the shape `AgreementWizard` actually posts. A `"use server"` module
 * can export nothing but server actions, which made the identical arrangement
 * on the job form untestable — and it shipped broken, and stayed broken behind
 * a green `verify`, because nothing could reach it.
 *
 * Every field here is a string, a number or a boolean, never `null`: step 3
 * filters out rows with no item and coerces each figure with `Number(x) || 0`.
 * `item_id` is the one that could plausibly start arriving as `null` if that
 * filter ever moved, which is why the test pins it.
 */
export const wizardLinesSchema = z.array(z.object({
  item_id: optionalUuid,
  charge_type: z.enum([
    "rental", "wash_only", "replacement", "minimum_service_fee", "fuel_levy",
    "emergency_delivery", "weekend_surcharge", "holiday_surcharge", "bag_charge",
    "weight_charge", "monthly_fee", "other",
  ]),
  pricing_model: z.enum(["per_item", "per_kg", "per_collection", "monthly", "percentage"]),
  unit_price: z.number().finite().min(0),
  standard_quantity: z.number().finite().min(0),
  included_quantity: z.number().finite().min(0),
  taxable: z.boolean(),
})).max(50);

export type WizardLine = z.infer<typeof wizardLinesSchema>[number];

/**
 * The posted lines, or `null` when the payload could not be read.
 *
 * A contract with no priced lines is legitimate — billing falls back to item
 * defaults, which the detail page says out loud — so an empty field is an empty
 * list. A payload that will not parse is *not* the same thing and must not
 * become one: the caller refuses the save and says so. That distinction is
 * exactly what the job form was missing.
 */
export function parseWizardLines(raw: FormDataEntryValue | null): WizardLine[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = wizardLinesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
