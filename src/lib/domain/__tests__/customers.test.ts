import { describe, expect, it } from "vitest";
import { customerStatusNeedsSaying, isPickableCustomer } from "../customers";

/**
 * The five values `customers_status_check` allows. Written out rather than
 * imported so this file is a statement of the vocabulary the rules are meant to
 * cover, not a restatement of whatever they happen to handle.
 */
const STATUSES = ["prospect", "active", "on_hold", "inactive", "archived"] as const;

describe("isPickableCustomer", () => {
  it("offers everyone the laundry still has a relationship with", () => {
    // The defect this replaced was an allow-list of three, which hid `inactive`
    // — 508 of this laundry's 511 customers on the day its import landed.
    for (const status of ["prospect", "active", "on_hold", "inactive"]) {
      expect(isPickableCustomer(status), `${status} must be pickable`).toBe(true);
    }
  });

  it("leaves out only the archived, which are soft-deleted anyway", () => {
    expect(isPickableCustomer("archived")).toBe(false);
  });

  it("covers every status the database allows", () => {
    // Non-vacuous: if a sixth status is ever added, this fails rather than
    // silently defaulting it into the picker.
    expect(STATUSES.filter(isPickableCustomer)).toEqual(
      ["prospect", "active", "on_hold", "inactive"],
    );
  });
});

describe("customerStatusNeedsSaying", () => {
  it("says nothing about an ordinary trading customer", () => {
    expect(customerStatusNeedsSaying("active")).toBe(false);
  });

  it("marks the three a counter hand should see before taking laundry in", () => {
    expect(customerStatusNeedsSaying("on_hold")).toBe(true);
    expect(customerStatusNeedsSaying("inactive")).toBe(true);
    expect(customerStatusNeedsSaying("prospect")).toBe(true);
  });

  it("never marks a customer it would not offer in the first place", () => {
    // A badge on a row nobody can reach is a promise the picker cannot keep.
    expect(customerStatusNeedsSaying("archived")).toBe(false);
  });
});

import { billingAddressFromSite } from "../customers";
describe("billingAddressFromSite", () => {
  it("copies the site address when no billing address was given", () => {
    const customer: { business_name: string; billing_address_line1?: string | null } = { business_name: "ZZ" };
    expect(billingAddressFromSite(customer, "1 Mill Rd, Adelaide"))
      .toEqual({ business_name: "ZZ", billing_address_line1: "1 Mill Rd, Adelaide" });
  });
  it("keeps a billing address that was given, and does nothing with no site", () => {
    expect(billingAddressFromSite({ billing_address_line1: "PO Box 1" }, "1 Mill Rd").billing_address_line1).toBe("PO Box 1");
    expect(billingAddressFromSite({ billing_address_line1: null }, "  ").billing_address_line1).toBeNull();
  });
});
