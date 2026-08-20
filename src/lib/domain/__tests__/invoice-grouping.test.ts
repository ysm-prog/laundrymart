import { describe, expect, it } from "vitest";
import { groupJobsForInvoicing, type GroupableJob } from "@/lib/domain/invoice-grouping";
import type { BillingMethod } from "@/lib/domain/billing";

/**
 * The grouping rule — the architectural decision of phase 7, on its own.
 *
 * "Should August be fifteen invoices or one?" is answered here and nowhere else,
 * from one column on the customer. Keeping the rule pure is what makes that
 * claim checkable: no database, no fixtures, and the two shapes asserted against
 * the same input.
 */

function job(id: string, customerId: string): GroupableJob {
  return {
    id,
    order_number: `LJ${id}`,
    customer_id: customerId,
  };
}

const methods = (entries: Record<string, BillingMethod>) =>
  new Map<string, BillingMethod>(Object.entries(entries));

describe("groupJobsForInvoicing", () => {
  it("gives a per-job customer one invoice per job", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "cust-a"), job("2", "cust-a"), job("3", "cust-a")],
      methods({ "cust-a": "invoice_per_job" }),
    );
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.jobs.length === 1)).toBe(true);
  });

  it("rolls a consolidated customer's jobs onto one invoice", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "cust-a"), job("2", "cust-a"), job("3", "cust-a")],
      methods({ "cust-a": "monthly_consolidated" }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.jobs.map((j) => j.id)).toEqual(["1", "2", "3"]);
  });

  it("treats every consolidation period the same way at grouping time", () => {
    // Weekly, fortnightly and monthly differ in *when* a run happens, not in
    // what one produces. The period is the caller's filter; this is the shape.
    for (const method of ["weekly_consolidated", "fortnightly_consolidated", "monthly_consolidated"] as const) {
      const groups = groupJobsForInvoicing(
        [job("1", "cust-a"), job("2", "cust-a")],
        methods({ "cust-a": method }),
      );
      expect(groups).toHaveLength(1);
    }
  });

  it("never mixes two customers onto one invoice", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "cust-a"), job("2", "cust-b"), job("3", "cust-a")],
      methods({ "cust-a": "monthly_consolidated", "cust-b": "monthly_consolidated" }),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.customerId).sort()).toEqual(["cust-a", "cust-b"]);
  });

  it("handles a mixed selection of both kinds of customer at once", () => {
    const groups = groupJobsForInvoicing(
      [job("1", "per"), job("2", "per"), job("3", "roll"), job("4", "roll")],
      methods({ per: "invoice_per_job", roll: "monthly_consolidated" }),
    );
    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.customerId === "per")).toHaveLength(2);
    expect(groups.filter((g) => g.customerId === "roll")[0]?.jobs).toHaveLength(2);
  });

  it("consolidates a customer whose method is unknown rather than splitting them", () => {
    // A customer missing from the map is a data gap, and the safe reading of a
    // gap is one invoice — the mistake it avoids (a surprise invoice per job) is
    // the one the customer actually notices.
    const groups = groupJobsForInvoicing(
      [job("1", "cust-a"), job("2", "cust-a")],
      methods({}),
    );
    expect(groups).toHaveLength(1);
  });

  it("consolidates `manual` if it ever reaches here", () => {
    // The callers filter `manual` out of a scheduled run. If a hand-picked
    // selection includes one, the same reasoning as above applies.
    const groups = groupJobsForInvoicing(
      [job("1", "cust-a"), job("2", "cust-a")],
      methods({ "cust-a": "manual" }),
    );
    expect(groups).toHaveLength(1);
  });

  it("groups nothing when given nothing", () => {
    expect(groupJobsForInvoicing([], methods({}))).toEqual([]);
  });

  it("keeps the jobs in the order they arrived", () => {
    // The invoice's line order follows this, and a customer reading a
    // consolidated invoice should see their jobs in a stable order.
    const groups = groupJobsForInvoicing(
      [job("3", "c"), job("1", "c"), job("2", "c")],
      methods({ c: "weekly_consolidated" }),
    );
    expect(groups[0]?.jobs.map((j) => j.id)).toEqual(["3", "1", "2"]);
  });
});
