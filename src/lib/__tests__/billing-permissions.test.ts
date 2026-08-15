import { describe, expect, it } from "vitest";
import { can, ROLE_CAPABILITIES, type Role } from "@/lib/roles";

describe("laundry billing permission boundaries", () => {
  const operational: Role[] = ["driver", "warehouse_operator", "customer_service", "dispatcher"];
  const financial: Role[] = ["super_admin", "operations_manager", "finance", "branch_manager", "regional_manager"];

  it("blocks operational roles from financial data", () => {
    for (const role of operational) {
      expect(can(role, "invoices.read")).toBe(false);
      expect(can(role, "invoices.write")).toBe(false);
      expect(can(role, "invoices.send")).toBe(false);
      expect(can(role, "pricing.read")).toBe(false);
      expect(can(role, "pricing.write")).toBe(false);
      expect(can(role, "billing.read")).toBe(false);
      expect(can(role, "billing.write")).toBe(false);
    }
  });

  it("allows owner/manager-style roles to manage finance", () => {
    for (const role of financial) {
      expect(ROLE_CAPABILITIES[role]).toContain("invoices.read");
      expect(ROLE_CAPABILITIES[role]).toContain("invoices.write");
      expect(ROLE_CAPABILITIES[role]).toContain("pricing.read");
    }
  });

  it("requires explicit approval/send capabilities", () => {
    expect(can("operations_manager", "invoices.approve")).toBe(true);
    expect(can("operations_manager", "invoices.send")).toBe(true);
    expect(can("driver", "invoices.approve")).toBe(false);
    expect(can("driver", "invoices.send")).toBe(false);
  });
});
