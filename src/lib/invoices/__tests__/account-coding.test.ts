import { describe, expect, it } from "vitest";
import { accountForLine } from "@/lib/invoices/account-coding";

/**
 * `incomeAccountsForItems` is a query and is not tested here; `accountForLine`
 * is the rule, and it is the one both invoice writers call. Small, and worth
 * pinning: this is where the fallback order is stated, and getting it wrong is
 * silent — a line simply comes out uncoded, which looks exactly like a line
 * somebody chose not to code.
 */
describe("accountForLine", () => {
  const coded = new Map([["item-1", "acct-1"], ["item-2", "acct-2"]]);

  it("codes a line to its item's income account", () => {
    expect(accountForLine("item-1", coded)).toBe("acct-1");
    expect(accountForLine("item-2", coded)).toBe("acct-2");
  });

  it("leaves a line uncoded when the item has no account", () => {
    // Absent from the map is how `incomeAccountsForItems` reports "this item
    // names no account" — it filters those out rather than returning nulls.
    expect(accountForLine("item-3", coded)).toBeNull();
  });

  it("leaves a line with no item uncoded", () => {
    // Fuel levies, minimums, surcharges and every rolled-up line that spans
    // more than one item. Honestly uncoded and counted on the invoice, rather
    // than guessed at from the charge type.
    expect(accountForLine(null, coded)).toBeNull();
    expect(accountForLine(undefined, coded)).toBeNull();
  });

  it("returns null rather than an empty string for an empty item id", () => {
    // `""` would be written into a uuid column and fail the insert, so the
    // falsy case has to collapse to null and not to the id it was given.
    expect(accountForLine("", coded)).toBeNull();
  });

  it("is null when nothing is coded at all", () => {
    expect(accountForLine("item-1", new Map())).toBeNull();
  });
});
