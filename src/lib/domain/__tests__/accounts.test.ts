import { describe, expect, it } from "vitest";
import {
  accountLabel, accountMatches, isPostableAccount, isRevenueAccount,
  searchAccounts, taxableFromTaxCode, uncodedLineCount, type PickableAccount,
} from "@/lib/domain/accounts";

/**
 * The fixtures are real rows from the client's own chart of accounts, codes and
 * tax codes included. That matters more than it usually would: the two traps
 * these rules exist to avoid — "Vehicle Sale" appearing twice on opposite sides
 * of the books, and `5-1000 Towel Purchases` answering a question asked on a
 * sales invoice — are both properties of *this* chart, not invented cases.
 */
const HEADING: PickableAccount =
  { id: "h1", code: "0-INCOME", name: "Income", account_type: "Income", tax_code: null, is_header: true };
const TOWEL_SALES: PickableAccount =
  { id: "a1", code: "4-1000", name: "Sales of Towels", account_type: "Income", tax_code: "GST" };
const TOWELS_BLACK: PickableAccount =
  { id: "a2", code: "4-1100", name: "Towels - Black", account_type: "Income", tax_code: "GST" };
const TOWELS_WHITE: PickableAccount =
  { id: "a3", code: "4-1150", name: "Towels - White", account_type: "Income", tax_code: "N-T" };
const TEA_TOWELS: PickableAccount =
  { id: "a4", code: "4-1400", name: "Tea Towels", account_type: "Income", tax_code: "GST" };
const DELIVERY_FEES: PickableAccount =
  { id: "a5", code: "4-2000", name: "Delivery Fees Collected", account_type: "Income", tax_code: "GST" };
const VEHICLE_SALE_INCOME: PickableAccount =
  { id: "a6", code: "4-5000", name: "Vehicle sale", account_type: "Income", tax_code: "GST" };
const TOWEL_PURCHASES: PickableAccount =
  { id: "a7", code: "5-1000", name: "Towel Purchases", account_type: "Cost of sales", tax_code: "GST" };
const WATER: PickableAccount =
  { id: "a8", code: "6-2630", name: "Water", account_type: "Expense", tax_code: "FRE" };
const VEHICLE_SALE_OTHER: PickableAccount =
  { id: "a9", code: "8-1000", name: "Vehicle Sale", account_type: "Other income", tax_code: "N-T" };

const CHART: PickableAccount[] = [
  HEADING, TOWEL_SALES, TOWELS_BLACK, TOWELS_WHITE, TEA_TOWELS, DELIVERY_FEES,
  VEHICLE_SALE_INCOME, TOWEL_PURCHASES, WATER, VEHICLE_SALE_OTHER,
];

const byCode = (accounts: PickableAccount[]) => accounts.map((a) => a.code);

describe("accountLabel", () => {
  it("leads with the code, because two accounts can share a name", () => {
    expect(accountLabel({ code: "4-1100", name: "Towels - Black" }))
      .toBe("4-1100 — Towels - Black");
    // This chart really does carry "Vehicle sale" twice. Only the code tells them apart.
    expect(accountLabel(VEHICLE_SALE_INCOME)).not.toBe(accountLabel(VEHICLE_SALE_OTHER));
  });
});

describe("isPostableAccount / isRevenueAccount", () => {
  it("refuses the classification headings, which carry a synthetic code", () => {
    expect(isPostableAccount(HEADING)).toBe(false);
    expect(isRevenueAccount(HEADING)).toBe(false);
  });

  it("treats a row with no is_header flag as postable", () => {
    // The picker is fed a `select` that may not carry the column; absent must
    // not mean "heading", or nothing would be postable at all.
    expect(isPostableAccount({ id: "x", code: "4-1", name: "n", account_type: "Income" })).toBe(true);
  });

  it("counts both trading and other income as somewhere a sale can land", () => {
    expect(isRevenueAccount(TOWEL_SALES)).toBe(true);   // 4-1000 Income
    expect(isRevenueAccount(VEHICLE_SALE_OTHER)).toBe(true);   // 8-1000 Other income
  });

  it("does not count the other side of the books as revenue", () => {
    expect(isRevenueAccount(TOWEL_PURCHASES)).toBe(false);  // 5-1000 Cost of sales
    expect(isRevenueAccount(WATER)).toBe(false);  // 6-2630 Expense
  });
});

