/**
 * Which of the nine kinds of laundry an item is — read off its name.
 *
 * `items.laundry_category` is the bridge 0032 built: a job names a coded item,
 * a trigger derives `item_type` from the item's category, and every pricing
 * tier, report and historical row goes on matching `item_type`. So this answer
 * decides what a customer is charged, which is why the rule is here — pure,
 * tested, and reviewable — rather than typed once into a live UPDATE.
 *
 * **It is deliberately conservative, and that is the whole design.** An item
 * this cannot place comes back `null`, which leaves it exactly as it was: still
 * pickable, still nameable on a job, and the counter still chooses the kind of
 * laundry beside it. A *wrong* category is much worse than none — it prices the
 * work at another kind's rate and nobody can see why, which is the failure §21
 * describes as "a silently missing line looks exactly like laundry that was
 * never taken in", one step earlier.
 *
 * Measured against the client's real 254-row MYOB list. Four traps in it are
 * why this is a rule with tests and not a `like '%towel%'`:
 *
 * 1. **A "bath sheet" is a bath towel, not a bed sheet.** Six of their rows say
 *    "Bath Sheet"; a generic `sheet` rule reaching them first would file every
 *    one as `sheets` and bill it at the sheet rate.
 * 2. **Their "hand towels" are not all linen.** `4-150160U TCA Ultraslim Hand
 *    Towel`, `4-7200 Hand Towel Salute Premium`, `4-HTKRT2400 Hand Towel Regal
 *    Gold` and `4-CD-8035B Hand Towel Dispenser` are washroom *paper* and the
 *    dispenser for it — things the laundry buys, not laundry a customer hands
 *    in. Categorising them would put paper towels on a customer's laundry list.
 * 3. **Some rows name linen without being linen.** "Lost Towels" is a charge for
 *    linen that did not come back and "New Towels Black - dozen" is a sale of
 *    new stock. Neither is laundry anybody handed over.
 * 4. **A laundry bag is a container the laundry lends.** §25 already records
 *    that decision for Harbour's `LB-STD-01`; the same holds for their eight
 *    rhino bags and their printed bags. A *sleeping* bag is not one of those —
 *    it is laundry, and it is the reason the exclusion names container bags
 *    rather than the word "bag".
 * 5. **`TR-CAP400V Toilet Paper 2Ply 400 Sheet` is not bedding.** The generic
 *    `sheet` rule reaches it happily; only the paper exclusion above stops it
 *    being filed as `sheets` and charged at the bed-sheet rate.
 */

import { ITEM_TYPES, type ItemType } from "./laundry-orders";

export type CategorisableItem = { item_code: string | null; name: string };

/**
 * Names that mention linen but are not laundry a customer hands in.
 *
 * Checked before anything else, because each of these would otherwise match a
 * perfectly good rule below. They are the reason this is an allowlist with an
 * escape hatch rather than a keyword search.
 */
const NOT_LAUNDRY = [
  // A charge, a sale, or an outsourcing line — the linen word is incidental.
  // "Lost Towels" is linen that did not come back; "New Towels Black - dozen"
  // is a sale of new stock; "Outsourced Washing Of Towels" is work sent out.
  /\blost\b/, /\bnew towels?\b/, /\boutsourced\b/, /\breplacement\b/,
  // A container the laundry lends or sells, not laundry — the call §25 already
  // records for Harbour's `LB-STD-01`.
  //
  // **Named container bags, not the word "bag".** A blanket `/\bbags?\b/` was
  // the first attempt and it silently swallowed three real items — `TL Towels
  // Per Bag`, `TTL Tea Towels Per Bag` and `OC13 Rugby Tops per bag`, all of
  // them laundry charged *by* the bag — and `SB Sleeping Bags`, which is a bag
  // and is also laundry somebody hands over. A false exclusion is the quiet
  // half of this rule going wrong: the item just stays uncategorised, which
  // looks exactly like one the rule was never meant to place.
  /\b(laundry|rhino|garbage|hdpe|soluble|strip)\s*bags?\b/,
  // Washroom paper and the hardware for it. Their `4-` rows read "Hand Towel
  // Regal Gold", "Hand Towel Salute Premium" and "TCA Ultraslim Hand Towel" —
  // paper by any other name, and the one trap that would put washroom stock on
  // a customer's laundry list.
  /\bdispenser\b/, /\bpaper\b/, /\btissue\b/, /\bregal\b/, /\bsalute\b/,
  /\bultraslim\b/,
];

