import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES, can, rolesWith } from "@/lib/roles";

/**
 * `0049`'s three gates say the same thing as `roles.ts`, and keep saying it.
 *
 * The migration hard-codes three role arrays into `can_read_fleet()`,
 * `can_write_fleet()` and `can_write_depots()`, because a policy cannot import
 * TypeScript. That is the seam: `roles.ts` decides what a *screen* offers and
 * the policy decides what the *database* accepts, and when they drift the
 * failure is silent in the worse direction — a role keeps its Save button and
 * the save writes **zero rows with no error**, which is the outcome this repo
 * has shipped twice.
 *
 * `platform_admin` is deliberately absent from all three: it is not a membership
 * role and reaches every laundry through `has_role`'s own `or
 * is_platform_admin()` (0019), so naming it would be a second, weaker answer to
 * a question that helper already settles.
 */

const MIGRATION = join(__dirname, "..", "..", "..", "supabase", "migrations",
                       "0049_fleet_and_site_write.sql");

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

describe("the database's fleet gates match roles.ts", () => {
  it("found the migration and all three gates", () => {
    // Non-vacuous: an empty read would satisfy every assertion below.
    expect(sql).toContain("can_write_fleet");
    expect(rolesInGate(sql, "can_write_fleet").length).toBeGreaterThan(0);
    expect(rolesInGate(sql, "can_read_fleet").length).toBeGreaterThan(0);
    expect(rolesInGate(sql, "can_write_depots").length).toBeGreaterThan(0);
  });

  it("gates the fleet write on exactly the fleet.write holders", () => {
    expect(rolesInGate(sql, "can_write_fleet")).toEqual(membershipHolders("fleet.write"));
  });

  it("gates the fuel read on exactly the fleet.read holders", () => {
    expect(rolesInGate(sql, "can_read_fleet")).toEqual(membershipHolders("fleet.read"));
  });

  it("gates a site on exactly the admin.write holders", () => {
    // Narrower than the fleet on purpose: retiring the only depot empties every
    // site picker in the app, because all seven filter `status = 'active'`.
    expect(rolesInGate(sql, "can_write_depots")).toEqual(membershipHolders("admin.write"));
  });

  it("keeps the road out of the write, which is what 0049 is for", () => {
    // Named rather than derived, because these are the point: before 0049 a
    // driver could re-point another driver's row at their own login — the column
    // `current_driver_id()` matches on — and a board could retire the depot.
    for (const role of ["driver", "board", "warehouse_operator",
                        "customer_service", "finance", "auditor"] as const) {
      expect(can(role, "fleet.write"), `${role} should not change the fleet`).toBe(false);
    }
  });

  it("leaves the reads the road needs alone", () => {
    // The other half, and the one that breaks a screen if it is got wrong.
    // `/run` reads the caller's own `drivers` row to decide whether to show the
    // day's work at all, the run sheet and the plant's return count name the
    // van, and the plant floor picks a depot — and none of those roles holds
    // `fleet.read`.
    for (const role of ["driver", "board", "warehouse_operator"] as const) {
      expect(can(role, "fleet.read")).toBe(false);
    }
    for (const table of ["depots", "vehicles", "drivers"]) {
      expect(sql).toMatch(new RegExp(
        `create policy ${table}_read[\\s\\S]{0,120}using \\(\\(select public\\.is_member\\(tenant_id\\)\\)`));
    }
  });
});

describe("every writer that reaches these tables is inside its gate", () => {
  it("covers linking a login to a driver", () => {
    // `linkDriverLogin` is gated on `admin.write` and writes `drivers.user_id`,
    // while the table is gated on `fleet.write`. `admin.write` is a strict
    // subset today, so the link lands. If the two ever part company it would
    // instead write zero rows in silence, and the driver would be told for ever
    // that their login is not linked yet — on a screen whose only other advice
    // is to link it.
    for (const role of ROLES) {
      if (can(role, "admin.write")) {
        expect(can(role, "fleet.write"),
               `${role} links a driver login but cannot write the drivers table`).toBe(true);
      }
    }
  });

  it("covers adding a site from the setup screen", () => {
    // `createDepot` and `updateDepotStatus` are `admin.write`, which is exactly
    // what `can_write_depots()` names — so this is containment by construction
    // rather than by coincidence, and the assertion says so out loud.
    for (const role of ROLES) {
      expect(can(role, "admin.write"),
             `${role} disagrees with the depot gate`).toBe(
        rolesWith("admin.write").includes(role));
    }
  });
});
