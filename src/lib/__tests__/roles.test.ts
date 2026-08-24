import { describe, expect, it } from "vitest";
import {
  CAPABILITIES, PRESET_ROLES, ROLES, ROLE_CAPABILITIES, ROLE_LABELS, ROLE_PRESETS, ROLE_SUMMARY,
  can, isRole, membershipRolesWith, MEMBERSHIP_ROLES, presetForRole, rolesWith, type Role,
} from "@/lib/roles";

describe("role presets", () => {
  it("names roles that actually exist", () => {
    // A preset is a label over a stored role, never a role of its own: the
    // database's check constraint, `has_role()` and every RLS policy know the
    // role and nothing about the preset. A preset naming something outside
    // ROLES would offer a choice the insert would then refuse.
    for (const preset of ROLE_PRESETS) {
      expect(isRole(preset.role), preset.key).toBe(true);
    }
  });

  it("gives each preset a distinct role, so a picker cannot offer the same one twice", () => {
    expect(new Set(PRESET_ROLES).size).toBe(ROLE_PRESETS.length);
    expect(new Set(ROLE_PRESETS.map((preset) => preset.key)).size).toBe(ROLE_PRESETS.length);
  });

  it("covers the answers a small laundry gives", () => {
    // Owner, office, board, driver. Pinned because dropping one would quietly
    // send an owner back into the full list. `board` leads the two operational
    // ones since 0031: a round is what work is assigned to, and a `driver`
    // membership is now for a laundry that tracks people rather than rounds.
    expect(PRESET_ROLES).toEqual(["super_admin", "operations_manager", "board", "driver"]);
  });

  it("round-trips a role back to its preset, and knows when there is none", () => {
    for (const preset of ROLE_PRESETS) {
      expect(presetForRole(preset.role)?.key).toBe(preset.key);
    }
    expect(presetForRole("auditor")).toBeUndefined();
  });

  it("leaves the membership roles and their capabilities untouched", () => {
    // The presets are presentation. If adding them had changed who can do what,
    // this is the assertion that would have caught it.
    //
    // MEMBERSHIP_ROLES rather than ROLES since 0019: the ones this test is
    // about are those a membership can hold, and `platform_admin` deliberately
    // cannot. Pinning ROLES here would have made that role look like a
    // regression in the preset model, which it is not.
    expect(MEMBERSHIP_ROLES).toHaveLength(12);
    expect(can("super_admin", "admin.write")).toBe(true);
    expect(can("operations_manager", "admin.write")).toBe(false);
    expect(can("driver", "run.execute")).toBe(true);
    expect(can("driver", "orders.write")).toBe(false);
  });

  it("gives a board a round's work and not the office's", () => {
    // The client's rule, stated as capabilities: a board sees the sequence the
    // office set and cannot change it, and reaches nothing financial or
    // administrative. `routes.status` means "my round" only because
    // `is_board_only()` narrows every routes row to `current_board_id()`.
    expect(can("board", "run.execute")).toBe(true);
    expect(can("board", "routes.read")).toBe(true);
    expect(can("board", "routes.status")).toBe(true);
    expect(can("board", "routes.write")).toBe(false);
    for (const capability of [
      "orders.write", "invoices.read", "billing.read", "pricing.read",
      "admin.read", "admin.write", "customers.read", "items.write",
    ] as const) {
      expect(can("board", capability), capability).toBe(false);
    }
  });

  it("gives a board exactly a driver's capabilities", () => {
    // Same job, same phone, different filing. Pinned so the two cannot drift
    // apart without somebody deciding they should.
    expect([...ROLE_CAPABILITIES.board].sort())
      .toEqual([...ROLE_CAPABILITIES.driver].sort());
  });

  it("describes and labels every role, preset or not", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      expect(ROLE_SUMMARY[role], role).toBeTruthy();
    }
  });
});

describe("rolesWith", () => {
  it("finds every role holding a capability", () => {
    const admins = rolesWith("admin.write");
    expect(admins).toContain("super_admin");
    expect(admins).not.toContain("operations_manager");
    for (const role of admins) {
      expect(can(role, "admin.write"), role).toBe(true);
    }
  });

  it("never returns an empty administrator set", () => {
    // The People screen refuses a change that would leave nobody holding
    // `admin.write`. If no role held it at all, that guard would refuse every
    // change instead of the last one — and the tenant would be just as stuck.
    expect(rolesWith("admin.write").length).toBeGreaterThan(0);
  });

  it("agrees with `can` for every capability", () => {
    for (const capability of CAPABILITIES) {
      const holders = new Set<Role>(rolesWith(capability));
      for (const role of ROLES) {
        expect(holders.has(role), `${role} → ${capability}`).toBe(can(role, capability));
      }
    }
  });
});

