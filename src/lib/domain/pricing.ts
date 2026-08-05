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
