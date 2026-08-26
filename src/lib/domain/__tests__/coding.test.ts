import { describe, expect, it } from "vitest";
import { codingOffer } from "../coding";

/**
 * Driven off the requirement — "never offer a route with nothing behind it" —
 * rather than off the implementation, so a label that starts promising a list
 * the laundry does not hold fails here rather than on somebody's screen.
 *
 * The two live shapes are asserted by name because they are what this exists
 * for: the demo laundry holds items and no chart, and the real one held a
 * chart and no items until its item master arrived.
 */
describe("codingOffer", () => {
  it("offers both when the laundry holds both", () => {
    const offer = codingOffer({ items: 254, accounts: 261 });
    expect(offer.offered).toBe(true);
    expect(offer.label).toBe("Add item or code");
    expect(offer.uncoded).toMatch(/^Not coded/);
  });

  it("never promises a code to a laundry with no chart of accounts", () => {
    // Harbour Commercial Laundry: 6 items, 0 accounts.
    const offer = codingOffer({ items: 6, accounts: 0 });
    expect(offer.offered).toBe(true);
    expect(offer.label).toBe("Add an item");
    expect(offer.label).not.toMatch(/code/i);
    expect(offer.uncoded).toMatch(/no chart of accounts/i);
  });

  it("never promises an item to a laundry with no item list", () => {
    // Adelaide Towel Service, before its item master arrived: 268 accounts, 0 items.
    const offer = codingOffer({ items: 0, accounts: 261 });
    expect(offer.offered).toBe(true);
    expect(offer.label).toBe("Add a code");
    expect(offer.label).not.toMatch(/item/i);
    expect(offer.uncoded).toMatch(/no items/i);
  });

  it("offers nothing at all when neither list exists", () => {
    const offer = codingOffer({ items: 0, accounts: 0 });
    expect(offer.offered).toBe(false);
    expect(offer.label).toBe("");
    expect(offer.uncoded).toMatch(/no item list and no chart/i);
  });

  it("says why rather than blaming the operator, wherever a list is missing", () => {
    // The sentence a laundry cannot act on from the charges screen must name the
    // missing list. Only the both-present case reports the bare consequence.
    for (const counts of [{ items: 6, accounts: 0 }, { items: 0, accounts: 3 }, { items: 0, accounts: 0 }]) {
      expect(codingOffer(counts).uncoded).not.toMatch(/^Not coded/);
    }
    expect(codingOffer({ items: 1, accounts: 1 }).uncoded).toMatch(/^Not coded/);
  });

  it("treats one of a list as a list", () => {
    expect(codingOffer({ items: 1, accounts: 1 }).label).toBe("Add item or code");
  });
});
