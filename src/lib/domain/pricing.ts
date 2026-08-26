/**
 * Pricing and invoice maths (spec §7.14, §11).
 *
 * Two rules drive everything here:
 *  - precedence is agreement line → item default → category default → global default;
 *  - percentage-based charges (fuel levy, surcharges) apply to the service
 *    subtotal only, never to each other, so they can't compound silently.
 *
 * Pure functions, no database — the invoice generator and the UI share them.
 */

export const CHARGE_TYPES = [
  "rental", "wash_only", "replacement", "minimum_service_fee", "fuel_levy",
  "emergency_delivery", "weekend_surcharge", "holiday_surcharge", "bag_charge",
  "weight_charge", "monthly_fee", "other",
] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

export const PRICING_MODELS = ["per_item", "per_kg", "per_collection", "monthly", "percentage"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const CHARGE_TYPE_LABELS: Record<ChargeType, string> = {
  rental: "Rental",
  wash_only: "Wash only",
  replacement: "Replacement",
  minimum_service_fee: "Minimum service fee",
  fuel_levy: "Fuel levy",
  emergency_delivery: "Emergency delivery",
  weekend_surcharge: "Weekend surcharge",
  holiday_surcharge: "Holiday surcharge",
  bag_charge: "Bag charge",
  weight_charge: "Weight charge",
  monthly_fee: "Monthly fee",
  other: "Other",
};

export type WeightAllocationInput = {
  /** Weight actually collected over the billing period, in kilograms. */
  totalWeightKg: number;
  /** Collections that recorded a weight — each one earns the line's allowance. */
  collections: number;
  lines: ReadonlyArray<{
    key: string;
    /** Expected kg per collection; used only to weight the split. */
    standardQuantity?: number;
    /** Kilograms included free per collection. */
    includedQuantity?: number;
  }>;
};

export type WeightAllocation = {
  key: string;
  /** This line's slice of the collected weight, before its allowance. */
  shareKg: number;
  /** Free kilograms this line carries across the period. */
  allowanceKg: number;
  /** What is actually billed. */
  billableKg: number;
};

/**
 * Split the weight actually collected in a period across an agreement's per_kg
 * lines (§11).
 *
 * A pickup records one total weight, not a weight per item, so the usual case —
 * a single per_kg line — simply bills the lot. When an agreement carries more
 * than one per_kg line the weight is shared in proportion to each line's
 * standard quantity (equally if none is set), which is deterministic and can
 * never bill the same kilogram twice. Rounding remainder lands on the last line
 * so the shares always add back up to the weight that was weighed.
 */
export function allocateWeightCharges(input: WeightAllocationInput): WeightAllocation[] {
  const { lines, collections } = input;
  if (lines.length === 0) return [];

  const total = Math.max(0, input.totalWeightKg);
  const weights = lines.map((line) => Math.max(0, line.standardQuantity ?? 0));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);

  let allocated = 0;
  return lines.map((line, index) => {
    const isLast = index === lines.length - 1;
    // The last line absorbs the rounding remainder rather than dropping grams.
    const share = weightSum > 0 ? (weights[index] ?? 0) / weightSum : 1 / lines.length;
    const shareKg = isLast ? round2(total - allocated) : round2(total * share);
    allocated = round2(allocated + shareKg);

    const allowanceKg = round2(Math.max(0, line.includedQuantity ?? 0) * Math.max(0, collections));
    return {
      key: line.key,
      shareKg,
      allowanceKg,
      billableKg: round2(Math.max(0, shareKg - allowanceKg)),
    };
  });
}

export type PriceSources = {
  agreementLinePrice?: number | null;
  itemPrice?: number | null;
  categoryPrice?: number | null;
  globalPrice?: number | null;
};

export type PriceResolution = {
  price: number;
  source: "agreement_line" | "item" | "category" | "global" | "none";
};

/** Business rule §11: agreement line, then item default, then category, then global. */
export function resolvePrice(sources: PriceSources): PriceResolution {
  const candidates: Array<[PriceResolution["source"], number | null | undefined]> = [
    ["agreement_line", sources.agreementLinePrice],
    ["item", sources.itemPrice],
    ["category", sources.categoryPrice],
    ["global", sources.globalPrice],
  ];
  for (const [source, value] of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return { price: value, source };
  }
  return { price: 0, source: "none" };
}