describe("platform_admin (0019)", () => {
  it("is a role, but never a membership role", () => {
    // Two lists on purpose. `memberships.role` carries a check constraint that
    // does not include `platform_admin`, so offering it in the People picker or
    // accepting it in the invite action would be a choice the insert refuses.
    expect(ROLES).toContain("platform_admin");
    expect(MEMBERSHIP_ROLES as readonly string[]).not.toContain("platform_admin");
    expect(ROLES.length).toBe(MEMBERSHIP_ROLES.length + 1);
  });

  it("matches the check constraint on memberships.role", () => {
    // The database's list, copied from 0001. If a role is added to the app and
    // not to the column, the failure is an insert error in production; this is
    // the cheaper place to find out.
    expect([...MEMBERSHIP_ROLES].sort()).toEqual([
      "auditor", "board", "branch_manager", "customer_service", "dispatcher",
      "driver", "finance", "operations_manager", "regional_manager", "sales",
      "super_admin", "warehouse_operator",
    ]);
  });

  it("holds every capability there is", () => {
    for (const capability of CAPABILITIES) {
      expect(can("platform_admin", capability), capability).toBe(true);
    }
  });

  it("is the only role holding the platform block — super_admin included", () => {
    // The whole point of the role. `super_admin` is the top of one laundry and
    // stops there; if a platform capability ever leaks into a role built from
    // ALL, this is what says so.
    const platform = CAPABILITIES.filter((c) => c.startsWith("platform."));
    expect(platform.length).toBeGreaterThan(0);
    for (const capability of platform) {
      expect(rolesWith(capability), capability).toEqual(["platform_admin"]);
    }
  });

  it("leaves every other role exactly as it was", () => {
    // TENANT_ALL is derived by filtering, which is the kind of change that can
    // silently drop something. Each tenant role must still hold every
    // non-platform capability it held before.
    expect(can("super_admin", "admin.write")).toBe(true);
    expect(can("operations_manager", "admin.write")).toBe(false);
    expect(can("operations_manager", "invoices.write")).toBe(true);
    expect(can("auditor", "customers.read")).toBe(true);
    expect(can("auditor", "customers.write")).toBe(false);
    expect(can("driver", "run.execute")).toBe(true);
    expect(can("branch_manager", "admin.read")).toBe(false);
  });

  it("keeps the last-administrator guard counting membership roles only", () => {
    // `rolesWith` now includes platform_admin, which is not a value the
    // memberships column accepts — so the People screen's lockout guard must
    // use the membership-only variant or it would filter on a role no row can
    // ever hold, and imply a platform admin stands in as a laundry's last one.
    expect(rolesWith("admin.write")).toContain("platform_admin");
    expect(membershipRolesWith("admin.write")).not.toContain("platform_admin");
    expect(membershipRolesWith("admin.write")).toContain("super_admin");
  });

  it("gives the new role a label and a summary like every other", () => {
    expect(ROLE_LABELS.platform_admin).toBeTruthy();
    expect(ROLE_SUMMARY.platform_admin).toBeTruthy();
  });

  it("stays out of the three presets", () => {
    // A preset is what a small laundry picks from. Nobody running one business
    // should be offered the role that reaches all of them.
    expect(PRESET_ROLES as readonly Role[]).not.toContain("platform_admin");
  });
});

