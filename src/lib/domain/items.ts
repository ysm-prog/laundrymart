/**
 * The item master, said the way the counter says it. No database in sight.
 *
 * **Staff know the codes.** They type TOW001, not "bath towels" — that is the
 * whole reason the item master exists — so an item reads
 *
 *     TOW001 — Bath Towel
 *
 * wherever it appears, and the search matches the code before the name. A person
 * who has typed `TOW` a thousand times should get their answer on the third
 * keystroke, not after scrolling a list ordered by something else.
 */

import { round2 } from "./pricing";

/**
 * The GST rate to assume when a laundry's own row has not been read.
 *
 * 10%, which `tenants.gst_rate` has defaulted to since 0001. It lives in this
 * pure module rather than beside the reader in `lib/gst.ts` deliberately:
 * `coding.ts` needs it and is imported by a client component, so reaching for a
 * module that names the server Supabase client — even as a type — is the trap §2
 * records `plan.ts` falling into, which typechecks, lints and tests clean and
 * fails only at `next build`.
 */
export const GST_RATE_FALLBACK = 0.1;

/** MYOB truncates an item number at 30 characters, so nothing longer can be real. */
export const MAX_ITEM_CODE = 30;

/** What these rules need to know about an item. Deliberately less than a row. */
export type PickableItem = {
  id: string;
  item_code: string | null;
  name: string;
  description?: string | null;
  laundry_category?: string | null;
  status?: string;
};

/**
 * `TOW001 — Bath Towel`, or just the name where no code has been set.
 *
 * The code leads because it is the shorter, more certain half: two items can be
 * called "Bath Towel" and only one can be TOW001.
 */
export function itemLabel(item: Pick<PickableItem, "item_code" | "name">): string {
  const code = item.item_code?.trim();
  return code ? `${code} — ${item.name}` : item.name;
}

/**
 * Does this item match what somebody typed?
 *
 * Case- and space-insensitive, and matched against the code, the name and the
 * description — the three things a person might half-remember. A blank query
 * matches everything, so the picker opens on the full list rather than empty.
 */
export function itemMatches(item: PickableItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.item_code, item.name, item.description]
    .some((field) => field?.toLowerCase().includes(needle));
}

/**
 * The items matching a query, code matches first.
 *
 * Ranked rather than merely filtered, and the ranking is the point: typing `TOW`
 * should put TOW001 above "Pillowcase (towelling trim)", which merely contains
 * the letters. Within a rank the order is the caller's, which is by code.
 */
export function searchItems<T extends PickableItem>(
  items: readonly T[], query: string, limit = 20,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items.slice(0, limit);

  const rank = (item: PickableItem): number => {
    const code = item.item_code?.toLowerCase() ?? "";
    const name = item.name.toLowerCase();
    if (code === needle) return 0;
    if (code.startsWith(needle)) return 1;
    if (name.startsWith(needle)) return 2;
    if (code.includes(needle)) return 3;
    if (name.includes(needle)) return 4;
    return 5;
  };

  return items
    .filter((item) => itemMatches(item, query))
    .map((item, index) => ({ item, index, rank: rank(item) }))
    // `index` keeps the caller's order inside a rank, so the list does not
    // reshuffle as somebody types a longer prefix of the same code.
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Is this code usable, and is it free?
 *
 * The uniqueness rule the client asked for, stated here so the form can say so
 * before the insert does. The database holds the real constraint — a unique
 * index, case-insensitive per laundry — because two people can type the same
 * code at the same moment and only one of them can be told by a screen.
 */
export function checkItemCode(
  code: string, taken: readonly string[], existingId?: string, byId?: ReadonlyMap<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "An item code is required." };
  // 30, because that is MYOB's own field width and this business's real codes go
  // to 23 (`2-GLOVECLASTRAPF_PK1000`). A cap below what their books already hold
  // would refuse a code they type every week.
  if (trimmed.length > MAX_ITEM_CODE) {
    return { ok: false, reason: `Keep the item code to ${MAX_ITEM_CODE} characters.` };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, reason: "An item code cannot contain spaces." };
  }

  const lower = trimmed.toLowerCase();
  const own = existingId ? byId?.get(existingId)?.toLowerCase() : undefined;
  if (own === lower) return { ok: true };

  if (taken.some((other) => other.trim().toLowerCase() === lower)) {
    return { ok: false, reason: `The item code ${trimmed} is already in use.` };
  }
  return { ok: true };
}

/* -------------------------------------------------- the selling unit ------ */

/**
 * `$0.22 / ea` — a price with the unit it is a price *for*.
 *
 * **A price with no unit is the thing that gets read wrong.** This laundry bills
 * `TW` at $0.22 and `2-B201_PK100` by the box of a hundred, and the two read
 * identically on a list until the unit is beside the number. MYOB prints it this
 * way on its own item page for the same reason.
 *
 * Takes the price **already formatted** rather than a number, so this rule stays
 * about the unit and the one currency formatter in `lib/format` stays the only
 * thing that knows how money is written.
 *
 * A blank or whitespace-only unit yields the price alone. That is not
 * defensiveness for its own sake: `selling_unit` is free text copied out of
 * somebody's accounting package, and `"$0.22 / "` with nothing after the slash
 * reads as a bug in the app rather than as a field nobody has filled in.
 */
