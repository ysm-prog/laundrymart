/**
 * Rolling a period's job charges up into one invoice. No database in sight.
 *
 * **The decision this file exists to make good on.** A customer who hands
 * laundry over ten times in August receives *one* invoice, and that invoice says
 *
 *     TOW001  Bath Towel   1,450   $X.XX   $X.XX
 *
 * rather than thirty lines each naming a job number. Before this, a consolidated
 * invoice carried one line per job charge — which is a breakdown, not a summary,
 * and made a ten-job month unreadable.
 *
 * The breakdown is not lost, and it is not duplicated either. It already exists,
 * frozen, one row per job per item, in `job_charge_snapshots`:
 *
 *     invoice_lines ─────────────────────────► one line per ITEM
 *           │
 *           │  the audit trail behind it, untouched
 *           ▼
 *     invoice_source_jobs ─► laundry_orders ─► job_charge_snapshots
 *
 * So this module produces *both* from one pass over the same entries: the lines
 * that go on the invoice, and the per-job breakdown that goes underneath it.
 * Two readings of one set of numbers can never disagree, because they are
 * computed together.
 *
 * **Why it lives in `lib/domain/`.** `lib/invoices/from-jobs.ts` reaches
 * `recordAudit` → `lib/supabase/server` → `lib/env`, which throws without a
 * configured environment — so a rule stated there is a rule no unit test can
 * import. This repository has shipped two payload contracts broken behind a
 * green `verify` for exactly that reason. The rule goes where a test can reach
 * it; the writer stays where the I/O is.
 */

import { round2 } from "@/lib/domain/pricing";
import { startOfIsoWeek, type IsoDate } from "@/lib/domain/dates";

/* ------------------------------------------------------------------ input */

/** One frozen charge, as this module needs it. Structurally a `StoredCharge`. */
export type ConsolidatableCharge = {
  description: string;
  charge_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  source_item_id: string | null;
  source_agreement_id: string | null;
  source_laundry_item_type: string | null;
  /**
   * Where this charge's money lands (0039). Optional so a caller that predates
   * the column still typechecks; part of the consolidation key either way, so
   * two charges coded differently never merge into one line.
   */
  gl_account_id?: string | null;
};

/** The job a charge came off. `date` is the day it counts as, already resolved. */
export type ChargeSource = {
  id: string;
  orderNumber: string;
  /** `YYYY-MM-DD`. The day the work finished — see `periodBillingSummary`. */
  date: IsoDate | null;
};

export type ChargeEntry = { job: ChargeSource; charge: ConsolidatableCharge };

/* ----------------------------------------------------------------- output */

/** Which job contributed what to a rolled-up line. */
export type LineContribution = {
  jobId: string;
  orderNumber: string;
  date: IsoDate | null;
  quantity: number;
  amount: number;
};

export type ConsolidatedLine = {
  /** Stable within one call. Used as a React key and for nothing else. */
  key: string;
  description: string;
  charge_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxable: boolean;
  source_item_id: string | null;
  source_agreement_id: string | null;
  source_laundry_item_type: string | null;
  /** Where this line's money lands (0039), carried from the charges it rolls up. */
  gl_account_id: string | null;
  /** True when more than one job's charge was folded into this line. */
  merged: boolean;
  contributions: LineContribution[];
};

/* ----------------------------------------------------------- what merges */

/**
 * A charge merges only when it names a **kind of laundry**.
 *
 * A towel line and another towel line at the same rate are the same thing said
 * twice, and the customer wants the total. A fuel levy is not: it is charged
 * once per delivery, and three deliveries' levies collapsed into "Fuel levy ×3"
 * hides which runs were levied. The same goes for a minimum service fee (a
 * promise about a period), a weekend surcharge and an emergency delivery — each
 * is an event, and an event keeps its own line with its job number on it.
 *
 * Stated as "does it have an item identity?" rather than as a list of charge
 * types, so a charge type added later is non-merging until somebody gives it an
 * item — which is the safe default: a line too many is legible, a line that
 * silently absorbed three events is not.
 */
export function isMergeable(charge: ConsolidatableCharge): boolean {
  return Boolean(charge.source_item_id) || Boolean(charge.source_laundry_item_type);
}

