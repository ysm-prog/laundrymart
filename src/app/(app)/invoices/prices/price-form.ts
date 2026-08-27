import { round2 } from "@/lib/domain/pricing";

/**
 * The price-list form's payload, read outside the `"use server"` module that
 * saves it.
 *
 * One row per **item code**, and the payload is what says which codes were on
 * screen. That is the change from the nine-category form this replaces: nine
 * rows could always all be posted, so "not posted" and "posted blank" were the
 * same thing. This laundry has 254 items, the screen shows a searched and paged
 * slice of them, and the two must not be confused — treating an item that was
 * simply not on this page as a blank would delete its price.
 *
 * So the form posts a `present` field per row it is showing, and **blank clears
 * only what was present**. Everything else is untouched, which is what makes it
 * safe to save from page 2 of a search.
 *
 * **Blank means no price, and no price means the row is removed.** Not zero: a
 * zero-priced item would bill silently at nothing, while a missing one is
 * reported by the pricer as unpriced with the reason. That distinction is the
 * whole safety property of the pricing tiers, so the form must not quietly break
 * it by storing zeros.
 */

export type PriceEntry = {
  itemId: string;
  unitPrice: number;
  bagPrice: number | null;
  taxable: boolean;
};

export type ParsedPriceForm =
  | { ok: true; entries: PriceEntry[]; cleared: string[] }
  | { ok: false; error: string };

export const PRESENT_FIELD = "present";
export const unitField = (itemId: string) => `unit_${itemId}`;
export const bagField = (itemId: string) => `bag_${itemId}`;
export const taxableField = (itemId: string) => `taxable_${itemId}`;

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
 * `labels` names an item in a refusal — "T40 — Towels - Black: enter a price…"
 * rather than a UUID, which is the difference between a message somebody can act
 * on and one they have to decode. An id the caller does not know is reported as
 * itself rather than being silently dropped: a row the screen posted and the
 * server cannot name is a disagreement worth surfacing, not hiding.
 */
export function parsePriceForm(
  form: FormData,
  labels: ReadonlyMap<string, string> = new Map(),
): ParsedPriceForm {
  const entries: PriceEntry[] = [];
  const cleared: string[] = [];
  const seen = new Set<string>();

  for (const raw of form.getAll(PRESENT_FIELD)) {
    const itemId = String(raw).trim();
    // A duplicated id would otherwise be read twice and could land in both
    // lists, so the second sighting is dropped rather than fought over.
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);

    const unit = readMoney(form.get(unitField(itemId)));
    const bag = readMoney(form.get(bagField(itemId)));
    const label = labels.get(itemId) ?? itemId;

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
      cleared.push(itemId);
      continue;
    }

    entries.push({
      itemId,
      unitPrice: unit ?? 0,
      bagPrice: bag,
      taxable: form.get(taxableField(itemId)) !== null,
    });
  }

  return { ok: true, entries, cleared };
}
