import { describe, expect, it } from "vitest";
import { QUICK_ACTIONS, quickActionsFor } from "@/lib/quick-actions";
import { NAVIGATION, type NavItem } from "@/lib/nav";
import { MEMBERSHIP_ROLES, ROLES, can } from "@/lib/roles";

/** Every href the navigation map can reach, area rows and tabs alike. */
function allNavHrefs(items: ReadonlyArray<NavItem> = NAVIGATION): string[] {
  return items.flatMap((item) => [item.href, ...allNavHrefs(item.children ?? [])]);
}

describe("quick actions", () => {
  /*
   * The objection that sank the previous attempt at simplifying this app
   * (CLAUDE.md §19) was that a second, hand-maintained list of "the simple
   * screens" drifts from `nav.ts` the moment a route moves. This is the test
   * that makes that impossible: a card pointing somewhere the navigation no
   * longer goes fails here rather than shipping.
   */
  it("only points at destinations the navigation map still has", () => {
    const known = new Set(allNavHrefs());
    for (const action of QUICK_ACTIONS) {
      // `/orders/new` and `/customers/new` are entry screens reached *from* a
      // listed area rather than listed themselves, so a card may name either a
      // destination or a child of one.
      const reachable = known.has(action.href) ||
        [...known].some((href) => href !== "/" && action.href.startsWith(`${href}/`));
      expect(reachable, `${action.label} → ${action.href} is not under any navigation area`)
        .toBe(true);
    }
  });

  it("never offers a screen the role would be bounced off", () => {
    for (const role of ROLES) {
      for (const action of quickActionsFor(role)) {
        if (action.capability) expect(can(role, action.capability)).toBe(true);
      }
    }
  });

  // The point of the card is to be short. A list of every screen the role can
  // open is the rail, which is the thing this exists to stand in front of.
  it("stays short enough to read at a glance for every role", () => {
    for (const role of ROLES) {
      expect(quickActionsFor(role).length).toBeLessThanOrEqual(7);
    }
  });

  // A card with nothing on it is worse than no card. Every role must get at
  // least the help entry, which is why that one carries no capability.
  it("gives every role something to do", () => {
    for (const role of ROLES) {
      expect(quickActionsFor(role).length).toBeGreaterThan(0);
    }
  });

  it("offers help to everyone, including the narrowest roles", () => {
    for (const role of ROLES) {
      expect(quickActionsFor(role).map((a) => a.href)).toContain("/help");
    }
  });

  // The two personas in the brief: a counter hand taking laundry in, and a
  // board out delivering. Each must find their own job on the card.
  it("offers the counter's job to the roles that can do it", () => {
    expect(quickActionsFor("operations_manager").map((a) => a.href)).toContain("/orders/new");
    expect(quickActionsFor("super_admin").map((a) => a.href)).toContain("/orders/new");
  });

  it("offers the delivery round its own day", () => {
    for (const role of ["board", "driver"] as const) {
      expect(quickActionsFor(role).map((a) => a.href)).toContain("/my-runs");
    }
  });

  // Money is the one thing the 2026-08-16 narrowing was emphatic about: a
  // driver, a board and the floor see no dollar figure anywhere.
  it("never offers billing to a role with no billing capability", () => {
    for (const role of ["driver", "board", "warehouse_operator", "dispatcher"] as const) {
      expect(quickActionsFor(role).map((a) => a.href)).not.toContain("/invoices");
    }
  });

  it("is written in words with no trade jargon in them", () => {
    // Every word the help page has to define, plus the internal nouns.
    const jargon = /\b(depot|board|agreement|levy|consolidat|tenant|manifest|snapshot|RLS|SKU|surcharge|stop|run|batch|dispatch|reconcil)/i;
    for (const action of QUICK_ACTIONS) {
      expect(`${action.label} ${action.detail}`).not.toMatch(jargon);
    }
  });

  it("names every job as something you do, not as a place you go", () => {
    for (const action of QUICK_ACTIONS) {
      // A verb first. "Jobs" and "Customers" are the rail's job, not this one.
      expect(action.label).toMatch(/^(Take|See|Find|Add|Send|Show)\b/);
      expect(action.detail.length).toBeGreaterThan(20);
    }
  });

  it("covers every membership role without a gap in the icon map", () => {
    for (const role of MEMBERSHIP_ROLES) {
      for (const action of quickActionsFor(role)) expect(action.icon).toBeTruthy();
    }
  });
});
