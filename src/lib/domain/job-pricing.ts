/**
 * What one job costs, from the customer's rate card. No database in sight.
 *
 * This is the "current price editable, historical price fixed" rule made
 * mechanical. Everything here reads a rate card *now* and produces plain numbers
 * with their provenance attached; the caller writes those numbers into
 * `job_charge_snapshots`, and from that moment nothing in this file can change
 * them again. Re-pricing a job is only possible while it is awaiting review, and
 * migration 0017's guard is what makes that true rather than this module.
 *
 * The rate card is a *version* of a service agreement (0003), so a price change
 * is the thing this app already models: supersede the agreement, point the
 * customer at the new version, and every invoice raised before today keeps
 * quoting the line it was actually priced from.
 *
 * **The vocabulary problem, and why the fix is one nullable column.**
 * `service_agreement_lines.item_id` names `public.items` — the linen the laundry
 * owns and rents out. What a customer hands over the counter is their own
 * washing, described by `laundry_order_items.item_type`. Those two sets do not
 * overlap and never did. So 0017 lets a rate line name a laundry item type as
 * well, and this pricer matches on that. A rental line with no
 * `laundry_item_type` is invisible here, which is correct: it prices a monthly
 * linen rental, not the bag in front of you.
 */

import { lineAmount, round2, type ChargeType } from "@/lib/domain/pricing";
import { ITEM_TYPE_LABELS, describeItem, type ItemType, type OrderItemInput } from "@/lib/domain/laundry-orders";

/** A priced line on the customer's rate card, as this module needs it. */
export type RateLine = {
  id: string;
  agreement_id: string;
  item_id: string | null;
  laundry_item_type: string | null;
  charge_type: string;
  pricing_model: string;
  unit_price: number;
  percentage: number | null;
  included_quantity: number;
  taxable: boolean;
};

/** The rate card header, for the charges that belong to the card and not a line. */
export type RateCard = {
  id: string;
  fuel_levy_pct: number;
};

/**
 * One entry of the laundry price list (0018), as this module needs it.
 *
 * Structurally the `LaundryPrice` that `priceListFor` produces, restated here
 * rather than imported so this module keeps its one dependency direction: the
 * pricer is pure domain logic and does not reach across into the other billing
 * module to borrow a shape.
 */
export type LaundryListPrice = {
  unitPrice: number;
  bagPrice: number | null;
  taxable: boolean;
  source: "customer" | "default";
};

/** One line as it will be written to `job_charge_snapshots`. */
export type JobChargeLine = {
  sequence: number;
  description: string;
  charge_type: ChargeType;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  source_agreement_id: string | null;
  source_agreement_line_id: string | null;
  source_item_id: string | null;
  source_laundry_item_type: string | null;
  pricing_model: string | null;
  /**
   * The income account this charge codes to (0039).
   *
   * Chosen on the job's Charges screen or inherited from the item the pricer
   * used, and carried onto the invoice line at generation — so the code is
   * decided once, where the work is, instead of being re-entered on the invoice.
   * Null is legal and visible: an uncoded charge is counted on the invoice, not
   * refused.
   */
  gl_account_id: string | null;
};

/**
 * Why a row could not be priced — and therefore what to do about it.
 *
 * "Nothing came back priced" was the whole of what the reviewer used to be
 * told, and it names no remedy: the three causes below want three different
 * actions, on three different screens. Reporting them apart is the difference
 * between a message somebody acts on and one they learn to ignore.
 */
export type UnpricedReason =
  /** Neither the rate card nor the price list has any rate for this laundry. */
  | "no_rate"
  /**
   * The row names no item code, and the price list is keyed on item codes.
   *
   * Its own reason because the remedy is different and is not on a price screen
   * at all: the laundry was taken in without a code, so the job is what needs
   * editing. Since 2026-08-27 the price screens write **only** the item tier
   * (§31), so the kind-of-laundry tier they used to write is empty on this
   * deployment — 117 prices, every one against an item, and 5 of the laundry's
   * 19 recorded rows naming no item at all. Telling those five "no rate on the
   * price list" sends somebody to a list that is already full.
   */
  | "no_item_code"
  /** Bags were counted, and the only rate is per piece. See `billableMeasure`. */
  | "no_bag_rate"
  /** A bulk lot with no bag count and no estimate: nothing to multiply. */
  | "not_measured";

