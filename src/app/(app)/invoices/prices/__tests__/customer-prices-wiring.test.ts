import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unitField, PRESENT_FIELD } from "../price-form";

/**
 * "Change charge by customer is not working", end to end, at the seams a unit
 * test can reach. The save action and the picker read reach `lib/env` and the
 * Supabase client, so what is asserted here is their source — the pattern
 * `one-door.test.ts` uses — and the pure half is in `laundry-prices.test.ts`.
 */

const src = join(__dirname, "../../../../..");
const read = (file: string) => readFileSync(join(src, file), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the customer price list, from form to pricer", () => {
  it("posts the field names the parser reads", () => {
    const table = code(read("app/(app)/invoices/prices/item-price-table.tsx"));
    expect(table).toMatch(/name=\{PRESENT_FIELD\}/);
    expect(table).toMatch(/unitField\(item\.id\)/);
    expect(table).toMatch(/name="customer_id"/);
    expect(PRESENT_FIELD).toBe("present");
    expect(unitField("x")).toBe("unit_x");
  });

  it("checks the posted customer belongs to this laundry before writing", () => {
    const action = code(read("app/(app)/invoices/prices/actions.ts"));
    expect(action).toMatch(
      /from\("customers"\)[\s\S]{0,80}\.eq\("tenant_id", session\.tenantId\)[\s\S]{0,40}\.eq\("id", customerId\)/,
    );
  });

  it("hands pickers the effective rate, not the customer's own row alone", () => {
    // The defect: `list_price: price` dropped the usual price for every customer
    // without an override, so a re-rate never reached their charges.
    const pickers = code(read("lib/items/list-prices.ts"));
    expect(pickers).toMatch(/list_price: effectiveListPrice\(row\)/);
    expect(pickers).not.toMatch(/list_price: price\b/);
  });

  it("prices a job from the customer's rows and the usual list together", () => {
    const pricer = code(read("lib/orders/job-billing.ts"));
    expect(pricer).toMatch(/itemPriceListFor\(job\.customer_id/);
  });
});
