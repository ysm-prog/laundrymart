import { generateServiceDates, parsePattern, type HolidayRule } from "@/lib/domain/service-calendar";
import {
  buildServiceCharges, resolvePrice, round2, type DraftLine,
} from "@/lib/domain/pricing";

/**
 * Recurring invoicing: the part with no database in it.
 *
 * The generator in `invoices/actions.ts` reads rows, groups them by customer
 * and writes invoices; everything here decides *what a contract is owed*, from
 * plain data. Kept in the domain layer for the same reason the service calendar
 * and the pricing engine are — the money rules have to be testable in
 * milliseconds, and a rule that can only run against a live Supabase project is
 * a rule nobody re-checks.
 */

export type BillableAgreement = {
  id: string;
  customer_id: string;
  depot_id: string | null;
  location_id: string | null;
  start_date: string;
  end_date: string | null;
  pickup_pattern: unknown;
  minimum_charge: number;
  holiday_rule: string;
  holiday_region: string;
  weekend_surcharge_pct: number;
  holiday_surcharge_pct: number;
  fuel_levy_pct: number;
  payment_terms_days: number;
  purchase_order_number: string | null;
  emergency_service: boolean;
};

export type BillableLine = {
  id: string;
  agreement_id: string;
  item_id: string | null;
  charge_type: string;
  pricing_model: string;
  unit_price: number;
  percentage: number | null;
  standard_quantity: number;
  included_quantity: number;
  taxable: boolean;
  items: { name: string; sku: string; rental_price: number; wash_only_price: number; replacement_cost: number } | null;
};


/**
 * One contract's charges for the period — the calendar expansion, the priced
 * lines, its minimum top-up and its levies.
 *
 * Pure: it reads no database. Everything it needs about the *customer* (the
 * weight allocation, the collection count) is passed in already computed,
 * because those are shared across the customer's contracts and must not be
 * fetched — or charged — once per contract.
 */
export function contractCharges(input: {
  agreement: BillableAgreement;
  lines: readonly BillableLine[];
  holidays: ReadonlyArray<{ holiday_date: string; region: string }>;
  weightByLine: ReadonlyMap<string, { billableKg: number; allowanceKg: number }>;
  weighedCollections: number;
  start: string;
  end: string;
}): DraftLine[] {
  const { agreement, lines, weightByLine, weighedCollections, start, end } = input;

  const visits = generateServiceDates({
    pattern: parsePattern(agreement.pickup_pattern),
    from: start, to: end,
    holidays: input.holidays
      .filter((row) => row.region === agreement.holiday_region)
      .map((row) => row.holiday_date),
    holidayRule: agreement.holiday_rule as HolidayRule,
    startDate: agreement.start_date,
    endDate: agreement.end_date,
  });

  const serviceItems = lines.flatMap((line) => {
    const item = line.items;

    // Pricing precedence §11: agreement line first, then the item default.
    // A per-kg line is a rate per kilogram, and no item carries one, so it can
    // only ever be priced by the agreement itself.
    const { price } = resolvePrice({
      agreementLinePrice: line.unit_price > 0 ? line.unit_price : null,
      itemPrice: line.pricing_model === "per_kg"
        ? null
        : line.charge_type === "wash_only" ? item?.wash_only_price : item?.rental_price,
    });

    const quantity = (() => {
      switch (line.pricing_model) {
        case "per_item": return Math.max(0, line.standard_quantity - line.included_quantity) * visits.length;
        case "per_collection": return visits.length;
        case "per_kg": return weightByLine.get(line.id)?.billableKg ?? 0;
        case "monthly": return 1;
        default: return 0; // percentage lines charge off the subtotal below
      }
    })();

    if (quantity <= 0 || price <= 0) return [];

    const detail = (() => {
      switch (line.pricing_model) {
        case "per_collection":
          return `${visits.length} collection(s)`;
        case "per_kg": {
          const allowance = weightByLine.get(line.id)?.allowanceKg ?? 0;
          return `${quantity} kg over ${weighedCollections} collection(s)` +
            (allowance > 0 ? `, ${allowance} kg included` : "");
        }
        default:
          return `${quantity} × ${start} to ${end}`;
      }
    })();

    return [{
      itemId: line.item_id,
      description: `${item?.name ?? "Service"} — ${detail}`,
      quantity: round2(quantity),
      unitPrice: price,
      chargeType: line.charge_type as DraftLine["chargeType"],
      taxable: line.taxable,
    }];
  });

  // Percentage lines are a rate against the service subtotal, so they are
  // handed to the pricing engine alongside the levies to share one base.
  const percentageLines = lines.flatMap((line) =>
    line.pricing_model === "percentage" && Number(line.percentage ?? 0) > 0
      ? [{
          label: line.items?.name ?? "Agreement charge",
          pct: Number(line.percentage),
          chargeType: line.charge_type as DraftLine["chargeType"],
          itemId: line.item_id,
          taxable: line.taxable,
        }]
      : [],
  );

  return buildServiceCharges({
    items: serviceItems,
    percentageLines,
    minimumCharge: Number(agreement.minimum_charge ?? 0),
    fuelLevyPct: Number(agreement.fuel_levy_pct ?? 0),
    weekendSurchargePct: Number(agreement.weekend_surcharge_pct ?? 0),
    holidaySurchargePct: Number(agreement.holiday_surcharge_pct ?? 0),
    servicedOnWeekend: visits.some((visit) => visit.isWeekend),
    servicedOnHoliday: visits.some((visit) => visit.isPublicHoliday),
  });
}

/**
 * One value when every contract agrees, the fallback when they do not.
 *
 * Consolidating across contracts means some header fields have no single right
 * answer. Rather than silently taking the first contract's, an unresolved field
 * falls back to something that belongs to the customer (their own payment
 * terms) or to nothing at all (a purchase order number).
 */
export function consolidate<T>(values: readonly T[], fallback: T): T {
  const first = values[0];
  if (first === undefined) return fallback;
  return values.every((value) => value === first) ? first : fallback;
}