/**
 * The bucket a charge belongs to.
 *
 * Item identity first — the item id, then the kind of laundry, which is what a
 * job priced from the tenant's price list rather than a rate card carries.
 *
 * **The unit price is always part of the key, and that is a rule not an
 * accident.** A customer whose towel rate rose mid-period gets two lines, at the
 * two rates they were actually charged. Averaging them would produce a rate
 * nobody agreed to and a line the customer cannot reconcile against anything.
 * `taxable` is in the key for the same reason: GST is a property of the line.
 */
export function consolidationKey(charge: ConsolidatableCharge): string | null {
  if (!isMergeable(charge)) return null;
  const identity = charge.source_item_id
    ? `item:${charge.source_item_id}`
    : `type:${charge.source_laundry_item_type}`;
  return [
    identity,
    charge.charge_type,
    charge.unit_price.toFixed(4),
    charge.taxable ? "gst" : "free",
    // **The account is part of the key for the same reason GST is.** Where the
    // money lands is a property of the line, not a detail to average away: two
    // charges for the same item coded to different accounts — which happens the
    // moment somebody overrides one on the Charges screen — must stay two lines,
    // or the whole amount posts to whichever account happened to be first.
    `acct:${charge.gl_account_id ?? "none"}`,
  ].join("|");
}

/* ------------------------------------------------------------ the roll-up */

/**
 * Roll a period's charges into the lines an invoice should carry.
 *
 * Order is the order the entries arrived in, by first appearance — which the
 * caller has already sorted by completion date, so the invoice reads
 * chronologically for the un-mergeable lines and puts each item where it was
 * first seen.
 *
 * **Amounts are summed, never recomputed.** `quantity × unit_price` would be
 * within a cent of the same answer, and the cent is the whole point: the invoice
 * total has to equal the sum of the frozen job charges exactly, or the customer's
 * invoice and the audit trail behind it disagree by rounding and nobody can say
 * which is right. The quantity is summed for the same reason.
 */
export function consolidateChargeLines(entries: readonly ChargeEntry[]): ConsolidatedLine[] {
  const byKey = new Map<string, ConsolidatedLine>();
  const lines: ConsolidatedLine[] = [];

  entries.forEach((entry, index) => {
    const { job, charge } = entry;
    const key = consolidationKey(charge);
    const contribution: LineContribution = {
      jobId: job.id,
      orderNumber: job.orderNumber,
      date: job.date,
      quantity: charge.quantity,
      amount: charge.amount,
    };

    if (key !== null) {
      const existing = byKey.get(key);
      if (existing) {
        existing.quantity = round2(existing.quantity + charge.quantity);
        existing.amount = round2(existing.amount + charge.amount);
        existing.contributions.push(contribution);
        existing.merged = true;
        return;
      }
    }

    const line: ConsolidatedLine = {
      // A non-mergeable charge gets a per-entry key so two identical fuel levies
      // stay two lines and two React keys.
      key: key ?? `solo:${index}`,
      // A rolled-up line drops the job-number prefix the per-job shape carries:
      // it belongs to several jobs and naming one of them would be a lie.
      description: charge.description,
      charge_type: charge.charge_type,
      quantity: charge.quantity,
      unit_price: charge.unit_price,
      amount: charge.amount,
      taxable: charge.taxable,
      source_item_id: charge.source_item_id,
      source_agreement_id: charge.source_agreement_id,
      source_laundry_item_type: charge.source_laundry_item_type,
      // Safe to take from the first contributor: the account is part of the
      // consolidation key, so every charge folded into this line shares it.
      gl_account_id: charge.gl_account_id ?? null,
      merged: false,
      contributions: [contribution],
    };
    if (key !== null) byKey.set(key, line);
    lines.push(line);
  });

  return lines;
}

/** What the rolled-up lines add up to, before GST. */
export function consolidatedSubtotal(lines: readonly ConsolidatedLine[]): number {
  return round2(lines.reduce((sum, line) => sum + line.amount, 0));
}

/* --------------------------------------------------------- the breakdown */

export type BreakdownItem = {
  description: string;
  charge_type: string;
  quantity: number;
  unit_price: number;
  amount: number;
  source_item_id: string | null;
  source_laundry_item_type: string | null;
};