/** The sentence a reviewer reads, per reason. Pure, so the screens share it. */
export const UNPRICED_REASON_TEXT: Record<UnpricedReason, string> = {
  no_rate: "no rate on the rate card or the price list",
  no_item_code: "taken in without an item code, so there is no code to price it by",
  no_bag_rate: "counted in bags, and there is no price per bag for it",
  not_measured: "recorded as a bulk lot with no bag count and no estimate",
};

export type JobPricingResult = {
  lines: JobChargeLine[];
  /**
   * Laundry on the job that the rate card says nothing about. Surfaced rather
   * than silently priced at zero: "we have no rate for uniforms for this
   * customer" is a thing somebody must decide, and a zero line looks like a
   * decision that was already taken.
   */
  unpriced: Array<{
    itemType: string; label: string; description: string; reason: UnpricedReason;
  }>;
};

/**
 * How much laundry a row represents, **and what it is counted in**.
 *
 * The unit is the whole point, and leaving it out was a money bug. A counted row
 * is a number of *pieces*; a bulk lot with an estimate is an estimate of
 * *pieces*; a bulk lot with neither is a number of *bags*. Those are not
 * interchangeable, and the old `billableQuantity` returned a bare number that
 * could be any of the three — so a bag count reached the multiplication as
 * though it were a piece count.
 *
 * Live, on 2026-09-08: `LJ00022` is four bags of `T22`, whose only rate is
 * $0.24 a piece. The pricer produced **four** × $0.24 = **$0.96 for four bags of
 * towels**, described as "Towels — 4", with nothing on screen to suggest
 * anything had gone wrong. `LJ00023` is the same shape, and the owner had
 * evidently spotted it there: its frozen charge is a hand-typed
 * `bag_charge` of 1 × $40.00. That is what "charge by customer does not work"
 * looks like from a desk.
 *
 * §4 of `CLAUDE.md` has always stated the rule this restores: *"A bulk lot bills
 * by the bag when a bag rate is set and the bags were counted, otherwise by the
 * counter's estimate; a lot with neither cannot be priced and says so."* A bag
 * measure is therefore priceable **only** by a bag rate, and `priceJob` refuses
 * it otherwise instead of quietly under-billing.
 *
 * `null` stays a real answer: a bulk lot recorded as a note alone can be written
 * down and cannot be priced.
 */
export type BillableMeasure = {
  /**
   * Pieces: what was counted, or the counter's estimate of a bulk lot. This is
   * the only thing a per-piece or per-kilo rate may be applied to.
   */
  pieces: number | null;
  /** Bags, when the lot was counted in bags. Priceable **only** by a bag rate. */
  bags: number | null;
};

export function billableMeasure(item: OrderItemInput): BillableMeasure | null {
  if (item.quantity_type === "exact") {
    const counted = typeof item.exact_quantity === "number" && item.exact_quantity > 0
      ? item.exact_quantity
      : null;
    return counted === null ? null : { pieces: counted, bags: null };
  }

  const estimate = typeof item.estimated_quantity === "number" && item.estimated_quantity > 0
    ? item.estimated_quantity
    : null;
  const bags = typeof item.bag_count === "number" && item.bag_count > 0
    ? item.bag_count
    : null;

  // Both may be present, and both are kept: which one prices the lot depends on
  // which rate exists, not on which the counter happened to record. §4 — "by the
  // bag when a bag rate is set and the bags were counted, otherwise by the
  // counter's estimate" — is a rule about the *price*, so the measure must carry
  // both halves and let the pricer choose.
  if (estimate === null && bags === null) return null;
  return { pieces: estimate, bags };
}

/**
 * How many units of laundry a row represents, without saying what a unit is.
 *
 * Kept for the places that are **counting laundry rather than pricing it** — the
 * billing screens' "pieces of laundry" totals — where a bag counted as one is a
 * defensible approximation and a null would read as no laundry at all. Nothing
 * that multiplies by a rate may use this: use `billableMeasure` and look at
 * which of the two numbers is there, which is the distinction that was missing.
 */
export function billableQuantity(item: OrderItemInput): number | null {
  const measure = billableMeasure(item);
  if (!measure) return null;
  return measure.pieces ?? measure.bags;
}

/** The pricing models that mean "a rate per piece of laundry". */
const PER_UNIT_MODELS = new Set(["per_item", "per_kg"]);