export function round2(value: number): number {
  // Cent rounding that doesn't drift on values like 1.005 stored as binary float.
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type DraftLine = {
  description: string;
  chargeType: ChargeType;
  quantity: number;
  unitPrice: number;
  amount: number;
  taxable: boolean;
  itemId?: string | null;
  jobId?: string | null;
};

/**
 * MYOB's `Amount ($)` column: units × unit price, less any discount.
 *
 * The discount is a **percentage off the line**, which is the column the client's
 * invoice carries (`Discount (%)`, 0.00 on all three of its lines). It is applied
 * before rounding, so a 3.33% discount on a long line does not drift a cent from
 * what the same sum gives on a calculator.
 *
 * Out-of-range percentages are clamped rather than refused: the database
 * constrains the column, and a screen that silently produced a *negative* amount
 * from a typo would be worse than one that treats 150% as 100%.
 */
export function lineAmount(quantity: number, unitPrice: number, discountPercent = 0): number {
  const discount = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  return round2(quantity * unitPrice * (1 - discount / 100));
}

/**
 * Invoice totals moved to `lib/domain/gst.ts` on 2026-08-26, when GST became a
 * component *inside* the price rather than something added to it. `summariseInvoice`
 * lived here and computed the old exclusive model; it had no caller outside its own
 * tests, so it was removed rather than left looking live. Use `taxInclusiveTotals`.
 */

export type ServiceChargeInput = {
  /** Per-item service lines already priced. */
  items: ReadonlyArray<{
    itemId?: string | null;
    description: string;
    quantity: number;
    unitPrice: number;
    chargeType?: ChargeType;
    taxable?: boolean;
  }>;
  /**
   * Percentage lines carried on the agreement itself. They bill against the same
   * base as the levies below, so an agreement's own percentage charge can never
   * compound on top of the fuel levy (or vice versa).
   */
  percentageLines?: ReadonlyArray<{
    label: string;
    pct: number;
    chargeType?: ChargeType;
    itemId?: string | null;
    taxable?: boolean;
  }>;
  minimumCharge?: number;
  fuelLevyPct?: number;
  weekendSurchargePct?: number;
  holidaySurchargePct?: number;
  emergencyFee?: number;
  /** Set when the visits being billed fell on a weekend / public holiday. */
  servicedOnWeekend?: boolean;
  servicedOnHoliday?: boolean;
  isEmergency?: boolean;
};

/**
 * Build the draft lines for a billing period: the service lines, a top-up to the
 * agreement's minimum charge, then percentage charges on the service subtotal.
 */
export function buildServiceCharges(input: ServiceChargeInput): DraftLine[] {
  const lines: DraftLine[] = input.items.map((item) => ({
    description: item.description,
    chargeType: item.chargeType ?? "rental",
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: lineAmount(item.quantity, item.unitPrice),
    taxable: item.taxable ?? true,
    itemId: item.itemId ?? null,
  }));

  const serviceSubtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));

  // Minimum charge tops the period up rather than replacing the detail (§7.4).
  const minimum = input.minimumCharge ?? 0;
  if (minimum > 0 && serviceSubtotal < minimum) {
    const shortfall = round2(minimum - serviceSubtotal);
    lines.push({
      description: `Minimum service charge top-up (minimum ${formatMoney(minimum)})`,
      chargeType: "minimum_service_fee",
      quantity: 1,
      unitPrice: shortfall,
      amount: shortfall,
      taxable: true,
    });
  }

  // Percentages all apply to the same base so they never compound on each other.
  const base = round2(lines.reduce((sum, l) => sum + l.amount, 0));

  const percentage = (pct: number | undefined, chargeType: ChargeType, label: string) => {
    if (!pct || pct <= 0 || base <= 0) return;
    const amount = round2(base * (pct / 100));
    if (amount === 0) return;
    lines.push({
      description: `${label} (${pct}%)`,
      chargeType,
      quantity: 1,
      unitPrice: amount,
      amount,
      taxable: true,
    });
  };

  for (const line of input.percentageLines ?? []) {
    if (!line.pct || line.pct <= 0 || base <= 0) continue;
    const amount = round2(base * (line.pct / 100));
    if (amount === 0) continue;
    lines.push({
      description: `${line.label} (${line.pct}%)`,
      chargeType: line.chargeType ?? "other",
      quantity: 1,
      unitPrice: amount,
      amount,
      taxable: line.taxable ?? true,
      itemId: line.itemId ?? null,
    });
  }

  percentage(input.fuelLevyPct, "fuel_levy", "Fuel levy");
  if (input.servicedOnWeekend) percentage(input.weekendSurchargePct, "weekend_surcharge", "Weekend surcharge");
  if (input.servicedOnHoliday) percentage(input.holidaySurchargePct, "holiday_surcharge", "Public holiday surcharge");

  if (input.isEmergency && input.emergencyFee && input.emergencyFee > 0) {
    lines.push({
      description: "Emergency delivery",
      chargeType: "emergency_delivery",
      quantity: 1,
      unitPrice: input.emergencyFee,
      amount: round2(input.emergencyFee),
      taxable: true,
    });
  }

  return lines;
}

/** Damaged and missing items become replacement charges (§11). */
export function buildReplacementCharges(
  lines: ReadonlyArray<{
    itemId: string;
    itemName: string;
    damagedQuantity: number;
    missingQuantity: number;
    replacementCost: number;
  }>,
): DraftLine[] {
  const out: DraftLine[] = [];
  for (const line of lines) {
    const quantity = line.damagedQuantity + line.missingQuantity;
    if (quantity <= 0 || line.replacementCost <= 0) continue;
    out.push({
      description: `Replacement — ${line.itemName} (${line.damagedQuantity} damaged, ${line.missingQuantity} missing)`,
      chargeType: "replacement",
      quantity,
      unitPrice: line.replacementCost,
      amount: lineAmount(quantity, line.replacementCost),
      taxable: true,
      itemId: line.itemId,
    });
  }
  return out;
}

export function formatMoney(value: number, currency = "AUD", locale = "en-AU"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value ?? 0);
}