describe("accountMatches", () => {
  it("matches on code and on name", () => {
    expect(accountMatches(TOWELS_BLACK, "4-11")).toBe(true);
    expect(accountMatches(TOWELS_BLACK, "black")).toBe(true);
    expect(accountMatches(TOWELS_BLACK, "sheets")).toBe(false);
  });

  it("matches everything on a blank query, so the picker opens full", () => {
    expect(accountMatches(TOWELS_BLACK, "")).toBe(true);
    expect(accountMatches(TOWELS_BLACK, "   ")).toBe(true);
  });
});

describe("searchAccounts", () => {
  it("never offers a heading", () => {
    expect(byCode(searchAccounts(CHART, ""))).not.toContain("0-INCOME");
    expect(byCode(searchAccounts(CHART, "income"))).not.toContain("0-INCOME");
  });

  it("expands a code prefix into the accounts under it, in the caller's order", () => {
    expect(byCode(searchAccounts(CHART, "4-1")))
      .toEqual(["4-1000", "4-1100", "4-1150", "4-1400"]);
  });

  it("puts an exact code first", () => {
    expect(byCode(searchAccounts(CHART, "4-1150"))[0]).toBe("4-1150");
  });

  it("answers a sales question with the sales account, not the purchase one", () => {
    // The trap: `5-1000 Towel Purchases` matches "towel" just as well as
    // `4-1000 Sales of Towels`, and is the wrong side of the books for an invoice.
    const found = byCode(searchAccounts(CHART, "towel"));
    expect(found).toContain("5-1000");
    expect(found.indexOf("4-1000")).toBeLessThan(found.indexOf("5-1000"));
  });

  it("still puts an exact code first, whichever side of the books it is on", () => {
    // The escape hatch has to stay open: a bookkeeper offsetting a recharge
    // types the code in full and must get it, not a shortlist of sales accounts.
    expect(byCode(searchAccounts(CHART, "5-1000"))[0]).toBe("5-1000");
    expect(byCode(searchAccounts(CHART, "6-2630"))[0]).toBe("6-2630");
  });

  it("still finds an expense account by name, just after the revenue matches", () => {
    expect(byCode(searchAccounts(CHART, "water"))).toEqual(["6-2630"]);
  });

  it("ranks a name match below a code match", () => {
    const found = byCode(searchAccounts(CHART, "1000"));
    expect(found[0]).toBe("4-1000");
  });

  it("honours the limit and does not reshuffle as a prefix grows", () => {
    expect(searchAccounts(CHART, "4-1", 2)).toHaveLength(2);
    expect(byCode(searchAccounts(CHART, "4-1", 2))).toEqual(["4-1000", "4-1100"]);
  });

  it("is case- and space-insensitive", () => {
    expect(byCode(searchAccounts(CHART, "  DELIVERY  "))).toEqual(["4-2000"]);
  });
});

describe("taxableFromTaxCode", () => {
  it("reads the bookkeeper's own vocabulary", () => {
    expect(taxableFromTaxCode("GST")).toBe(true);
    expect(taxableFromTaxCode("FRE")).toBe(false);
    expect(taxableFromTaxCode("N-T")).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(taxableFromTaxCode(" gst ")).toBe(true);
    expect(taxableFromTaxCode("n-t")).toBe(false);
  });

  it("has no opinion about a code it does not know, rather than guessing", () => {
    // 0021 left `tax_code` unchecked on purpose so a bookkeeper can add one.
    // Guessing true over-charges GST; guessing false under-collects it.
    expect(taxableFromTaxCode("CAP")).toBeNull();
    expect(taxableFromTaxCode("EXP")).toBeNull();
    expect(taxableFromTaxCode(null)).toBeNull();
    expect(taxableFromTaxCode(undefined)).toBeNull();
    expect(taxableFromTaxCode("   ")).toBeNull();
  });
});

describe("uncodedLineCount", () => {
  it("counts the lines that will reach the books with no account on them", () => {
    expect(uncodedLineCount([
      { account_code: "4-1100" },
      { account_code: null },
      { account_code: "  " },
      {},
    ])).toBe(3);
  });

  it("is zero for a fully coded invoice", () => {
    expect(uncodedLineCount([{ account_code: "4-1100" }, { account_code: "4-2000" }])).toBe(0);
  });
});
