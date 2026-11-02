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

export function lineAmount(quantity: number, unitPrice: number): number {
  return round2(quantity * unitPrice);
}

export type InvoiceTotals = { subtotal: number; taxAmount: number; total: number };

export function summariseInvoice(
  lines: readonly Pick<DraftLine, "amount" | "taxable">[],
  gstRate = 0.1,
): InvoiceTotals {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const taxableBase = round2(lines.reduce((sum, l) => sum + (l.taxable ? l.amount : 0), 0));
  const taxAmount = round2(taxableBase * gstRate);
  return { subtotal, taxAmount, total: round2(subtotal + taxAmount) };
}

/**
 * The GST sitting inside a GST-inclusive amount.
 *
 * `recalculate_invoice`'s own formula (0043) in TypeScript, for the screens that
 * have to preview what the database will total. A rate of zero or a rate nobody
 * could read holds no GST at all.
 */
export function gstWithin(amount: number, gstRate: number): number {
  if (!Number.isFinite(gstRate) || gstRate <= 0) return 0;
  return round2(amount * (gstRate / (1 + gstRate)));
}

/**
 * Lines that add up the way an invoice will: the total is the sum of the amounts,
 * and the GST is extracted from the taxable part of that sum — once, over the
 * sum, because that is how `recalculate_invoice` rounds it.
 */
export function inclusiveTotals(
  lines: readonly { amount: number; taxable?: boolean | null }[],
  gstRate: number,
): { total: number; gst: number; anyTaxable: boolean } {
  const total = round2(lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0));
  const taxed = lines.filter((line) => line.taxable !== false);
  const taxableBase = round2(taxed.reduce((sum, line) => sum + Number(line.amount ?? 0), 0));
  return { total, gst: gstWithin(taxableBase, gstRate), anyTaxable: taxed.length > 0 };
}

/**
 * The words beside a total: never "GST included" over a figure holding none.
 *
 * Goes on what is taxable rather than on the GST being above zero, because a
 * five-cent taxable line rounds to $0.00 of GST and is still not GST-free.
 */
export function gstPhrase(gst: number, anyTaxable: boolean): string {
  return anyTaxable ? `including ${formatMoney(gst)} GST` : "no GST";
}

/** What a GST tick did to a rate, kept so that undoing it puts the rate back exactly. */
export type GstTickMemo = {
  /** The rate before the tick changed. */
  before: number;
  /** The rate the tick produced. */
  after: number;
  /** The state of the tick that produced `after`. */
  taxable: boolean;
};

/**
 * The rate on a line once its "GST applies" tick has changed (2026-11-02).
 *
 * **A line amount is GST-inclusive (0043), so the tick has to move the rate.**
 * Before this it changed only `taxable`, and the customer paid the same figure
 * either way: `TW` is $0.20 ex GST and $0.22 inclusive, and unticking GST on a
 * $0.22 line left $0.22 on the job with nothing on the screen moving — Jay's
 * report, and the owner's instruction is that the tick adds or subtracts the
 * value. So unticking takes the GST out of the rate and ticking puts it in.
 *
 * **The memo is what makes that reversible.** Rates are stored to the cent, so
 * the conversion loses information: $0.05 has less than half a cent of GST in it,
 * strips to $0.05 and would come back as $0.06. A tick reversed straight
 * away restores the exact rate it replaced. The memo is ignored once somebody has
 * typed over the rate, or if the tick is not actually being reversed.
 *
 * A rate of nothing stays nothing, and a rate nobody could read is left alone.
 */
export function rateForGstTick(input: {
  rate: number | string | null | undefined;
  taxable: boolean;
  gstRate: number;
  memo?: GstTickMemo | null;
}): { rate: number; memo: GstTickMemo | null } {
  const { taxable, gstRate, memo } = input;
  const rate = Number(input.rate ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return { rate: 0, memo: null };
  if (!Number.isFinite(gstRate) || gstRate <= 0) return { rate, memo: null };

  if (memo && memo.after === rate && memo.taxable !== taxable) {
    return { rate: memo.before, memo: null };
  }

  const next = round2(taxable ? rate * (1 + gstRate) : rate / (1 + gstRate));
  return { rate: next, memo: { before: rate, after: next, taxable } };
}

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