export function sellPriceLabel(
  formattedPrice: string, sellingUnit: string | null | undefined,
): string {
  const unit = sellingUnit?.trim();
  return unit ? `${formattedPrice} / ${unit}` : formattedPrice;
}

/* ------------------------------------------------- the selling basis ------ */

/** MYOB's "Selling price is" / "Buying price is". */
export type PriceBasis = "inclusive" | "exclusive";

/**
 * The basis as a picker offers it, in MYOB's own words.
 *
 * Offered with a placeholder rather than defaulted, because **not stated** is the
 * honest answer for every one of this laundry's 254 items — the inventory export
 * carries no basis, so defaulting to either would put an answer nobody gave on
 * the whole list.
 */
export const PRICE_BASIS_OPTIONS: ReadonlyArray<{ value: PriceBasis; label: string }> = [
  { value: "inclusive", label: "Tax inclusive" },
  { value: "exclusive", label: "Tax exclusive" },
];

/**
 * The one line of helper text under a price, given the item's selling basis.
 *
 * MYOB records per item whether its price already contains GST, and that single
 * fact changes what the number on the screen means — $72.70 inclusive is $66.09
 * of goods and $6.61 of tax, while $72.70 exclusive is $72.70 of goods. Somebody
 * typing a quantity against a rate they did not set needs to be told which.
 *
 * **`null` when the line carries no GST, deliberately.** Both sentences are
 * claims *about GST*, so on a `FRE` or `N-T` line neither is true and saying
 * either would be worse than saying nothing — the same call
 * `taxableFromTaxCode` makes when it does not recognise a code. `null` for an
 * unset basis for the same reason: 254 of this laundry's items carry none, so an
 * absent basis is the ordinary case, not an error to narrate.
 *
 * This does **not** feed the GST checkbox. The item's own tax code beats its
 * account's and that precedence is untouched; this only explains the price.
 *
 * **The exclusive sentence is past tense on purpose.** `lineRateFromItem` below
 * has already added the GST by the time this is read, so "GST is added to this
 * price" — which is what this said until the rate was grossed up — would be
 * describing something the invoice was never going to do.
 */
export function priceBasisHint(
  basis: string | null | undefined, taxable: boolean,
): string | null {
  if (!taxable) return null;
  const answer = basis?.trim().toLowerCase();
  if (answer === "inclusive") return "This price includes GST";
  if (answer === "exclusive") return "GST has been added to the item's price";
  return null;
}

/**
 * The item's price, as a **line rate**.
 *
 * **An invoice line amount is GST-inclusive.** That is 0043's decision, not a
 * choice made here: `recalculate_invoice` totals a line as `total = sub` and
 * extracts the tax out of it (`tax = sub × rate/(1+rate)`), so whatever is
 * stored in `unit_price` is what the customer pays, tax and all. An item whose
 * `sell_price_basis` is `exclusive` states its price the other way round, so it
 * has to be converted before it becomes a line rate — otherwise the two
 * disagree and the line is short by exactly the GST.
 *
 * **This was a real under-billing and it is worth stating plainly.** Until this
 * rule existed, both places that turn an item into money — the invoice line
 * composer and `chargePatchForItem` — took `items.sell_price` verbatim. An
 * exclusive-basis item listed at $100 therefore billed $100 with $9.09 of GST
 * found *inside* it, where the item says it should bill $110 with $10 on top:
 * the customer under-charged by the whole GST component, on a frozen charge in
 * the job case, with nothing on any screen to show it had happened.
 *
 * Three cases where the price passes through untouched, and each is a decision:
 *
 * - **No basis stated.** All 254 of this laundry's imported items, because the
 *   MYOB inventory export carries no basis (§25). This is the ordinary path and
 *   it must behave exactly as it did before the rule existed — so an unknown
 *   basis is never guessed at, for `taxableFromTaxCode`'s reason: inventing an
 *   answer here silently moves money.
 * - **Not taxable.** A `FRE` or `N-T` line carries no GST, so there is nothing
 *   to add and the two bases describe the same number.
 * - **A zero or negative rate**, which is what a laundry with GST switched off
 *   would have.
 *
 * Rounded to the cent through `round2`, because `invoice_lines.unit_price` and
 * `job_charge_snapshots.unit_price` are both `numeric(12,2)` — so rounding here
 * is what the database will store anyway, said out loud rather than discovered.
 */
export function lineRateFromItem(
  sellPrice: number | string | null | undefined,
  basis: string | null | undefined,
  taxable: boolean,
  gstRate: number,
): number {
  const price = Number(sellPrice ?? 0);
  if (!Number.isFinite(price)) return 0;
  if (!taxable) return price;
  if (!Number.isFinite(gstRate) || gstRate <= 0) return price;
  return basis?.trim().toLowerCase() === "exclusive" ? round2(price * (1 + gstRate)) : price;
}
