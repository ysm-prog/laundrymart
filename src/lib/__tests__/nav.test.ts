import { describe, expect, it } from "vitest";
import { NAVIGATION, isActive, navigationFor, sectionFor } from "@/lib/nav";
import { MEMBERSHIP_ROLES, ROLES, can, type Role } from "@/lib/roles";

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
    expect(driver.map((item) => item.label)).not.toContain("Money");
    expect(driver.map((item) => item.label)).not.toContain("Settings");
  });

  it("keeps an area whose own screen is out of reach but whose children are not", () => {
    // A dispatcher has fleet.read but not admin.read: "Fleet" survives with the
    // tabs they can open, and Settings stays out of the rail entirely.
    const fleet = navigationFor("dispatcher").find((item) => item.label === "Fleet");
    expect(fleet).toBeDefined();
    expect(fleet?.children?.map((child) => child.label)).toEqual(["Drivers", "Vehicles"]);
    expect(navigationFor("dispatcher").map((item) => item.label)).not.toContain("Settings");
  });

  // Ten when the redesign landed; eleven since the laundry-jobs module added an
  // area of its own. The number is not sacred — the promise it stands for is
  // that the rail lists areas of work rather than tables, and that a role only
  // ever sees the ones it can open.
  it("stays inside the eleven rows the redesign promises", () => {
    // Every role that works inside a laundry. `platform_admin` is checked
    // separately below: it gets a twelfth row that none of these can see, and
    // folding it in here would have quietly raised the ceiling for all of them.
    for (const role of MEMBERSHIP_ROLES) {
      expect(navigationFor(role).length, role).toBeLessThanOrEqual(11);
    }
  });

  it("keeps the payable screens away from the people who plan the day", () => {
    // A dispatcher holds `invoices.read` so they can see whether a customer is
    // on stop. That is not a reason to show them what the business pays its
    // suppliers, which is why `purchases.read` exists as its own capability.
    const money = navigationFor("dispatcher").find((item) => item.label === "Money");
    expect(money?.children?.map((child) => child.label)).toEqual(["Invoices", "Laundry prices"]);

    const finance = navigationFor("finance").find((item) => item.label === "Money");
    expect(finance?.children?.map((child) => child.label)).toEqual([
      "Invoices", "Laundry prices", "Bills", "Suppliers", "Accounts",
    ]);
  });

  it("shows Platform to the platform admin and to nobody else", () => {
    // The row is gated on `platform.read`, which `roles.test.ts` proves is held
    // by `platform_admin` alone. This is the other half: an owner opening their
    // own app must never see a row implying there are other businesses behind
    // it, and the platform admin must actually be able to reach one.
    for (const role of MEMBERSHIP_ROLES) {
      expect(navigationFor(role).map((item) => item.label), role).not.toContain("Platform");
    }

    const rows = navigationFor("platform_admin");
    expect(rows).toHaveLength(12);
    const platform = rows.find((item) => item.label === "Platform");
    expect(platform?.href).toBe("/platform");
    expect(platform?.children?.map((child) => child.href)).toEqual([
      "/platform", "/platform/admins", "/platform/settings", "/platform/release",
    ]);
  });

  it("gives the driver My Runs, and both screens inside it", () => {
    const area = navigationFor("driver").find((item) => item.label === "My Runs");
    expect(area).toBeDefined();
    expect(area?.href).toBe("/my-runs");
    // `/run` is kept, not replaced: it owns the offline outbox and the service
    // worker, and it is the one screen that has to work with no signal.
    expect(area?.children?.map((child) => child.href)).toEqual(["/my-runs", "/run"]);
  });

  it("gives a dispatcher My Runs without the driver's capture screen", () => {
    const area = navigationFor("dispatcher").find((item) => item.label === "My Runs");
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
      expect(navigationFor(role).map((item) => item.label), role).not.toContain("My Runs");
    }
  });

  it("has no user-facing Runs area, for any role", () => {
    // The whole point of the simplification: nobody creates, opens or manages a
    // run. The `/routes/*` screens still exist and still work — they are simply
    // off the map — so this asserts on the rail, not on the routes.
    for (const role of ROLES) {
      const labels = navigationFor(role).map((item) => item.label);
      expect(labels, role).not.toContain("Runs");
      const hrefs = navigationFor(role).flatMap(
        (item) => [item.href, ...(item.children ?? []).map((child) => child.href)]);
      for (const href of hrefs) {
        expect(href.startsWith("/routes/"), `${role} → ${href}`).toBe(false);
      }
    }
  });

  it("keeps drivers and vehicles reachable after the Runs area went", () => {
    // They were tabs under Runs and are not run management. Losing them with it
    // would have been the silent casualty of removing the area.
    const fleet = navigationFor("dispatcher").find((item) => item.label === "Fleet");
    expect(fleet?.href).toBe("/drivers");
    expect(fleet?.children?.map((child) => child.href)).toEqual(["/drivers", "/vehicles"]);
  });

  it("orders the rail the way the day runs", () => {
    expect(navigationFor("super_admin").map((item) => item.label)).toEqual([
      "Today", "My Runs", "Fleet", "Stops", "Jobs", "Customers",
      "Money", "Linen", "Reports", "Settings", "Help",
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
    expect(label("/invoices/inv-1")).toBe("Money");
  });

  it("resolves a child that is not under the area's own path", () => {
    expect(label("/agreements")).toBe("Customers");
    expect(label("/operations/exceptions")).toBe("Stops");
    expect(label("/warehouse/batch-1")).toBe("Linen");
    expect(label("/vehicles")).toBe("Fleet");
    expect(label("/bills")).toBe("Money");
    expect(label("/suppliers")).toBe("Money");
    expect(label("/accounts")).toBe("Money");
  });

  it("prefers the longest matching destination", () => {
    // /orders (the Jobs area) and /operations/* (tabs under Stops) both exist;
    // the tab strip must not flip areas on the deeper path.
    expect(label("/orders/abc-123/edit")).toBe("Jobs");
    expect(label("/operations/pickups")).toBe("Stops");
  });

  it("puts every My Runs path in the one area, and leaves /routes off the map", () => {
    expect(label("/my-runs")).toBe("My Runs");
    expect(label("/my-runs/jobs/abc-123")).toBe("My Runs");
    expect(label("/run")).toBe("My Runs");
    // The run-management screens are still reachable by URL but belong to no
    // rail area, so opening one highlights nothing rather than resurrecting
    // "Runs" in the sidebar.
    expect(label("/routes/daily")).toBeUndefined();
    expect(label("/routes/planner")).toBeUndefined();
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
