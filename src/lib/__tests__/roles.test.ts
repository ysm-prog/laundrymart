import { describe, expect, it } from "vitest";
import {
  CAPABILITIES, PRESET_ROLES, ROLES, ROLE_LABELS, ROLE_PRESETS, ROLE_SUMMARY,
  can, isRole, presetForRole, rolesWith, type Role,
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

  it("covers the three answers a small laundry gives", () => {
    // Owner, office, driver — the roadmap's D1 shape. Pinned because dropping
    // one of the three would quietly send an owner back into the eleven.
    expect(PRESET_ROLES).toEqual(["super_admin", "operations_manager", "driver"]);
  });

  it("round-trips a role back to its preset, and knows when there is none", () => {
    for (const preset of ROLE_PRESETS) {
      expect(presetForRole(preset.role)?.key).toBe(preset.key);
    }
    expect(presetForRole("auditor")).toBeUndefined();
  });

  it("leaves the eleven roles and their capabilities untouched", () => {
    // The presets are presentation. If adding them had changed who can do what,
    // this is the assertion that would have caught it.
    expect(ROLES).toHaveLength(11);
    expect(can("super_admin", "admin.write")).toBe(true);
    expect(can("operations_manager", "admin.write")).toBe(false);
    expect(can("driver", "run.execute")).toBe(true);
    expect(can("driver", "orders.write")).toBe(false);
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
