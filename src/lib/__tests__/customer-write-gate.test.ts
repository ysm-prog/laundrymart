import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES, can, rolesWith } from "@/lib/roles";

/**
 * `0048`'s two gates say the same thing as `roles.ts`, and keep saying it.
 *
 * The migration hard-codes two role arrays into `can_read_customers()` and
 * `can_write_customers()`, because a policy cannot import TypeScript. That is
 * the seam: `roles.ts` decides what a *screen* offers and the policy decides
 * what the *database* accepts, and when they drift the failure is silent in the
 * worse direction — a role keeps its Edit button and its save writes **zero
 * rows with no error**, which is the outcome this repo has shipped twice.
 *
 * So the arrays are read back out of the migration and compared. `platform_admin`
 * is deliberately absent from both: it is not a membership role and reaches every
 * laundry through `has_role`'s own `or is_platform_admin()` (0019), so naming it
 * in the array would be a second, weaker answer to a question that helper already
 * settles.
 */

const MIGRATION = join(__dirname, "..", "..", "..", "supabase", "migrations",
                       "0048_customer_record_write.sql");

/** The role list inside one `has_role(t, array[...])` call. */
function rolesInGate(sql: string, fn: string): string[] {
  const body = new RegExp(
    `create or replace function public\\.${fn}\\(t uuid\\)[\\s\\S]*?array\\[([^\\]]*)\\]`,
  ).exec(sql);
  expect(body, `${fn} was not found in the migration`).not.toBeNull();
  return [...body![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

const sql = readFileSync(MIGRATION, "utf8");
const membershipHolders = (capability: Parameters<typeof rolesWith>[0]) =>
  rolesWith(capability).filter((role) => role !== "platform_admin").sort();

describe("the database's customer gates match roles.ts", () => {
  it("found the migration and both gates", () => {
    // Non-vacuous: an empty read would satisfy every assertion below.
    expect(sql).toContain("can_write_customers");
    expect(rolesInGate(sql, "can_write_customers").length).toBeGreaterThan(0);
  });

  it("gates the write on exactly the customers.write holders", () => {
    expect(rolesInGate(sql, "can_write_customers")).toEqual(membershipHolders("customers.write"));
  });

  it("gates the contacts read on exactly the customers.read holders", () => {
    expect(rolesInGate(sql, "can_read_customers")).toEqual(membershipHolders("customers.read"));
  });

  it("keeps a round out of the write, which is what 0048 is for", () => {
    // Named rather than derived, because these five are the point: before 0048 a
    // board could rename a customer, rewrite the access notes that say which
    // door to use, and delete a site.
    for (const role of ["driver", "board", "warehouse_operator", "finance", "auditor"] as const) {
      expect(can(role, "customers.write"), `${role} should not write a customer record`).toBe(false);
    }
  });

  it("leaves the read a round needs alone", () => {
    // The other half, and the one that breaks a screen if it is got wrong: a
    // board and a driver read the name, the phone, the standing instructions,
    // the address and the access notes off their own run sheet. Neither holds
    // `customers.read`, which is why those two tables keep an `is_member` read.
    for (const role of ["driver", "board"] as const) {
      expect(can(role, "customers.read")).toBe(false);
    }
    expect(sql).toMatch(
      /create policy customers_read[\s\S]{0,120}using \(\(select public\.is_member\(tenant_id\)\)/);
    expect(sql).toMatch(
      /create policy customer_locations_read[\s\S]{0,120}using \(\(select public\.is_member\(tenant_id\)\)/);
  });
});

describe("every writer that reaches customers is inside that gate", () => {
  it("covers the billing card and the Xero contact write", () => {
    // Two writers arrive by a door other than the customer form:
    // `updateCustomerBilling` is `billing.write`, and the Xero push writes
    // `customers.xero_contact_id` on the **caller's own client** under
    // `invoices.write`. If either set ever leaves `customers.write` behind, that
    // push stops remembering the contact by writing zero rows in silence — and
    // the next invoice for that customer makes a twin in Xero.
    for (const role of ROLES) {
      if (can(role, "billing.write") || can(role, "invoices.write")) {
        expect(can(role, "customers.write"),
               `${role} writes a customer record by another door but cannot write one`).toBe(true);
      }
    }
  });
});