/**
 * Price a job's laundry against a rate card.
 *
 * Pure and total: it never throws, and laundry it cannot price comes back in
 * `unpriced` instead of being dropped. The caller decides whether that is a
 * blocker — at review time it is a warning beside the charges, because a
 * reviewer with a rate card that does not cover a bag of uniforms still needs to
 * see the rest of the job and add a line by hand.
 *
 * `included_quantity` is honoured per job: a rate line that includes ten towels
 * bills the eleventh onwards. This is the same allowance the recurring engine
 * applies per collection, applied to the one collection this job is.
 */
export function priceJob(input: {
  items: readonly OrderItemInput[];
  rateLines: readonly RateLine[];
  rateCard?: RateCard | null;
  /**
   * The customer's laundry price list, already resolved by `priceListFor` —
   * their own row where they have one, the tenant default otherwise.
   *
   * **The tier beneath the rate card, and the reason this app can bill anybody
   * on day one.** A rate card is a negotiated agreement, and most customers do
   * not have one: on the live deployment 508 of 508 have none. Without a
   * fallback every job for every one of them would come back wholly `unpriced`,
   * which reads as the pricing being broken rather than as a rate card being
   * absent — and would put 508 rate cards between the owner and their first
   * invoice.
   *
   * Precedence is strict and there is no blending: a rate line wins outright,
   * and the price list answers only where the card is silent. Two half-answers
   * averaged together is not a price anybody agreed to.
   *
   * Keyed on the kind of laundry. `itemPriceList` below is the same list keyed
   * on the item itself, which is the more specific answer within this tier.
   */
  priceList?: ReadonlyMap<string, LaundryListPrice> | null;
  /**
   * The same price list, keyed on the item master row (0032).
   *
   * Consulted before `priceList`, because a price written against TOW001 is a
   * price for TOW001 and a price written against "towels" is a price for every
   * kind of towel.
   */
  itemPriceList?: ReadonlyMap<string, LaundryListPrice> | null;
}): JobPricingResult {
  const { items, rateLines, rateCard, priceList, itemPriceList } = input;

  // A rate card may carry more than one line for the same kind of laundry
  // (a wash-only rate and a rental rate for towels, say). The first wins, which
  // is the order the agreement itself stores them in — deterministic, and the
  // reviewer can see which line was used because every snapshot row names it.
  //
  // Two indexes since 0032, because a rate line may name **an item** (TOW001)
  // or **a kind of laundry** (towels). The item is the more specific agreement
  // and wins; see `rateFor` below.
  const byItemId = new Map<string, RateLine>();
  const byItemType = new Map<string, RateLine>();
  for (const line of rateLines) {
    if (!PER_UNIT_MODELS.has(line.pricing_model)) continue;
    if (line.item_id && !byItemId.has(line.item_id)) byItemId.set(line.item_id, line);
    if (!line.laundry_item_type) continue;
    if (!byItemType.has(line.laundry_item_type)) byItemType.set(line.laundry_item_type, line);
  }

  /**
   * Which agreed rate covers this item, in order of how specifically it was
   * agreed: a line for this exact item, then a line for its kind of laundry.
   *
   * The precedence is *specificity within a tier*, and the tiers themselves stay
   * as they were: the rate card is a negotiated agreement and answers first,
   * whichever of its lines matched; the price list answers where the card is
   * silent. A card that names towels and a list that names TOW001 is the card's
   * answer, because somebody negotiated it.
   */
  const rateFor = (item: OrderItemInput): RateLine | undefined =>
    (item.item_id ? byItemId.get(item.item_id) : undefined) ?? byItemType.get(item.item_type);

  const lines: JobChargeLine[] = [];
  const unpriced: JobPricingResult["unpriced"] = [];

  for (const item of items) {
    const label = item.item_type === "other"
      ? (item.custom_description?.trim() || "Other")
      : ITEM_TYPE_LABELS[item.item_type as ItemType] ?? item.item_type;

    const rate = rateFor(item);
    const measure = billableMeasure(item);
    const gap = (reason: UnpricedReason) => {
      unpriced.push({ itemType: item.item_type, label, description: describeItem(item), reason });
    };

    // Nothing to multiply by: a bulk lot recorded as a note alone. The gap is in
    // what the counter measured, not in what anybody has priced, so no rate and
    // no price list can rescue it — said before the tiers are consulted, or the
    // reviewer is sent to a price screen that would not have helped.
    if (!measure) { gap("not_measured"); continue; }

    // No usable rate line — try the price list before giving up.
    if (!rate || rate.unit_price <= 0) {
      // Same specificity rule one tier down: this item's own listed price, then
      // the price for its kind of laundry.
      const listed = (item.item_id ? itemPriceList?.get(item.item_id) : undefined)
        ?? priceList?.get(item.item_type);
      if (!listed) {
        // Which of the two gaps it is depends on whether there was a code to
        // look up at all. A row naming an item that nobody has priced wants a
        // price; a row naming no item, **in a laundry that prices by item
        // code**, wants the job edited — and saying "no rate" to that is a false
        // trail onto a list that is already full.
        //
        // The second condition is what keeps that honest: a laundry with no
        // item-keyed prices does not price by code, so a missing code is not
        // what is wrong and the plain "no rate" is the true answer.
        const pricesByItemCode = (itemPriceList?.size ?? 0) > 0;
        gap(!item.item_id && pricesByItemCode ? "no_item_code" : "no_rate");
        continue;
      }
      const fallback = priceFromList(item, listed, measure, label, lines.length + 1);
      if (fallback) {
        lines.push(fallback);
        continue;
      }
      // The list has a rate and it still could not be applied, which for a
      // listed item means exactly one thing: the lot was counted in bags and the
      // only rate is per piece. Naming that sends the owner to the "Price per
      // bag" column rather than back to a price they have already set.
      gap(measure.pieces === null ? "no_bag_rate" : "no_rate");
      continue;
    }

    // **A rate card prices per piece and per kilo, and never per bag.** So a lot
    // with no piece count cannot be billed from one, however complete the card
    // is — multiplying a bag count by a per-piece rate is the defect this
    // refuses. The price list may still have a bag rate, but a rate line is the
    // more specific agreement and having matched one we do not fall back to it.
    if (measure.pieces === null) { gap("no_bag_rate"); continue; }
    const quantity = measure.pieces;

    const included = Math.max(0, Number(rate.included_quantity ?? 0));
    const billable = round2(Math.max(0, quantity - included));
    if (billable <= 0) {
      // Fully covered by the allowance. Not "unpriced" — the rate card has an
      // answer and the answer is nothing to pay, so it is recorded as a zero
      // line rather than sent to the reviewer as a gap.
      lines.push({
        sequence: lines.length + 1,
        description: `${label} — ${quantity} included in the rate`,
        charge_type: asChargeType(rate.charge_type),
        quantity,
        unit_price: 0,
        amount: 0,
        taxable: rate.taxable,
        source_agreement_id: rate.agreement_id,
        source_agreement_line_id: rate.id,
        // The item actually in the bag where there is one — that is what the
        // consolidated invoice groups by, and what a reviewer needs to see.
        source_item_id: item.item_id ?? rate.item_id,
        source_laundry_item_type: item.item_type,
        pricing_model: rate.pricing_model,
        gl_account_id: null,
      });
      continue;
    }

    lines.push({
      sequence: lines.length + 1,
      description: included > 0
        ? `${label} — ${billable} of ${quantity} (${included} included)`
        : `${label} — ${billable}`,
      charge_type: asChargeType(rate.charge_type),
      quantity: billable,
      unit_price: round2(rate.unit_price),
      amount: lineAmount(billable, rate.unit_price),
      taxable: rate.taxable,
      source_agreement_id: rate.agreement_id,
      source_agreement_line_id: rate.id,
      source_item_id: item.item_id ?? rate.item_id,
      source_laundry_item_type: item.item_type,
      pricing_model: rate.pricing_model,
      gl_account_id: null,
    });
  }

  // A fuel levy is charged per delivery, so a job is exactly the right unit for
  // it and it belongs on the snapshot. The agreement's **minimum charge is
  // deliberately not applied here**: a minimum is a promise about a *period*
  // ("at least $200 a month"), and topping every job up to it would bill a
  // customer with fifteen jobs fifteen minimums. The recurring engine still
  // applies it to the period, which is the only place it means anything.
  const levy = Number(rateCard?.fuel_levy_pct ?? 0);
  const base = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  if (levy > 0 && base > 0) {
    const amount = round2(base * (levy / 100));
    if (amount > 0) {
      lines.push({
        sequence: lines.length + 1,
        description: `Fuel levy (${levy}%)`,
        charge_type: "fuel_levy",
        quantity: 1,
        unit_price: amount,
        amount,
        taxable: true,
        source_agreement_id: rateCard?.id ?? null,
        source_agreement_line_id: null,
        source_item_id: null,
        source_laundry_item_type: null,
        pricing_model: "percentage",
        gl_account_id: null,
      });
    }
  }

  return { lines, unpriced };
}

