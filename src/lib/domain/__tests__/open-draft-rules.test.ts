import { describe, expect, it } from "vitest";
import { groupJobsForInvoicing, type GroupableJob } from "@/lib/domain/invoice-grouping";
import {
  jobInvoiceLines, type ChargeEntry, type ConsolidatableCharge,
} from "@/lib/domain/invoice-consolidation";
import { billingPeriodFor } from "@/lib/domain/billing-period";
import { describePlacementOutcome, HELD_FOR_MANUAL } from "@/lib/domain/placement";
import type { BillingMethod } from "@/lib/domain/billing";

/**
 * The rules the running draft turns on, with no database in sight.
 *
 * Between them these three answer the whole of "one invoice per customer per
 * period": which draft a job belongs to (`groupJobsForInvoicing` with a period
 * rule), what the draft's lines say once a second job joins (`jobInvoiceLines`),
 * and what the reviewer is told about it (`describePlacementOutcome`).
 *
 * The second is the one worth the most scrutiny. Appending a job **re-derives
 * the whole set of job lines**, so if this function's answer for two jobs were
 * not the answer for one job plus one more, adding a twelfth job to a draft
 * would silently rewrite the first eleven lines.
 */

type Job = GroupableJob & { completed_at: string | null };

function job(id: string, customerId: string, completedAt: string | null): Job {
  return { id, order_number: `LJ${id}`, customer_id: customerId, completed_at: completedAt };
}

const methods = (entries: Record<string, BillingMethod>) =>
  new Map<string, BillingMethod>(Object.entries(entries));

/** The period rule the generator uses, restated here as the caller passes it. */
const periodOf = (j: Job, method: BillingMethod) =>
  method === "invoice_per_job" ? null : billingPeriodFor(method, j.completed_at);

describe("grouping onto a period", () => {
  it("puts one customer's jobs from one month on one invoice", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "acme", "2026-08-03"), job("2", "acme", "2026-08-11"), job("3", "acme", "2026-08-29")],
      methods({ acme: "monthly_consolidated" }),
      periodOf,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.jobs.map((j) => j.id)).toEqual(["1", "2", "3"]);
    expect(groups[0]!.period).toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("splits one customer's jobs across two months", () => {
    // The failure this prevents is a July job and an August job rolled onto one
    // invoice because they happened to be selected together.
    const groups = groupJobsForInvoicing(
      [job("1", "acme", "2026-07-30"), job("2", "acme", "2026-08-01")],
      methods({ acme: "monthly_consolidated" }),
      periodOf,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.period?.start)).toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("never puts two customers on one invoice, same month or not", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "acme", "2026-08-03"), job("2", "beta", "2026-08-04")],
      methods({ acme: "monthly_consolidated", beta: "monthly_consolidated" }),
      periodOf,
    );
    expect(groups).toHaveLength(2);
  });

  it("gives a per-job customer one periodless group per job", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "acme", "2026-08-03"), job("2", "acme", "2026-08-04")],
      methods({ acme: "invoice_per_job" }),
      periodOf,
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.period === null)).toBe(true);
  });

  it("splits a weekly customer by week where a monthly one is not split", () => {
    const jobs = [job("1", "acme", "2026-08-03"), job("2", "acme", "2026-08-11")];
    expect(groupJobsForInvoicing(jobs, methods({ acme: "weekly_consolidated" }), periodOf))
      .toHaveLength(2);
    expect(groupJobsForInvoicing(jobs, methods({ acme: "monthly_consolidated" }), periodOf))
      .toHaveLength(1);
  });

  it("keeps a job with no completion date rather than dropping it", () => {
    // It cannot be given a period, so it joins the customer's periodless group —
    // an invoice somebody has to look at, which beats silently losing the work.
    const groups = groupJobsForInvoicing(
      [job("1", "acme", null)],
      methods({ acme: "monthly_consolidated" }),
      periodOf,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.period).toBeNull();
    expect(groups[0]!.jobs).toHaveLength(1);
  });

  it("behaves exactly as it did before when no period rule is offered", () => {
    // The callers that bill one explicit selection still want the old shape.
    const groups = groupJobsForInvoicing(
      [job("1", "acme", "2026-07-30"), job("2", "acme", "2026-08-01")],
      methods({ acme: "monthly_consolidated" }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.period).toBeNull();
  });
});

/* ------------------------------------------------------------ the lines */

function charge(over: Partial<ConsolidatableCharge> = {}): ConsolidatableCharge {
  return {
    description: "Bath towel",
    charge_type: "wash_only",
    quantity: 100,
    unit_price: 0.22,
    amount: 22,
    taxable: true,
    source_item_id: "item-towel",
    source_agreement_id: null,
    source_laundry_item_type: "bath_towels",
    gl_account_id: null,
    ...over,
  };
}

const entry = (id: string, over: Partial<ConsolidatableCharge> = {}): ChargeEntry => ({
  job: { id, orderNumber: `LJ${id}`, date: "2026-08-03" },
  charge: charge(over),
});

