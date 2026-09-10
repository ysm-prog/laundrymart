import type { OrderItemInput } from "./laundry-orders";

/**
 * A collection, taken in as laundry.
 *
 * The loop this closes is the one §33 records as deliberately open: a driver
 * captures a collection on `/run`, which writes `pickups` + `pickup_lines` and
 * moves *inventory* — and **nothing bills from it**. What the customer pays
 * still comes from a laundry job raised at the counter and priced per item
 * code. So every collection had to be re-typed by somebody reading the driver's
 * counts off another screen, and a collection nobody re-typed was simply never
 * billed, silently.
 *
 * This maps one to the other. It is a *seed*, not a write: the counts, the
 * customer and the item codes are carried onto the ordinary job form and the
 * counter presses Save, so `createOrder` stays the one door laundry is taken in
 * through — already gated, already drawing the job number, already replacing the
 * item set in one transaction.
 *
 * ## What is deliberately left behind, and why it matters more than what is carried
 *
 * **`damaged_quantity` and `missing_quantity` do not come across.** The
 * month-end run already bills them, straight off `pickup_lines`, as replacement
 * charges (`buildReplacementCharges` in `invoices/actions.ts`) — charged once
 * per customer no matter how many contracts they hold. Carrying them onto the
 * laundry job would put the same lost towel on the same invoice twice.
 *
 * **`total_weight_kg` does not come across either**, for exactly the same
 * reason: `allocateWeightCharges` bills the period's weighed collections against
 * a contract's `per_kg` lines. A weight is a charge already.
 *
 * **The pickup's `bag_count` does not come across.** It counts bags at the door,
 * where the job's rows count *items*; seeding it as a bulk lot beside the exact
 * rows would bill the same linen twice over — once by the piece and once by the
 * bag.
 *
 * So the only thing that crosses is `quantity`: what was actually collected,
 * which is what the customer is charged for.
 */

/** A line as the collection recorded it. */
export type PickupLine = {
  item_id: string;
  quantity: number;
  damaged_quantity: number;
  missing_quantity: number;
  notes?: string | null;
};

/**
 * An item named by one of those lines.
 *
 * `pickable` is *active and not deleted* — the same filter the job form's own
 * catalogue uses. An item outside it cannot be shown in the picker, so a row
 * seeded from one would render as an empty item over a filled quantity: the
 * counter sees a row that looks unfinished, one click from being cleared, on a
 * form that refuses to save without an item code.
 */
export type PickupItem = {
  id: string;
  item_code: string | null;
  name: string;
  laundry_category: string | null;
  pickable: boolean;
};

export type IntakeSkipReason = "nothing_collected" | "item_unknown" | "item_retired";

/** Said as the second half of "X was left off, because …". */
export const INTAKE_SKIP_TEXT: Record<IntakeSkipReason, string> = {
  nothing_collected: "nothing was collected on that line",
  item_unknown: "that item is not on your item list",
  item_retired: "that item has been retired from your item list",
};

export type SkippedLine = { label: string; reason: IntakeSkipReason };

export type PickupIntake = {
  /** The laundry rows to seed the job form with, in the order they were counted. */
  items: OrderItemInput[];
  /** Lines that could not become a row, each with the reason to print. */
  skipped: SkippedLine[];
};

/**
 * Why the damaged and missing columns are not on the seeded list, printed where
 * the counter would otherwise notice the numbers do not add up and re-type them.
 *
 * This is the whole safety property of the feature stated in one sentence, so it
 * belongs on the screen rather than only in this comment.
 */
export const PICKUP_INTAKE_EXCLUSIONS =
  "Anything damaged or missing is not on this list. It is already charged from "
  + "the collection itself, so adding it here would bill the customer twice.";

/** Code-first, the way staff read an item list. */
function labelFor(item: PickupItem | undefined, itemId: string): string {
  if (!item) return `Item ${itemId.slice(0, 8)}`;
  return [item.item_code, item.name].filter(Boolean).join(" · ");
}

/**
 * What kind of laundry a seeded row says it is.
 *
 * Derived from the item, never guessed — the same rule `sync_laundry_item_type`
 * applies in the database and `laundryPriceItemType` applies to a price, so a
 * row seeded here and a row typed by hand cannot end up in different buckets.
 *
 * An item carrying no `laundry_category` becomes `other`, described by its own
 * name. It is **not** dropped, and that is a decision rather than an oversight:
 * 129 of this laundry's 254 items have no category (§25 — they are the things it
 * buys), and a driver who counted twelve of one at the door counted twelve. What
 * actually prices the row is the item *code*, which is carried either way;
 * refusing the count because a category is blank on another screen would throw
 * away a real collection to protect a coarse bucket.
 *
 * `custom_description` is filled in with it because `validateItem` requires one
 * for `other` — without it the seeded form would refuse to save and say nothing
 * a counter hand could act on.
 */
function kindOf(item: PickupItem): { item_type: string; custom_description: string | null } {
  const category = item.laundry_category?.trim();
  return category
    ? { item_type: category, custom_description: null }
    : { item_type: "other", custom_description: item.name };
}

/**
 * The laundry rows a collection becomes, and what could not be carried.
 *
 * Every line is answered — carried, or named with a reason — because a line that
 * simply disappears is indistinguishable from one that was never collected, and
 * the counter has no way to tell which from the seeded form.
 */
export function intakeItemsFromPickup(
  lines: readonly PickupLine[],
  items: ReadonlyMap<string, PickupItem>,
): PickupIntake {
  const seeded: OrderItemInput[] = [];
  const skipped: SkippedLine[] = [];

  for (const line of lines) {
    const item = items.get(line.item_id);
    const label = labelFor(item, line.item_id);

    if (!item) {
      skipped.push({ label, reason: "item_unknown" });
      continue;
    }
    if (!item.pickable) {
      skipped.push({ label, reason: "item_retired" });
      continue;
    }
    // A line recording only damage or loss is a real line and not laundry: the
    // linen it names did not come back to be washed. Zero towels is not a
    // quantity a job can be priced on, and `validateItem` would refuse it.
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      skipped.push({ label, reason: "nothing_collected" });
      continue;
    }

    seeded.push({
      item_id: item.id,
      ...kindOf(item),
      quantity_type: "exact",
      exact_quantity: line.quantity,
      bag_count: null,
      estimated_quantity: null,
      notes: line.notes?.trim() || null,
    });
  }

  return { items: seeded, skipped };
}

/** "TOW001 · Bath towel was left off, because …" — one sentence per line. */
export function describeSkipped(skipped: readonly SkippedLine[]): string[] {
  return skipped.map((line) => `${line.label} was left off — ${INTAKE_SKIP_TEXT[line.reason]}.`);
}
