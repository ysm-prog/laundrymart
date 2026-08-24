import { describe, expect, it } from "vitest";
import {
  NAVIGATION, NAV_GROUP_LABELS, groupIsOpenByDefault, groupNavigation, isActive,
  navigationFor, sectionFor,
} from "@/lib/nav";
import { MEMBERSHIP_ROLES, ROLES, can, type Role } from "@/lib/roles";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(fleet?.children?.map((child) => child.label)).toEqual(["Boards", "Drivers", "Vehicles"]);
    expect(navigationFor("dispatcher").map((item) => item.label)).not.toContain("Settings");
  });

  // Ten when the redesign landed; eleven since the laundry-jobs module added an
  // area of its own. The number is not sacred — the promise it stands for is
  // that the rail lists areas of work rather than tables, and that a role only
  // ever sees the ones it can open.
  it("stays inside the twelve rows the rail promises", () => {
    // Eleven when the redesign landed; twelve since Runs came back as an
    // *ordering* screen rather than the run-management area that was removed.
    // `platform_admin` is checked separately below: it gets a thirteenth row
    // none of these can see, and folding it in here would have quietly raised
    // the ceiling for all of them.
    for (const role of MEMBERSHIP_ROLES) {
      expect(navigationFor(role).length, role).toBeLessThanOrEqual(12);
    }
  });

  it("splits the two sides of the ledger between the roles that own them", () => {
    // The Money area holds both. Since job→invoice became the Owner's and the
    // Office manager's, the two halves land on different people and the area
    // resolves to whichever screen the role can actually open.
    //
    // A dispatcher now holds neither half, so the row is gone entirely rather
    // than pointing at a screen the auth gate would bounce them from.
    expect(navigationFor("dispatcher").map((item) => item.label)).not.toContain("Money");

    // Finance keeps the payable side and loses the receivable one, so the area
    // survives with the three payable tabs and starts at Bills.
    const finance = navigationFor("finance").find((item) => item.label === "Money");
    expect(finance?.href).toBe("/bills");
    expect(finance?.children?.map((child) => child.label)).toEqual([
      "Bills", "Suppliers", "Accounts",
    ]);

    // The Office manager keeps both sides.
    const office = navigationFor("operations_manager").find((item) => item.label === "Money");
    expect(office?.children?.map((child) => child.label)).toEqual([
      "Invoices", "Billing", "Awaiting invoice", "Laundry prices", "Xero",
      "Bills", "Suppliers", "Accounts",
    ]);

    // Xero rides with the receivable side, so finance does not see it: they no
    // longer bill the customer, and the connection decides where those invoices
    // land.
    expect(finance?.children?.map((child) => child.label)).not.toContain("Xero");
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
    expect(rows).toHaveLength(13);
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

  it("still keeps the old run-management screens off the map, for any role", () => {
    // The simplification's promise, which survives Runs coming back: nobody
    // creates, opens or manages a run, and no rail row points at `/routes/*`.
    // The new Runs row is an *ordering* screen at `/runs` — a different thing,
    // and the reason this assertion is about the hrefs rather than the label.
    for (const role of ROLES) {
      const hrefs = navigationFor(role).flatMap(
        (item) => [item.href, ...(item.children ?? []).map((child) => child.href)]);
      for (const href of hrefs) {
        expect(href.startsWith("/routes/"), `${role} → ${href}`).toBe(false);
      }
    }
  });

  it("shows Runs to the office and to a board, and lets only the office change it", () => {
    // The client's rule as capabilities: a board reads the sequence the office
    // set. `routes.write` is what the reorder screen guards on, and a board
    // does not hold it.
    for (const role of ["super_admin", "operations_manager", "dispatcher", "board"] as const) {
      expect(navigationFor(role).map((item) => item.label), role).toContain("Runs");
    }
    expect(navigationFor("finance").map((item) => item.label)).not.toContain("Runs");
  });

  it("keeps drivers and vehicles reachable after the Runs area went", () => {
    // They were tabs under Runs and are not run management. Losing them with it
    // would have been the silent casualty of removing the area.
    const fleet = navigationFor("dispatcher").find((item) => item.label === "Fleet");
    expect(fleet?.children?.map((child) => child.href))
      .toEqual(["/boards", "/drivers", "/vehicles"]);
  });

  it("leads Fleet with Boards, because that is what work is assigned to", () => {
    const fleet = navigationFor("dispatcher").find((item) => item.label === "Fleet");
    expect(fleet?.href).toBe("/boards");
  });

  it("orders the rail the way the day runs", () => {
    expect(navigationFor("super_admin").map((item) => item.label)).toEqual([
      "Today", "My Runs", "Runs", "Fleet", "Driver visits", "Customer laundry", "Customers",
      "Money", "Linen", "Reports", "Settings", "Help",
    ]);
  });

  it("shows Customer laundry to the Owner and the Office manager and to nobody else", () => {
    // The owner's decision, 2026-08-16: the job→invoice flow is theirs alone.
    // The rail follows the capability, so the row simply is not there for the
    // counter, the floor, a dispatcher or a driver — none of whom can open a
    // job any more.
    for (const role of ["super_admin", "operations_manager", "platform_admin"] as const) {
      expect(navigationFor(role).map((item) => item.label), role).toContain("Customer laundry");
    }
    for (const role of [
      "customer_service", "warehouse_operator", "dispatcher", "driver",
      "finance", "auditor", "branch_manager", "regional_manager", "sales",
    ] as const) {
      expect(navigationFor(role).map((item) => item.label), role).not.toContain("Customer laundry");
    }
  });

  /**
   * The brief's role rule, asserted at the level a person experiences it.
   *
   * Operational users see jobs, runs and a customer's operational information
   * and never pricing, invoice amounts or Xero. RLS is the real boundary
   * (migration 0017, proved in `job_billing.test.sql`); these assertions are
   * about the map — a rail row leading to a screen full of numbers a role is
   * not meant to see would be a bug even with the data correctly hidden.
   */
  const OPERATIONAL: Role[] = ["driver", "dispatcher", "warehouse_operator", "customer_service"];

  it("keeps every money screen off the operational roles' map", () => {
    for (const role of OPERATIONAL) {
      const hrefs = navigationFor(role).flatMap(
        (item) => [item.href, ...(item.children ?? []).map((child) => child.href)],
      );
      for (const href of hrefs) {
        expect(href.startsWith("/invoices"), `${role} → ${href}`).toBe(false);
      }
    }
  });

  it("holds no financial capability for any operational role", () => {
    // Dispatch is the one that changed: it used to carry invoices.read and
    // invoices.write. Stated here so putting either back trips a test rather
    // than quietly re-opening the ledger to the people planning the day.
    for (const role of OPERATIONAL) {
      for (const capability of ["pricing.read", "pricing.write", "billing.read", "billing.write",
                                "invoices.read", "invoices.write", "invoices.approve",
                                "invoices.send", "invoices.bulk"] as const) {
        expect(can(role, capability), `${role} must not hold ${capability}`).toBe(false);
      }
    }
  });

  it("gives finance the payable side and none of the receivable one", () => {
    // The branch these capabilities arrived on gave finance the whole money
    // surface. 0025 is the later decision and wins: billing the customer is
    // half of job→invoice, which answers to the Owner and the Office manager.
    // What finance keeps is what the business pays *out*.
    for (const capability of ["purchases.read", "purchases.write", "reports.read"] as const) {
      expect(can("finance", capability), capability).toBe(true);
    }
    for (const capability of ["billing.read", "billing.write", "pricing.read",
                              "pricing.write", "invoices.read", "invoices.write",
                              "invoices.approve", "invoices.send", "invoices.bulk",
                              "orders.read", "orders.write", "orders.status"] as const) {
      expect(can("finance", capability), capability).toBe(false);
    }
  });

  it("keeps sales out of pricing, because pricing is half of job→invoice", () => {
    // `pricing.*` is split from `billing.*` in the *database* (0017 gates them
    // through different functions), which is why both names exist. Who holds
    // them is a separate question, and the owner's answer is two roles — so
    // sales negotiate a contract's terms and do not set its prices.
    for (const capability of ["pricing.read", "pricing.write", "billing.read",
                              "billing.write", "invoices.read"] as const) {
      expect(can("sales", capability), capability).toBe(false);
    }
    expect(can("sales", "agreements.write")).toBe(true);
  });

  it("keeps the auditor out of the money as well as out of the jobs", () => {
    // The auditor is read-everything *outside* the main flow. Pricing and
    // billing joined that flow with the rate card, so they left the auditor
    // with it — deliberately, and by the same subtraction.
    for (const capability of ["pricing.read", "billing.read", "invoices.read",
                              "billing.write", "invoices.write", "invoices.approve",
                              "invoices.send", "invoices.bulk"] as const) {
      expect(can("auditor", capability), capability).toBe(false);
    }
    // It still reads everything that is not the main flow.
    expect(can("auditor", "customers.read")).toBe(true);
    expect(can("auditor", "inventory.read")).toBe(true);
  });

  it("puts the awaiting-invoice queue under Money, for the two roles that bill", () => {
    for (const role of ["super_admin", "operations_manager"] as const) {
      const money = navigationFor(role).find((item) => item.label === "Money");
      expect(money?.children?.map((child) => child.href), role)
        .toContain("/invoices/awaiting");
    }
    // And nowhere at all for a role that holds no `billing.read` — finance
    // still has a Money row, for the payable tabs, and the queue is not in it.
    const finance = navigationFor("finance").find((item) => item.label === "Money");
    expect(finance?.children?.map((child) => child.href))
      .not.toContain("/invoices/awaiting");
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
    expect(label("/operations/exceptions")).toBe("Driver visits");
    expect(label("/warehouse/batch-1")).toBe("Linen");
    expect(label("/vehicles")).toBe("Fleet");
    expect(label("/bills")).toBe("Money");
    expect(label("/billing")).toBe("Money");
    // The customer's period, which is a detail route of the billing screen and
    // must not fall out of Money onto the customer record.
    expect(label("/billing/cust-1")).toBe("Money");
    expect(label("/suppliers")).toBe("Money");
    expect(label("/accounts")).toBe("Money");
  });

  it("prefers the longest matching destination", () => {
    // /orders (Customer laundry) and /operations/* (tabs under Driver visits)
    // both exist; the tab strip must not flip areas on the deeper path.
    expect(label("/orders/abc-123/edit")).toBe("Customer laundry");
    expect(label("/operations/pickups")).toBe("Driver visits");
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

/**
 * The rail's label and the page it opens have to say the same thing.
 *
 * "Jobs" → "Customer laundry" and "Stops" → "Driver visits" were renamed in
 * `nav.ts` on 2026-08-24 because both old words read as "a job somebody has to
 * do" and telling them apart needed the glossary. The destination pages kept
 * their own titles, so pressing the renamed row landed you on a heading using
 * exactly the word the rename existed to get away from — and nothing here
 * noticed, because every other test in this file asserts `nav.ts` against
 * itself.
 *
 * This reads the page sources instead. It is the only place the two halves can
 * be compared: a `page.tsx` cannot be imported into a unit test, since it
 * reaches Supabase at module scope.
 */
describe("the rail and the page it opens agree", () => {
  const APP = join(process.cwd(), "src/app/(app)");

  it.each([
    ["orders/page.tsx", "Customer laundry"],
    ["jobs/page.tsx", "Driver visits"],
  ])("%s is titled %s", (file, label) => {
    const source = readFileSync(join(APP, file), "utf8");
    expect(source).toContain(`export const metadata = { title: "${label}" };`);
    expect(source).toContain(`title="${label}"`);
  });

  it("no longer titles either page with the word the rename retired", () => {
    for (const file of ["orders/page.tsx", "jobs/page.tsx"]) {
      const source = readFileSync(join(APP, file), "utf8");
      expect(source).not.toContain('export const metadata = { title: "Jobs" }');
      expect(source).not.toContain('export const metadata = { title: "Stops" }');
      expect(source).not.toContain('title="Jobs"');
      expect(source).not.toContain('title="Stops"');
    }
  });
});

/**
 * The rail's three collapsible groups.
 *
 * This softens §6's "one flat list, no headings" — see the note over `GROUPS`
 * in `nav.ts`. The property that has to hold is that grouping is only a way of
 * *drawing* the rail: every area a role can reach must still appear exactly
 * once, and none may go missing because nobody remembered to name it.
 */
describe("rail grouping", () => {
  it("shows every area a role can reach, exactly once", () => {
    for (const role of ROLES) {
      const items = navigationFor(role);
      const { groups, rest } = groupNavigation(items);
      const drawn = [...groups.flatMap((g) => g.items), ...rest].map((i) => i.href);
      expect(new Set(drawn).size, role).toBe(drawn.length);          // no duplicates
      expect(drawn.sort()).toEqual(items.map((i) => i.href).sort()); // and none lost
    }
  });

  // The failure that matters: an area added to NAVIGATION and not named in a
  // group must still be drawn. Silently vanishing from the rail is far worse
  // than landing in the wrong drawer.
  it("falls an unnamed area through to the ungrouped rows rather than dropping it", () => {
    const invented = { label: "Brand new", href: "/brand-new", icon: "today" } as const;
    const { groups, rest } = groupNavigation([...navigationFor("super_admin"), invented]);
    expect(groups.flatMap((g) => g.items).map((i) => i.href)).not.toContain("/brand-new");
    expect(rest.map((i) => i.href)).toContain("/brand-new");
  });

  it("keeps Help out of every drawer, pinned last", () => {
    for (const role of ROLES) {
      const { groups, rest } = groupNavigation(navigationFor(role));
      expect(groups.flatMap((g) => g.items).map((i) => i.href)).not.toContain("/help");
      // It is the one row with no capability, so every role has it — and the
      // moment somebody is lost is the wrong moment for it to be behind a
      // closed drawer.
      expect(rest[0]?.href, role).toBe("/help");
    }
  });

  it("renders no heading for a group a role cannot see into", () => {
    // A driver holds no billing or admin capability, so those groups are empty
    // for them and must not draw an empty drawer.
    const { groups } = groupNavigation(navigationFor("driver"));
    for (const group of groups) expect(group.items.length).toBeGreaterThan(0);
  });

  it("opens the day-to-day group and leaves the others shut", () => {
    expect(groupIsOpenByDefault("Day to day")).toBe(true);
    expect(groupIsOpenByDefault("Customers & money")).toBe(false);
    expect(groupIsOpenByDefault("Set-up & reports")).toBe(false);
  });

  it("names the groups in plain words, not in trade terms", () => {
    const jargon = /\b(depot|board|agreement|levy|tenant|manifest|dispatch|plant|inventory)/i;
    for (const label of NAV_GROUP_LABELS) expect(label).not.toMatch(jargon);
  });

  // The rail is the thing being tidied, so the shape it collapses to is the
  // point: a short open list plus two closed drawers plus Help.
  it("leaves an owner a short rail with both drawers shut", () => {
    const { groups, rest } = groupNavigation(navigationFor("super_admin"));
    const visible = groups.filter((g) => groupIsOpenByDefault(g.label))
      .flatMap((g) => g.items).length + groups.length + rest.length;
    expect(visible).toBeLessThanOrEqual(9); // was 12 flat rows
  });
});