/**
 * One charge line from the laundry price list, when the rate card is silent.
 *
 * The bag rule is the same one `laundry-billing.ts` applies and is deliberately
 * restated rather than shared: a bulk lot bills **by the bag** when a bag rate
 * is set and bags were counted, and otherwise at the piece rate against the
 * counter's estimate. Nothing here invents a quantity that was never recorded —
 * `billableQuantity` has already refused the lot with neither.
 *
 * `source_agreement_id` and friends stay null, which is the honest provenance:
 * this price came from the list, not from any agreement. The snapshot row's
 * description says so too, so a reviewer reading it a year later can tell which
 * tier answered.
 */
function priceFromList(
  item: OrderItemInput,
  price: LaundryListPrice,
  measure: BillableMeasure,
  label: string,
  sequence: number,
): JobChargeLine | null {
  // **§4's rule, and the reason the measure carries both numbers.** A bag rate
  // and counted bags bill by the bag, whether or not the counter also estimated
  // the pieces; otherwise the estimate prices it per piece. What is *not*
  // allowed is the third combination — bags counted, no bag rate — because there
  // is no number of pieces in a bag that this app knows, and inventing one is
  // what produced $0.96 for four bags of towels. That returns null, and the
  // caller reports it as `no_bag_rate`.
  const useBags = measure.bags !== null && price.bagPrice !== null;
  const quantity = useBags ? measure.bags! : (measure.pieces ?? 0);
  const unitPrice = useBags ? price.bagPrice! : price.unitPrice;
  if (quantity <= 0 || unitPrice <= 0) return null;

  const detail = useBags
    ? `${quantity} ${quantity === 1 ? "bag" : "bags"} of ${label}`
    : `${label} — ${quantity}`;

  return {
    sequence,
    description: `${detail} (price list)`,
    charge_type: "wash_only",
    quantity,
    unit_price: round2(unitPrice),
    amount: lineAmount(quantity, unitPrice),
    taxable: price.taxable,
    source_agreement_id: null,
    source_agreement_line_id: null,
    // Carried even though the price came from the list rather than a rate line:
    // this is what the consolidated invoice groups by, and "which item was
    // billed" is a different question from "which agreement priced it".
    source_item_id: item.item_id ?? null,
    source_laundry_item_type: item.item_type,
    pricing_model: useBags ? "per_bag" : "per_item",
    gl_account_id: null,
  };
}