describe("jobInvoiceLines", () => {
  it("merges the same item at the same rate across two jobs into one line", () => {
    // The promise the running draft makes: 100 towels then 50 more is a line of
    // 150, not two lines a customer has to add up themselves.
    const lines = jobInvoiceLines([
      entry("1"),
      entry("2", { quantity: 50, amount: 11 }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(150);
    expect(lines[0]!.amount).toBe(33);
    // No job number on a merged line: naming one of its two jobs would be a lie.
    expect(lines[0]!.description).toBe("Bath towel");
    expect(lines[0]!.jobId).toBeNull();
  });

  it("keeps two jobs' fuel levies apart, each naming its own job", () => {
    // An event is not a quantity. Three deliveries' levies rolled into one line
    // hides which runs were levied.
    const lines = jobInvoiceLines([
      entry("1", {
        description: "Fuel levy", charge_type: "fuel_levy", quantity: 1, unit_price: 4,
        amount: 4, source_item_id: null, source_laundry_item_type: null,
      }),
      entry("2", {
        description: "Fuel levy", charge_type: "fuel_levy", quantity: 1, unit_price: 4,
        amount: 4, source_item_id: null, source_laundry_item_type: null,
      }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.description)).toEqual([
      "LJ1 — Fuel levy", "LJ2 — Fuel levy",
    ]);
  });

  it("keeps a mid-period rate change as two lines at the two real rates", () => {
    const lines = jobInvoiceLines([
      entry("1"),
      entry("2", { unit_price: 0.25, quantity: 100, amount: 25 }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.unit_price)).toEqual([0.22, 0.25]);
  });

  it("keeps two accounts apart, so the whole amount cannot post to one of them", () => {
    const lines = jobInvoiceLines([
      entry("1", { gl_account_id: "acct-a" }),
      entry("2", { gl_account_id: "acct-b" }),
    ]);
    expect(lines).toHaveLength(2);
  });

  it("is stable under append: one job then two gives the same first line as two at once", () => {
    // The property that makes `rebuildJobLines` safe. If re-deriving from two
    // jobs produced a different shape from deriving from one and adding, then
    // adding a twelfth job would silently rewrite the first eleven lines.
    const both = jobInvoiceLines([entry("1"), entry("2", { quantity: 50, amount: 11 })]);
    const oneAtATime = jobInvoiceLines([entry("1")]);
    expect(oneAtATime[0]!.source_item_id).toBe(both[0]!.source_item_id);
    expect(oneAtATime[0]!.unit_price).toBe(both[0]!.unit_price);
    // Only the totals move, and only upward by the second job's own numbers.
    expect(both[0]!.quantity - oneAtATime[0]!.quantity).toBe(50);
    expect(both[0]!.amount - oneAtATime[0]!.amount).toBe(11);
  });

  it("sums amounts rather than recomputing them", () => {
    // The cent is the point: the invoice total has to equal the frozen charges
    // exactly, or the customer's invoice and the audit trail behind it disagree.
    const lines = jobInvoiceLines([
      entry("1", { quantity: 3, unit_price: 0.335, amount: 1.01 }),
      entry("2", { quantity: 3, unit_price: 0.335, amount: 1.01 }),
    ]);
    expect(lines[0]!.amount).toBe(2.02);
  });

  it("names every job on a per-job invoice and merges nothing", () => {
    const lines = jobInvoiceLines(
      [entry("1"), entry("2", { quantity: 50, amount: 11 })],
      { perJob: true },
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.jobId)).toEqual(["1", "2"]);
    // No prefix either: a per-job invoice bills one job and saying so on every
    // line would be noise.
    expect(lines[0]!.description).toBe("Bath towel");
  });

  it("prefixes a single job's un-merged line so a levy says which delivery", () => {
    const lines = jobInvoiceLines([entry("1")]);
    expect(lines[0]!.description).toBe("LJ1 — Bath towel");
    expect(lines[0]!.jobId).toBe("1");
  });
});

/* ------------------------------------------------------- what is said back */

describe("describePlacementOutcome", () => {
  it("says raised the first time and added-to afterwards", () => {
    const base = { kind: "placed" as const, invoiceId: "i", invoiceNumber: "INV00042", total: 22 };
    expect(describePlacementOutcome({ ...base, opened: true, period: "August 2026" }))
      .toBe(" Draft invoice INV00042 raised for August 2026.");
    expect(describePlacementOutcome({ ...base, opened: false, period: "August 2026" }))
      .toBe(" Added to draft invoice INV00042 for August 2026.");
  });

  it("leaves the period out when there is none", () => {
    expect(describePlacementOutcome({
      kind: "placed", invoiceId: "i", invoiceNumber: "INV00042",
      opened: true, total: 22, period: null,
    })).toBe(" Draft invoice INV00042 raised.");
  });

  it("says why a manual customer's job was held rather than reporting a failure", () => {
    expect(describePlacementOutcome({ kind: "held", reason: HELD_FOR_MANUAL }))
      .toContain("billed manually");
  });

  it("says the job is not on an invoice when the placement failed", () => {
    expect(describePlacementOutcome({ kind: "failed", reason: "already on another invoice." }))
      .toBe(" It is not on an invoice yet — already on another invoice.");
  });
});
