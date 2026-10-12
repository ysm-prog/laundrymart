import { describe, expect, it } from "vitest";
import { agingBucket, summariseReceivables, type ReceivableInvoice } from "../receivables";

const inv = (over: Partial<ReceivableInvoice>): ReceivableInvoice => ({
  id: "i", invoice_number: "INV", invoice_type: "consolidated", due_date: "2026-10-01",
  balance: 10, customer: "A", ...over,
});

describe("agingBucket", () => {
  it("buckets by days past due as at a date", () => {
    expect(agingBucket("2026-10-12", "2026-10-12")).toBe("current");
    expect(agingBucket(null, "2026-10-12")).toBe("current");
    expect(agingBucket("2026-10-11", "2026-10-12")).toBe("1-30");
    expect(agingBucket("2026-09-12", "2026-10-12")).toBe("1-30");
    expect(agingBucket("2026-09-11", "2026-10-12")).toBe("31-60");
    expect(agingBucket("2026-07-14", "2026-10-12")).toBe("61-90");
    expect(agingBucket("2011-03-01", "2026-10-12")).toBe("90+");
  });
});

describe("summariseReceivables", () => {
  const rows = [
    inv({ id: "1", customer: "Small Co", balance: 0.04, due_date: "2011-01-01" }),
    inv({ id: "2", customer: "Big Co", balance: 500, due_date: "2026-10-20" }),
    inv({ id: "3", customer: "Big Co", balance: 250, due_date: "2026-06-01" }),
    inv({ id: "4", customer: "Mid Co", balance: 300, due_date: "2026-09-30" }),
    inv({ id: "5", customer: "Credit Co", balance: 80, invoice_type: "credit" }),
  ];
  const result = summariseReceivables(rows, "2026-10-12", { includeSmall: false });

  it("leads with the largest balance, by customer, not the cents", () => {
    expect(result.customers.map((c) => [c.customer, c.total])).toEqual([["Big Co", 750], ["Mid Co", 300]]);
  });
  it("totals what is owed and ages it", () => {
    expect(result.total).toBe(1050);
    expect(result.totals).toEqual({ current: 500, "1-30": 300, "31-60": 0, "61-90": 0, "90+": 250 });
  });
  it("excludes credits and holds back balances under $1, saying how many", () => {
    expect(result.invoiceCount).toBe(3);
    expect(result.hiddenSmall).toBe(1);
    expect(summariseReceivables(rows, "2026-10-12", { includeSmall: true }).customers).toHaveLength(3);
  });
});