/**
 * The rules, in the order they are tried. First match wins, so anything whose
 * name is ambiguous between two kinds must be listed under the more specific
 * one — which is exactly why `bath sheet` sits above `sheet`.
 */
const RULES: Array<{ test: RegExp; category: ItemType }> = [
  // --- more specific than the generic rules that follow -------------------
  // A bath sheet is the largest bath towel. Before `sheet`, deliberately.
  { test: /\bbath\s*sheets?\b/, category: "bath_towels" },
  { test: /\bbath\s*mats?\b|\bbathmats?\b/, category: "bath_mats" },
  { test: /\bbath\s*towels?\b/, category: "bath_towels" },
  { test: /\bhand\s*towels?\b/, category: "hand_towels" },

  // --- the towel family ---------------------------------------------------
  // Face washers, tea towels, glass cloths and salon towels are all "towels":
  // the nine kinds have no finer bucket, and Harbour's tea towel is already
  // filed this way (§11), so this keeps one answer rather than two.
  { test: /\bface\s*(washers?|towels?|wash)\b/, category: "towels" },
  { test: /\btea\s*towels?\b|\bttowels?\b/, category: "towels" },
  { test: /\bglass\s*cloths?\b|\bglasscloths?\b|\bdish\s*cloths?\b/, category: "towels" },
  { test: /\bsalon\s*towels?\b|\bgym\s*towels?\b|\bbeauty\s*towels?\b/, category: "towels" },

  // --- bed linen ----------------------------------------------------------
  { test: /\bpillow\s*cases?\b|\bpillowcases?\b/, category: "pillowcases" },
  { test: /\bdraw\s*sheets?\b|\bdrawsheets?\b/, category: "sheets" },
  { test: /\bsheets?\b/, category: "sheets" },

  // --- flat linen ---------------------------------------------------------
  { test: /\btable\s*cloths?\b|\btablecloths?\b/, category: "linen" },
  { test: /\bblankets?\b/, category: "linen" },
  { test: /\bcurtains?\b/, category: "linen" },
  // Laundered like any other flat linen, and the only one of the nine it fits.
  { test: /\bsleeping\s*bags?\b/, category: "linen" },

  // --- worn ---------------------------------------------------------------
  { test: /\bcapes?\b/, category: "uniforms" },
  { test: /\brugby\s*tops?\b/, category: "uniforms" },

  // --- the generic fallback, last -----------------------------------------
  // Everything above has had its chance, so a row still saying "towel" is a
  // towel of no stated kind. Their `TW` — the code billed at $0.22 — lands
  // here, which is right: it is towels, washed and dried.
  { test: /\btowels?\b/, category: "towels" },
];

/**
 * The kind of laundry this item is, or `null` when the name does not say.
 *
 * `null` is a real answer and the common one: of the client's 254 rows most are
 * chemicals, gloves, cups, machine parts and fees. Those are things the laundry
 * buys, and an item with no category behaves exactly as it did before — the
 * counter picks the kind of laundry beside it, and `sync_laundry_item_type`
 * leaves their answer alone.
 */
export function categoriseItem(item: CategorisableItem): ItemType | null {
  const name = item.name.toLowerCase();
  if (NOT_LAUNDRY.some((pattern) => pattern.test(name))) return null;
  return RULES.find((rule) => rule.test.test(name))?.category ?? null;
}

/** Every item the rule can place, with what it placed them as. */
export function categoriseAll<T extends CategorisableItem>(
  items: readonly T[],
): Array<{ item: T; category: ItemType }> {
  return items.flatMap((item) => {
    const category = categoriseItem(item);
    return category ? [{ item, category }] : [];
  });
}

/** A count per category, for reporting what a run would do before it does it. */
export function categoryTally(items: readonly CategorisableItem[]): Record<string, number> {
  const tally: Record<string, number> = Object.fromEntries(ITEM_TYPES.map((t) => [t, 0]));
  tally.uncategorised = 0;
  for (const item of items) {
    const category = categoriseItem(item);
    tally[category ?? "uncategorised"] = (tally[category ?? "uncategorised"] ?? 0) + 1;
  }
  return tally;
}
