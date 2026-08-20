import { z } from "zod";
import { optionalText, optionalUuid } from "@/lib/actions";
import { isBlankItem, type OrderItemInput } from "@/lib/domain/laundry-orders";

/**
 * Reading the laundry list back off the job form.
 *
 * It lives here rather than inside `actions.ts` for one reason: a `"use server"`
 * module cannot export anything but server actions, so this parser could not be
 * reached by a unit test — and it was a parsing fault that made every job on the
 * counter unsaveable while `verify` stayed green. Now the form's own payload
 * shape is asserted in `__tests__/order-items.test.ts`.
 */

/** A count that may legitimately be absent — distinct from `count`, which is 0. */
const optionalCount = z.preprocess(
  (value) => {
    if (value === "" || value === null || value === undefined) return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  },
  z.number().int("Whole numbers only").min(1, "Must be at least 1").optional(),
);

/**
 * One row as the browser composes it. Every optional field arrives as `null`,
 * not `""` and not absent, because `JSON.stringify` drops `undefined` keys —
 * so each of these has to accept a JSON null as "not answered".
 */
const itemSchema = z.object({
  /**
   * The item master row the counter picked (0032), or null on a row entered as
   * a bare kind of laundry.
   *
   * `optionalUuid` and not `z.uuid().nullish()`: the form spells an unanswered
   * field `null`, and a plain optional refuses that — the single fault that made
   * every job creation fail for the module's whole first week.
   */
  item_id: optionalUuid,
  item_type: z.string(),
  custom_description: optionalText,
  quantity_type: z.string(),
  exact_quantity: optionalCount,
  bag_count: optionalCount,
  estimated_quantity: optionalCount,
  notes: optionalText,
});

/**
 * The items arrive as JSON in one hidden field — the compose-locally, commit-once
 * shape the dispatch planner and the contract wizard already use. There is no
 * reading of a half-parsed laundry list: a payload that will not parse is
 * refused whole.
 *
 * What it is *not* allowed to do is quietly become an empty list. That is how a
 * payload the server could not read reached the counter as "Please add at least
 * one laundry item" on a job with items visibly on the screen — a sentence that
 * named the wrong problem and left no way to act on the real one.
 */
const itemsField = z.preprocess((value) => {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}, z.array(itemSchema).max(40, "That is more laundry items than one job can hold."));

/** The laundry list, or the sentence explaining why it could not be read. */
export type ItemsResult =
  | { ok: true; items: OrderItemInput[] }
  | { ok: false; problem: string };

/** Drop the blank rows the form always carries, keep the rest in order. */
export function parseOrderItems(raw: FormDataEntryValue | null): ItemsResult {
  const parsed = itemsField.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    return {
      ok: false,
      problem: `The laundry list could not be read (${where}${issue?.message ?? "unreadable"}). `
        + "Please check the items and try again.",
    };
  }
  const items = parsed.data
    .map((item) => ({
      item_id: item.item_id ?? null,
      item_type: item.item_type,
      custom_description: item.custom_description ?? null,
      quantity_type: item.quantity_type,
      exact_quantity: item.exact_quantity ?? null,
      bag_count: item.bag_count ?? null,
      estimated_quantity: item.estimated_quantity ?? null,
      notes: item.notes ?? null,
    }))
    .filter((item) => !isBlankItem(item));
  return { ok: true, items };
}
