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

  // Ten when the redesign landed; eleven since the laundry-jobs module added an
  // area of its own. The number is not sacred — the promise it stands for is
  // that the rail lists areas of work rather than tables, and that a role only
  // ever sees the ones it can open.
  it("stays inside the eleven rows the redesign promises", () => {
    for (const role of ROLES) {
      expect(navigationFor(role).length, role).toBeLessThanOrEqual(11);
    }
  });

  it("gives the driver My runs, and both screens inside it", () => {
    const area = navigationFor("driver").find((item) => item.label === "My runs");
    expect(area).toBeDefined();
    expect(area?.href).toBe("/my-runs");
    // `/run` is kept, not replaced: it owns the offline outbox and the service
    // worker, and it is the one screen that has to work with no signal.
    expect(area?.children?.map((child) => child.href)).toEqual(["/my-runs", "/run"]);
  });

  it("gives a dispatcher My runs without the driver's capture screen", () => {
    const area = navigationFor("dispatcher").find((item) => item.label === "My runs");
    expect(area?.href).toBe("/my-runs");
    // `run.execute` is the driver's; a dispatcher gets the overview only.
    expect(area?.children?.map((child) => child.href)).toEqual(["/my-runs"]);
  });

  it("never shows My run and My runs as two separate rows", () => {
    // §6: the old single-run screen was evolved into this area rather than
    // left beside it. Two rail rows a letter apart is the confusion the brief
    // is guarding against.
    for (const role of ROLES) {
      const rows = navigationFor(role).filter((item) => /^my runs?$/i.test(item.label));
      expect(rows.length, role).toBeLessThanOrEqual(1);
    }
  });

  it("keeps My runs away from roles that do not drive", () => {
    for (const role of ["finance", "warehouse_operator", "sales"] as const) {
      expect(navigationFor(role).map((item) => item.label), role).not.toContain("My runs");
    }
  });

  it("leaves the existing Runs area exactly where it was", () => {
    // My Runs is an addition, not a replacement: `/routes/daily` stays the
    // management view of every run and keeps its own rail row.
    const runs = navigationFor("dispatcher").find((item) => item.label === "Runs");
    expect(runs?.href).toBe("/routes/daily");
    expect(runs?.children?.map((child) => child.href)).toContain("/routes/planner");
  });

  it("orders the rail the way the day runs", () => {
    expect(navigationFor("super_admin").map((item) => item.label)).toEqual([
      "Today", "My runs", "Runs", "Stops", "Jobs", "Customers",
      "Invoices", "Linen", "Reports", "Settings", "Help",
    ]);
  });

  it("shows the counter its jobs and keeps them from the driver", () => {
    expect(navigationFor("customer_service").map((item) => item.label)).toContain("Jobs");
    expect(navigationFor("warehouse_operator").map((item) => item.label)).toContain("Jobs");
    // A driver's world is their own run; counter jobs are not on it.
    expect(navigationFor("driver").map((item) => item.label)).not.toContain("Jobs");
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

  it("keeps the two run areas apart", () => {
    // Neither may swallow the other: a driver on /my-runs must not light up
    // "Runs", and a dispatcher on /routes/daily must not light up "My runs".
    expect(label("/my-runs")).toBe("My runs");
    expect(label("/my-runs/jobs/abc-123")).toBe("My runs");
    expect(label("/run")).toBe("My runs");
    expect(label("/routes/daily")).toBe("Runs");
    expect(label("/routes/daily/run-1/sheet")).toBe("Runs");
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