describe("the payable side (purchases.*)", () => {
  it("no longer follows invoices.*, and is pinned literally instead", () => {
    // It used to be "whoever writes money records, except the dispatcher",
    // which held while both sides of the ledger answered to the same people.
    // Narrowing job→invoice to the Owner and the Office manager broke that:
    // deriving would have taken supplier bills off finance as a side effect of
    // a decision about *customer* billing. So the holders are pinned here.
    expect(rolesWith("purchases.write")).toEqual([
      "platform_admin", "super_admin", "operations_manager",
      "finance", "branch_manager", "regional_manager",
    ]);
    expect(rolesWith("purchases.read")).toEqual([
      "platform_admin", "super_admin", "operations_manager",
      "finance", "branch_manager", "regional_manager", "auditor",
    ]);
    // The point of pinning: the payable side must NOT have narrowed with the
    // receivable one.
    expect(can("finance", "purchases.write")).toBe(true);
    expect(can("finance", "invoices.write")).toBe(false);
  });

  it("never reaches the counter, the floor or the van", () => {
    // The roles a small laundry actually staffs. None of them should be able to
    // read what the business owes, let alone change it.
    for (const role of ["customer_service", "warehouse_operator", "driver", "sales"] as const) {
      expect(can(role, "purchases.read"), role).toBe(false);
      expect(can(role, "purchases.write"), role).toBe(false);
    }
  });

  it("lets the auditor look and not touch, like everything else", () => {
    expect(can("auditor", "purchases.read")).toBe(true);
    expect(can("auditor", "purchases.write")).toBe(false);
  });
});

describe("job → invoice, and who the counter is", () => {
  /*
   * Billing stays where 2026-08-16 put it. Taking laundry *in* does not.
   *
   * That decision made job→invoice one flow answering to two people, which is
   * coherent — but its effect was that a laundry wanting counter staff to book
   * jobs had to make them Office manager: 31 screens, the whole ledger, the
   * plant and the activity log, handed to the least-trained person in the
   * building to do the one job their role is named for. The owner reversed the
   * `orders.*` half on 2026-08-24. The test below said "a future edit that
   * hands one of them back should have to change this test and say why", which
   * is exactly what happened, and this is the why.
   */
  const BILLING = ["invoices.read", "invoices.write"] as const;
  const COUNTER = ["orders.read", "orders.write", "orders.status"] as const;

  it("keeps billing with the Owner and the Office manager alone", () => {
    for (const capability of BILLING) {
      expect(rolesWith(capability), capability).toEqual([
        "platform_admin", "super_admin", "operations_manager",
      ]);
    }
  });

  it("lets the counter take laundry in, and nobody else new", () => {
    for (const capability of COUNTER) {
      expect(rolesWith(capability), capability).toEqual([
        "platform_admin", "super_admin", "operations_manager", "customer_service",
      ]);
    }
  });

  // The supervisor's set — cancel a job, backdate a receipt, edit a completed
  // one — is not part of taking laundry in and did not move.
  it("keeps orders.manage away from the counter", () => {
    expect(rolesWith("orders.manage")).toEqual([
      "platform_admin", "super_admin", "operations_manager",
    ]);
    expect(can("customer_service", "orders.manage")).toBe(false);
  });

  it("closes billing to every other role, read included", () => {
    const allowed = new Set(["platform_admin", "super_admin", "operations_manager"]);
    for (const role of ROLES.filter((r) => !allowed.has(r))) {
      for (const capability of BILLING) {
        expect(can(role, capability), `${role} → ${capability}`).toBe(false);
      }
    }
  });

  it("names the roles still outside it, so a change is never silent", () => {
    // Listed by name because a future edit handing one of them back should have
    // to change this test and say why — which is how the counter's own line
    // came off this list on 2026-08-24.
    expect(can("warehouse_operator", "orders.status")).toBe(false); // the plant floor
    expect(can("customer_service", "invoices.read")).toBe(false);   // the counter sees no money
    expect(can("dispatcher", "invoices.write")).toBe(false);
    expect(can("finance", "invoices.write")).toBe(false);
    expect(can("auditor", "invoices.read")).toBe(false);
    expect(can("branch_manager", "orders.write")).toBe(false);
    expect(can("regional_manager", "orders.write")).toBe(false);
  });

  it("leaves each of those roles their own work", () => {
    // The restriction is about the main flow, not a demotion. Nothing else the
    // roles do was touched.
    expect(can("warehouse_operator", "warehouse.write")).toBe(true);
    expect(can("warehouse_operator", "inventory.write")).toBe(true);
    expect(can("customer_service", "customers.write")).toBe(true);
    expect(can("dispatcher", "routes.write")).toBe(true);
    expect(can("finance", "purchases.write")).toBe(true);
    expect(can("finance", "reports.read")).toBe(true);
    expect(can("driver", "run.execute")).toBe(true);
  });
});
