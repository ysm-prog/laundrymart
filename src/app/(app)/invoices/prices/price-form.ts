import { ITEM_TYPES, ITEM_TYPE_LABELS, type ItemType } from "@/lib/domain/laundry-orders";
import { round2 } from "@/lib/domain/pricing";

/**
 * The price-list form's payload, read outside the `"use server"` module that
 * saves it.
 *
 * One row per kind of laundry, all nine posted every time — so "what did the
 * operator mean by leaving this blank?" is the only real question, and it is
 * answered once, here, rather than at each of the two screens that post the
 * form.
 *
 * **Blank means no price, and no price means the row is removed.** Not zero: a
 * zero-priced kind of laundry would bill silently at nothing, while a missing
 * one is reported by the monthly run as unpriced with the reason. That
 * distinction is the whole safety property of `laundry-billing.ts`, so the form
 * must not quietly break it by storing zeros.
 */

export type PriceEntry = {
  itemType: ItemType;
  unitPrice: number;
  bagPrice: number | null;
  taxable: boolean;
};

export type ParsedPriceForm =
  | { ok: true; entries: PriceEntry[]; cleared: ItemType[] }
  | { ok: false; error: string };

export const unitField = (itemType: string) => `unit_${itemType}`;
export const bagField = (itemType: string) => `bag_${itemType}`;
export const taxableField = (itemType: string) => `taxable_${itemType}`;

/** A money field: blank is absent, anything unreadable or negative is an error. */
function readMoney(raw: FormDataEntryValue | null): number | null | "invalid" {
  if (raw === null) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return "invalid";
  // Cents, because the column is numeric(12,2) and a third decimal would be
  // rounded by the database rather than by the person typing it. `round2` and
  // not `Math.round(v * 100) / 100`: the latter reads 1.005 as 1.00, because
  // the binary float sits just under the half-cent.
  return round2(value);
}

/**
 * Read the posted price list into the rows to keep and the rows to remove.
 *
 * Every kind of laundry the form did not price ends up in `cleared`, which is
 * what lets a customer's override be taken off again — deleting their row is how
 * they go back to the tenant's default price.
 */
export function parsePriceForm(form: FormData): ParsedPriceForm {
  const entries: PriceEntry[] = [];
  const cleared: ItemType[] = [];

  for (const itemType of ITEM_TYPES) {
    const unit = readMoney(form.get(unitField(itemType)));
    const bag = readMoney(form.get(bagField(itemType)));
    const label = ITEM_TYPE_LABELS[itemType];

    if (unit === "invalid") {
      return { ok: false, error: `${label}: enter a price of zero or more, or leave it blank.` };
    }
    if (bag === "invalid") {
      return { ok: false, error: `${label}: enter a bag price of zero or more, or leave it blank.` };
    }
    // A bag price on its own prices bulk lots and nothing else, which is a
    // legitimate arrangement — a laundry that only ever takes uniforms by the
    // bag. The piece rate simply stays at zero and counted items report as
    // unpriced rather than billing at nothing.
    if (unit === null && bag === null) {
      cleared.push(itemType);
      continue;
    }

    entries.push({
      itemType,
      unitPrice: unit ?? 0,
      bagPrice: bag,
      taxable: form.get(taxableField(itemType)) !== null,
    });
  }

  return { ok: true, entries, cleared };
}
