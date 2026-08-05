import { describe, expect, it } from "vitest";
import { NAVIGATION, isActive, navigationFor, sectionFor } from "@/lib/nav";
import { ROLES, can, type Role } from "@/lib/roles";

describe("navigationFor", () => {
  it("gives every role a way to reach the screen they are redirected to", () => {
    // The auth gate sends everyone to /dashboard. A role with no rail row for
    // it lands on a page it cannot navigate away from without typing a URL —
    // which is exactly what happened to drivers, the one role guaranteed to be
    // sent there.
    for (const role of ROLES) {
      const labels = navigationFor(role).map((item) => item.href);
      expect(labels, role).toContain("/dashboard");
    }
  });

  it("offers help to every role", () => {
    for (const role of ROLES) {
      expect(navigationFor(role).map((item) => item.href), role).toContain("/help");
    }
  });

  it("never links an area to a screen the role cannot open", () => {
    for (const role of ROLES) {
      for (const item of navigationFor(role)) {
        // The resolved capability travels with the resolved href, so this is
        // the real gate the link will hit — not the area's declared one.
        if (item.capability) {
          expect(can(role, item.capability), `${role} → ${item.href}`).toBe(true);
        }
        for (const child of item.children ?? []) {
          expect(
            child.capability === undefined || can(role, child.capability),
            `${role} → ${child.href}`,
          ).toBe(true);
        }
      }
    }
  });

  it("borrows a child's href when the area's own screen is closed to the role", () => {
    // Finance can price items but holds no inventory.read: the Linen row must
    // point at item types rather than at a stock screen that would reject them.
    const linen = navigationFor("finance").find((item) => item.label === "Linen");
    expect(linen?.href).toBe("/items");
    expect(linen?.capability).toBe("items.read");
  });

  it("hides an area entirely when no screen inside it is reachable", () => {
    const driver = navigationFor("driver");
    expect(driver.map((item) => item.label)).not.toContain("Invoices");
    expect(driver.map((item) => item.label)).not.toContain("Settings");
  });

  it("keeps an area whose own screen is out of reach but whose children are not", () => {
    // A dispatcher has fleet.read but not admin.read: "Runs" survives, and its
    // tabs are only the ones they can open.
    const runs = navigationFor("dispatcher").find((item) => item.label === "Runs");
    expect(runs).toBeDefined();
    expect(runs?.children?.map((child) => child.label)).toEqual([
      "Today's runs", "Plan the day", "Weekly runs", "Drivers", "Vehicles",
    ]);
    expect(navigationFor("dispatcher").map((item) => item.label)).not.toContain("Settings");
  });

  it("stays inside the ten rows the redesign promises", () => {
    for (const role of ROLES) {
      expect(navigationFor(role).length, role).toBeLessThanOrEqual(10);
    }
  });
});

describe("sectionFor", () => {
  const owner = navigationFor("super_admin");
  const label = (pathname: string) => sectionFor(pathname, owner)?.label;

  it("puts a detail route in its own area", () => {
    expect(label("/customers/abc-123")).toBe("Customers");
    expect(label("/customers/abc-123/edit")).toBe("Customers");
    expect(label("/invoices/inv-1")).toBe("Invoices");
  });

  it("resolves a child that is not under the area's own path", () => {
    expect(label("/agreements")).toBe("Customers");
    expect(label("/operations/exceptions")).toBe("Stops");
    expect(label("/warehouse/batch-1")).toBe("Linen");
    expect(label("/vehicles")).toBe("Runs");
  });

  it("prefers the longest matching destination", () => {
    // Both /routes/daily (the area) and /routes/templates (a child) live under
    // Runs; the tab strip must not flip areas on the deeper path.
    expect(label("/routes/templates/tpl-1")).toBe("Runs");
    expect(label("/routes/planner")).toBe("Runs");
  });

  it("returns nothing for a path off the map", () => {
    expect(label("/design-preview")).toBeUndefined();
  });
});

describe("isActive", () => {
  it("matches the dashboard exactly and everything else by prefix", () => {
    expect(isActive("/dashboard", "/dashboard")).toBe(true);
    expect(isActive("/dashboard/anything", "/dashboard")).toBe(false);
    expect(isActive("/customers/abc", "/customers")).toBe(true);
    // A sibling that merely shares a prefix must not light up.
    expect(isActive("/customers-archive", "/customers")).toBe(false);
  });
});

describe("the map itself", () => {
  it("has no duplicate destinations", () => {
    const hrefs = NAVIGATION.flatMap((item) => [item, ...(item.children ?? [])])
      .map((entry) => entry.href);
    // The area's own href repeats as its first tab by design; anything else
    // would make two rail rows fight over the same path in `sectionFor`.
    const areaHrefs = NAVIGATION.map((item) => item.href);
    const extras = hrefs.filter((href) => !areaHrefs.includes(href));
    expect(new Set(extras).size).toBe(extras.length);
  });

  it("explains every area in plain words", () => {
    for (const item of NAVIGATION) {
      expect(item.blurb, item.label).toBeTruthy();
    }
  });

  it("gates every destination on a capability someone actually holds", () => {
    const holders = (capability: string) =>
      ROLES.filter((role: Role) => can(role, capability as never));
    for (const item of NAVIGATION) {
      for (const entry of [item, ...(item.children ?? [])]) {
        if (!entry.capability) continue;
        expect(holders(entry.capability).length, entry.href).toBeGreaterThan(0);
      }
    }
  });
});
