import { describe, expect, it } from "vitest";
import {
  accountField, parseChargeAccountForm,
} from "@/app/(app)/invoices/charge-accounts/charge-account-form";
import { CHARGE_TYPES } from "@/lib/domain/pricing";

const ACCOUNT = "067bf3f8-03c7-4078-b2f6-69bff6c1d240";
const OTHER = "475bbd95-e2b6-4935-b9ef-3630befd6892";

/** The shape the screen really posts: every charge type, every time. */
function posted(values: Partial<Record<string, string>>): FormData {
  const form = new FormData();
  for (const chargeType of CHARGE_TYPES) {
    form.set(accountField(chargeType), values[chargeType] ?? "");
  }
  return form;
}

describe("parseChargeAccountForm", () => {
  it("reads an account per kind of charge", () => {
    const parsed = parseChargeAccountForm(posted({ fuel_levy: ACCOUNT, wash_only: OTHER }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([
      { chargeType: "wash_only", accountId: OTHER },
      { chargeType: "fuel_levy", accountId: ACCOUNT },
    ]);
  });

  it("reads a blank as cleared, not as an unreadable value", () => {
    const parsed = parseChargeAccountForm(posted({ fuel_levy: ACCOUNT }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Eleven cleared, one set — the ordinary state of this screen.
    expect(parsed.cleared).toHaveLength(CHARGE_TYPES.length - 1);
    expect(parsed.cleared).not.toContain("fuel_levy");
  });

  it("leaves a charge type the form did not post alone", () => {
    // A release adding a thirteenth kind of charge must not let an older cached
    // page wipe the defaults for the ones it has never heard of.
    const form = new FormData();
    form.set(accountField("fuel_levy"), ACCOUNT);
    const parsed = parseChargeAccountForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([{ chargeType: "fuel_levy", accountId: ACCOUNT }]);
    expect(parsed.cleared).toEqual([]);
  });

  it("refuses something that is not an id rather than passing it to the database", () => {
    const parsed = parseChargeAccountForm(posted({ fuel_levy: "4-2000" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("fuel_levy");
  });

  it("ignores a field for something that is not a kind of charge", () => {
    // The loop is driven by `CHARGE_TYPES`, not by what arrived, so a posted
    // `account_rent_arrears` reaches no query at all.
    const form = posted({ fuel_levy: ACCOUNT });
    form.set("account_rent_arrears", OTHER);
    const parsed = parseChargeAccountForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([{ chargeType: "fuel_levy", accountId: ACCOUNT }]);
  });

  it("trims, because a pasted id arrives with whitespace", () => {
    const parsed = parseChargeAccountForm(posted({ fuel_levy: `  ${ACCOUNT}  ` }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([{ chargeType: "fuel_levy", accountId: ACCOUNT }]);
  });
});