/** What the priced lines add up to, GST included (a line amount is inclusive since 0043). */
export function jobChargeSubtotal(lines: readonly { amount: number }[]): number {
  return round2(lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0));
}

const CHARGE_TYPES = new Set<string>([
  "rental", "wash_only", "replacement", "minimum_service_fee", "fuel_levy",
  "emergency_delivery", "weekend_surcharge", "holiday_surcharge", "bag_charge",
  "weight_charge", "monthly_fee", "other",
]);

/**
 * A charge type the snapshot's check constraint will actually accept.
 *
 * The rate line's own column is constrained to the same set, so this can only
 * fire on data that predates a constraint or arrived some other way — and
 * falling back to `other` keeps a job priceable instead of failing the whole
 * save on one unexpected string.
 */
function asChargeType(value: string): ChargeType {
  return (CHARGE_TYPES.has(value) ? value : "other") as ChargeType;
}

/**
 * Which tier actually answered, in the words a reviewer reads back.
 *
 * There are two tiers and both can contribute to the same job — a rate card
 * covering towels and a price list covering the sheets it says nothing about is
 * the ordinary case (§21). So "priced from the rate card" is a half-truth often
 * enough to be worth computing rather than assuming, and the provenance is
 * already on every line: a list-priced line carries no `source_agreement_id`.
 *
 * Pure, and shared by the single Price button and the bulk one, so twenty jobs
 * cannot be described differently from one.
 */
export function pricingSourceLabel(
  lines: readonly Pick<JobChargeLine, "source_agreement_id">[],
  card: { agreement_number: string; version: number } | null,
): string {
  const list = "the laundry price list";
  if (!card) return list;

  const named = `${card.agreement_number} v${card.version}`;
  const fromCard = lines.some((line) => line.source_agreement_id);
  const fromList = lines.some((line) => !line.source_agreement_id);
  if (fromCard && fromList) return `${named} and ${list}`;
  return fromCard ? named : list;
}
