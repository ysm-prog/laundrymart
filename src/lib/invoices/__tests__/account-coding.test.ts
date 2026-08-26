import { describe, expect, it } from "vitest";
import {
  NO_ACCOUNTS, resolveChargeAccount, type AccountLookups,
} from "@/lib/invoices/account-coding";

/**
 * `incomeAccountsForItems`, `chargeTypeAccounts` and `accountLookupsFor` are
 * queries and are not tested here; `resolveChargeAccount` is the rule, and the
 * rule is the part that can be wrong in a way a green build hides — an invoice
 * coded to the wrong account looks exactly like one coded to the right one until
 * somebody reconciles it.
 */
function lookups(
  items: Record<string, string> = {}, charges: Record<string, string> = {},
): AccountLookups {
  return {
    accountByItem: new Map(Object.entries(items)),
    defaultByChargeType: new Map(Object.entries(charges)),
  };
}

describe("resolveChargeAccount", () => {
  it("prefers the charge's own account over everything below it", () => {
    // The tier order is the whole function. Resolving the item ahead of the
    // charge would quietly send a different account from the one somebody
    // deliberately picked on the Charges card, and nobody would find out until a
    // bookkeeper reconciled — so this is asserted first and asserted hardest.
    const found = resolveChargeAccount(
      { gl_account_id: "chosen", source_item_id: "towel", charge_type: "wash_only" },
      lookups({ towel: "via-item" }, { wash_only: "via-type" }),
    );
    expect(found).toBe("chosen");
  });

  it("falls to the item's income account when the charge names none", () => {
    const found = resolveChargeAccount(
      { gl_account_id: null, source_item_id: "towel", charge_type: "wash_only" },
      lookups({ towel: "via-item" }, { wash_only: "via-type" }),
    );
    expect(found).toBe("via-item");
  });

  it("falls to the charge type's default for a line that names no item", () => {
    // The case the whole third tier exists for: `LJ00007 — fuel` reached the
    // invoice with a code of "—" because a fuel levy names no item, so it had no
    // first tier and no second and there was nowhere to give it one.
    const found = resolveChargeAccount(
      { gl_account_id: null, source_item_id: null, charge_type: "fuel_levy" },
      lookups({}, { fuel_levy: "4-2000" }),
    );
    expect(found).toBe("4-2000");
  });

  it("uses the charge type when the item exists but names no account", () => {
    // An item that has never been coded is *absent* from the map, not present
    // with a null — so a tier that tested `has()` rather than the value would
    // stop here and return nothing.
    const found = resolveChargeAccount(
      { gl_account_id: null, source_item_id: "uncoded-item", charge_type: "fuel_levy" },
      lookups({ towel: "via-item" }, { fuel_levy: "4-2000" }),
    );
    expect(found).toBe("4-2000");
  });

  it("comes back null when no tier can answer", () => {
    // Honestly uncoded, counted on the invoice screen, never guessed at.
    expect(resolveChargeAccount(
      { gl_account_id: null, source_item_id: "towel", charge_type: "other" },
      lookups({}, { fuel_levy: "4-2000" }),
    )).toBeNull();
    expect(resolveChargeAccount({ charge_type: "fuel_levy" }, NO_ACCOUNTS)).toBeNull();
  });

  it("treats an empty string as absent rather than as an answer", () => {
    // A control posting "" for "none" must not code a line to nothing-in-
    // particular — `optionalUuid` maps it away, but this is the last line of
    // defence and it is one character of difference.
    expect(resolveChargeAccount(
      { gl_account_id: "", source_item_id: "towel", charge_type: "fuel_levy" },
      lookups({ towel: "via-item" }),
    )).toBe("via-item");
    expect(resolveChargeAccount(
      { gl_account_id: "", source_item_id: "", charge_type: "" },
      lookups({}, { fuel_levy: "4-2000" }),
    )).toBeNull();
  });

  it("does not invent an account for a charge type nobody has mapped", () => {
    expect(resolveChargeAccount(
      { charge_type: "weekend_surcharge" }, lookups({}, { fuel_levy: "4-2000" }),
    )).toBeNull();
  });

  it("reads a missing charge type as no answer rather than throwing", () => {
    // Every writer passes one, but a `Map.get(undefined)` would be a runtime
    // fault in the middle of a month-end run rather than an uncoded line.
    expect(resolveChargeAccount(
      { gl_account_id: null, source_item_id: null }, lookups({}, { fuel_levy: "4-2000" }),
    )).toBeNull();
  });
});
