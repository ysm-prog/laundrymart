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
};

export type JobPricingResult = {
  lines: JobChargeLine[];
  /**
   * Laundry on the job that the rate card says nothing about. Surfaced rather
   * than silently priced at zero: "we have no rate for uniforms for this
   * customer" is a thing somebody must decide, and a zero line looks like a
   * decision that was already taken.
   */
  unpriced: Array<{ itemType: string; label: string; description: string }>;
};

/**
 * How many units of laundry a row represents, for pricing.
 *
 * A counted row bills what was counted. A bulk lot has no count by definition
 * (0014), so it bills the *estimate* when one was given and otherwise the bag
 * count — and when it carries neither it is not priced at all rather than being
 * guessed at, which is why `null` is a real answer here.
 */
export function billableQuantity(item: OrderItemInput): number | null {
  if (item.quantity_type === "exact") {
    return typeof item.exact_quantity === "number" && item.exact_quantity > 0
      ? item.exact_quantity
      : null;
  }
  if (typeof item.estimated_quantity === "number" && item.estimated_quantity > 0) {
    return item.estimated_quantity;
  }
  if (typeof item.bag_count === "number" && item.bag_count > 0) return item.bag_count;
  return null;
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
   * Precedence is strict and there is no blending: a rate line for a kind of
   * laundry wins outright, and the price list answers only where the card is
   * silent. Two half-answers averaged together is not a price anybody agreed to.
   */
  priceList?: ReadonlyMap<string, LaundryListPrice> | null;
}): JobPricingResult {
  const { items, rateLines, rateCard, priceList } = input;

  // A rate card may carry more than one line for the same kind of laundry
  // (a wash-only rate and a rental rate for towels, say). The first wins, which
  // is the order the agreement itself stores them in — deterministic, and the
  // reviewer can see which line was used because every snapshot row names it.
  const byItemType = new Map<string, RateLine>();
  for (const line of rateLines) {
    if (!line.laundry_item_type) continue;
    if (!PER_UNIT_MODELS.has(line.pricing_model)) continue;
    if (!byItemType.has(line.laundry_item_type)) byItemType.set(line.laundry_item_type, line);
  }

  const lines: JobChargeLine[] = [];
  const unpriced: JobPricingResult["unpriced"] = [];

  for (const item of items) {
    const label = item.item_type === "other"
      ? (item.custom_description?.trim() || "Other")
      : ITEM_TYPE_LABELS[item.item_type as ItemType] ?? item.item_type;

    const rate = byItemType.get(item.item_type);
    const quantity = billableQuantity(item);

    // No usable rate line — try the price list before giving up. A quantity of
    // `null` is *not* recoverable this way: it means the counter recorded a bulk
    // lot with neither an estimate nor a bag count, so there is nothing to
    // multiply any rate by and the gap is in what was measured, not in pricing.
    if (!rate || rate.unit_price <= 0) {
      const listed = priceList?.get(item.item_type);
      const fallback = listed && quantity !== null
        ? priceFromList(item, listed, label, lines.length + 1)
        : null;
      if (fallback) {
        lines.push(fallback);
        continue;
      }
      unpriced.push({ itemType: item.item_type, label, description: describeItem(item) });
      continue;
    }

    // Three different reasons a row goes unpriced, and all of them are the same
    // answer to the reviewer: this needs a human. The distinction that matters
    // is only that it is *listed*, not that it was rounded to nothing.
    if (quantity === null) {
      unpriced.push({ itemType: item.item_type, label, description: describeItem(item) });
      continue;
    }

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
        source_item_id: rate.item_id,
        source_laundry_item_type: item.item_type,
        pricing_model: rate.pricing_model,
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
      source_item_id: rate.item_id,
      source_laundry_item_type: item.item_type,
      pricing_model: rate.pricing_model,
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
  label: string,
  sequence: number,
): JobChargeLine | null {
  const bags = Math.max(0, Math.trunc(item.bag_count ?? 0));
  const useBags = item.quantity_type !== "exact" && bags > 0 && price.bagPrice !== null;

  const quantity = useBags ? bags : (billableQuantity(item) ?? 0);
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
    source_item_id: null,
    source_laundry_item_type: item.item_type,
    pricing_model: useBags ? "per_bag" : "per_item",
  };
}

/** What the priced lines add up to, before GST. */
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