export type BreakdownJob = {
  jobId: string;
  orderNumber: string;
  date: IsoDate | null;
  items: BreakdownItem[];
  total: number;
};

export type BreakdownWeek = {
  /** Monday of the week, `YYYY-MM-DD`. `null` holds jobs with no date. */
  weekStart: IsoDate | null;
  jobs: BreakdownJob[];
  total: number;
};

/**
 * The service breakdown that sits under the consolidated total.
 *
 * Grouped by week because that is the unit the client asked for — *"Week 1: 2
 * August, 5 August; Week 2: 9 August"* — and because a month of daily
 * collections is thirty headings otherwise. Weeks are ISO weeks (Monday), the
 * same definition the service calendar already uses, so a week here and a week
 * in the run schedule mean the same span.
 *
 * A job with no completion date is not dropped. It sorts last under a `null`
 * week and says so on screen: a job that got onto an invoice without a date is
 * something to look at, and hiding it is how it never gets looked at.
 */
export function buildServiceBreakdown(entries: readonly ChargeEntry[]): BreakdownWeek[] {
  const jobs = new Map<string, BreakdownJob>();
  const order: string[] = [];

  for (const { job, charge } of entries) {
    let bucket = jobs.get(job.id);
    if (!bucket) {
      bucket = { jobId: job.id, orderNumber: job.orderNumber, date: job.date, items: [], total: 0 };
      jobs.set(job.id, bucket);
      order.push(job.id);
    }
    bucket.items.push({
      description: charge.description,
      charge_type: charge.charge_type,
      quantity: charge.quantity,
      unit_price: charge.unit_price,
      amount: charge.amount,
      source_item_id: charge.source_item_id,
      source_laundry_item_type: charge.source_laundry_item_type,
    });
    bucket.total = round2(bucket.total + charge.amount);
  }

  const weeks = new Map<string, BreakdownWeek>();
  const weekOrder: string[] = [];

  for (const id of order) {
    const job = jobs.get(id)!;
    const weekStart = job.date ? startOfIsoWeek(job.date) : null;
    const key = weekStart ?? "￿:undated";
    let week = weeks.get(key);
    if (!week) {
      week = { weekStart, jobs: [], total: 0 };
      weeks.set(key, week);
      weekOrder.push(key);
    }
    week.jobs.push(job);
    week.total = round2(week.total + job.total);
  }

  // Chronological, with the undated bucket last — the sentinel key sorts there
  // because ￿ is above every digit.
  weekOrder.sort();
  return weekOrder.map((key) => {
    const week = weeks.get(key)!;
    week.jobs.sort((a, b) => (a.date ?? "￿").localeCompare(b.date ?? "￿")
      || a.orderNumber.localeCompare(b.orderNumber));
    return week;
  });
}

/* ------------------------------------------------------- the item summary */

export type ItemTotal = {
  key: string;
  description: string;
  source_item_id: string | null;
  source_laundry_item_type: string | null;
  quantity: number;
  amount: number;
};

/**
 * Total quantity per kind of laundry across the period — the client's
 * *"Towels 1,450 / Sheets 620 / Pillowcases 780"* table.
 *
 * Deliberately **not** the same thing as `consolidateChargeLines`: this ignores
 * the unit price, so a customer whose towel rate changed mid-period still reads
 * one line saying 1,450 towels. That is the right answer to "how much laundry
 * did we do?" and the wrong answer to "what goes on the invoice?", which is
 * exactly why they are two functions.
 */
export function itemTotals(entries: readonly ChargeEntry[]): ItemTotal[] {
  const byKey = new Map<string, ItemTotal>();
  const order: string[] = [];

  for (const { charge } of entries) {
    if (!isMergeable(charge)) continue;
    const key = charge.source_item_id
      ? `item:${charge.source_item_id}`
      : `type:${charge.source_laundry_item_type}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity = round2(existing.quantity + charge.quantity);
      existing.amount = round2(existing.amount + charge.amount);
      continue;
    }
    byKey.set(key, {
      key,
      description: charge.description,
      source_item_id: charge.source_item_id,
      source_laundry_item_type: charge.source_laundry_item_type,
      quantity: charge.quantity,
      amount: charge.amount,
    });
    order.push(key);
  }

  return order.map((key) => byKey.get(key)!);
}
