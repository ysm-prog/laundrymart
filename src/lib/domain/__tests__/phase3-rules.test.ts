import { describe, expect, it } from "vitest";
import { can } from "@/lib/roles";
import { INBOX_SECTIONS, inboxSectionsFor, moreThan } from "@/lib/domain/inbox";
import {
  boardBillingLabel, boardColumn, canApprove, canAssign, canMarkReady, normaliseDocket,
} from "@/lib/domain/laundry-board";
import {
  defaultReturnDate, matchQuoteLines, prefillFromLastJob, stepQuantity,
} from "@/lib/domain/intake";
import {
  DEFAULT_OPERATIONS, parseOperations, readOperationsForm,
} from "@/lib/domain/operations-settings";
import { findDuplicateItems, normaliseItemName } from "@/lib/domain/item-duplicates";
import { describeOrderActivity } from "@/lib/domain/order-activity";
import { nextStepFor } from "@/lib/domain/job-next-step";
import { DRAFT_DATE_TEXT, issueDateText } from "@/lib/domain/billing";
import { chargeBaseDescription } from "@/lib/domain/invoice-consolidation";
import { priceJob } from "@/lib/domain/job-pricing";
import { initialReceivedVia } from "@/lib/domain/laundry-orders";

/**
 * The pure rules behind Darshan's BA review, Phase 3 (items 3.2–3.10). Each
 * screen reads one of these; a rule stated inside a page is one no test can
 * reach, which is the trap CLAUDE.md records three times over.
 */

describe("Today as an inbox (3.2)", () => {
  it("shows the Owner all five sections, in the brief's order", () => {
    expect(inboxSectionsFor("super_admin")).toEqual(
      ["needs_price", "needs_driver", "problems", "drafts_ready", "overdue"]);
  });

  it("never draws a section the role cannot act on", () => {
    for (const role of ["board", "driver", "customer_service", "warehouse_operator", "finance"] as const) {
      for (const key of inboxSectionsFor(role)) {
        const section = INBOX_SECTIONS.find((s) => s.key === key)!;
        expect(can(role, section.capability)).toBe(true);
      }
    }
    expect(inboxSectionsFor("board")).not.toContain("needs_price");
    expect(inboxSectionsFor("board")).not.toContain("overdue");
  });

  it("says how many more there are, and nothing when the list is whole", () => {
    expect(moreThan(12, 8)).toBe("and 4 more");
    expect(moreThan(8, 8)).toBeNull();
  });
});

describe("the Laundry board (3.3)", () => {
  const job = (status: string, billing = "pending", delivery = true) => ({
    status, billing_status: billing, delivery_required: delivery, assigned_board_id: null,
  });

  it("puts a job on tomorrow's round under Ready, not Out", () => {
    expect(boardColumn(job("assigned"))).toBe("ready");
    expect(boardColumn(job("out_for_delivery"))).toBe("out");
  });

  it("splits finished work on whether the money question is settled", () => {
    expect(boardColumn(job("completed", "awaiting_review"))).toBe("delivered");
    expect(boardColumn(job("completed", "approved"))).toBe("delivered");
    expect(boardColumn(job("completed", "invoice_generated"))).toBe("billed");
    expect(boardColumn(job("completed", "not_billable"))).toBe("billed");
  });

  it("leaves a cancelled job off the board", () => {
    expect(boardColumn(job("cancelled"))).toBeNull();
  });

  it("offers each bulk action only to the jobs it can apply to", () => {
    expect(canMarkReady(job("new"))).toBe(true);
    expect(canMarkReady(job("ready_for_delivery"))).toBe(false);
    expect(canAssign(job("ready_for_delivery"))).toBe(true);
    expect(canAssign(job("ready_for_delivery", "pending", false))).toBe(false);
    expect(canAssign(job("out_for_delivery"))).toBe(false);
    expect(canApprove({ ...job("completed", "awaiting_review"), charge_count: 1 })).toBe(true);
    expect(canApprove({ ...job("completed", "awaiting_review"), charge_count: 0 })).toBe(false);
  });

  it("reads a docket typed by hand as the job number the scanner would send", () => {
    expect(normaliseDocket("LJ00032")).toBe("LJ00032");
    expect(normaliseDocket(" lj 32 ")).toBe("LJ00032");
    expect(normaliseDocket("32")).toBeNull();
    expect(normaliseDocket("LJ-32")).toBeNull();
  });

  it("names a priced job's hold before its billing word", () => {
    expect(boardBillingLabel({ ...job("completed", "awaiting_review"), billing_hold_reason: "needs_price" }))
      .toBe("Needs a price");
    expect(boardBillingLabel(job("completed", "invoice_sent"))).toBe("Sent");
    expect(boardBillingLabel(job("in_progress"))).toBeNull();
  });
});

describe("intake in four actions (3.4)", () => {
  const none = new Set<string>();

  it("promises a round customer's laundry back on their next round, strictly after today", () => {
    // 2026-10-20 is a Tuesday.
    expect(defaultReturnDate({ today: "2026-10-18", roundWeekday: 2, turnaroundDays: 2, holidays: none }))
      .toBe("2026-10-20");
    // Taken in on Tuesday's own visit: back next Tuesday, not this afternoon.
    expect(defaultReturnDate({ today: "2026-10-20", roundWeekday: 2, turnaroundDays: 2, holidays: none }))
      .toBe("2026-10-27");
  });

  it("moves a round's visit off a public holiday", () => {
    expect(defaultReturnDate({
      today: "2026-10-18", roundWeekday: 2, turnaroundDays: 2, holidays: new Set(["2026-10-20"]),
    })).toBe("2026-10-21");
  });

  it("uses the laundry's turnaround for a customer with no round, skipping Sunday", () => {
    // Friday + 2 is a Sunday, so Monday.
    expect(defaultReturnDate({ today: "2026-10-16", roundWeekday: null, turnaroundDays: 2, holidays: none }))
      .toBe("2026-10-19");
  });

  it("carries the counts from the last job and leaves its notes behind", () => {
    const rows = prefillFromLastJob([
      { item_id: "i1", item_type: "towels", quantity_type: "exact", exact_quantity: 40,
        notes: "torn one", custom_description: "black", ownership: "rental" },
      { item_type: "other", quantity_type: "exact", exact_quantity: 3 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item_id: "i1", exact_quantity: 40, notes: null, ownership: "rental" });
  });

  it("never steps a count below one", () => {
    expect(stepQuantity("1", -1)).toBe("1");
    expect(stepQuantity("", 1)).toBe("1");
    expect(stepQuantity("9", 1)).toBe("10");
  });

  it("matches priced lines to rows and leaves an unpriced row empty", () => {
    const rows = [
      { item_id: "a", item_type: "towels" as const },
      { item_id: "b", item_type: "sheets" as const },
      { item_id: "c", item_type: "towels" as const },
    ];
    const lines = [
      { source_item_id: "a", source_laundry_item_type: "towels", unit_price: 0.5, amount: 5 },
      { source_item_id: "c", source_laundry_item_type: "towels", unit_price: 0.5, amount: 2 },
      { source_item_id: null, source_laundry_item_type: null, unit_price: 3, amount: 3 },
    ];
    expect(matchQuoteLines(rows, lines)).toEqual([
      { unitPrice: 0.5, amount: 5 }, null, { unitPrice: 0.5, amount: 2 },
    ]);
  });

  it("defaults a new counter job to dropped off at the counter", () => {
    expect(initialReceivedVia()).toBe("customer_dropoff");
    expect(initialReceivedVia(undefined, "driver_pickup")).toBe("driver_pickup");
  });
});

describe("Settings › How you work (3.4, 3.9)", () => {
  it("leaves the plant off and the turnaround at two days when nothing is stored", () => {
    expect(parseOperations({})).toEqual(DEFAULT_OPERATIONS);
    expect(DEFAULT_OPERATIONS.plantStages).toBe(false);
  });

  it("falls back rather than trusting a bad stored value", () => {
    expect(parseOperations({ operations: { plantStages: "yes", defaultTurnaroundDays: 99 } }))
      .toEqual(DEFAULT_OPERATIONS);
    expect(parseOperations({ operations: { plantStages: true, defaultTurnaroundDays: 4 } }))
      .toEqual({ plantStages: true, defaultTurnaroundDays: 4 });
  });

  it("reads the form, and refuses a turnaround that is not a whole day count", () => {
    expect(readOperationsForm({ plantStages: "on", defaultTurnaroundDays: "3" }))
      .toEqual({ ok: true, value: { plantStages: true, defaultTurnaroundDays: 3 } });
    expect(readOperationsForm({ plantStages: null, defaultTurnaroundDays: "1.5" }).ok).toBe(false);
    expect(readOperationsForm({ plantStages: null, defaultTurnaroundDays: "45" }).ok).toBe(false);
  });
});

describe("the item catalogue (3.5)", () => {
  it("groups items that differ only in case and punctuation", () => {
    expect(normaliseItemName("TOWELS – Black")).toBe(normaliseItemName("towels - black"));
    expect(normaliseItemName("Towel")).not.toBe(normaliseItemName("Towels"));
  });

  it("reports a group only while two of it are still offered", () => {
    const groups = findDuplicateItems([
      { id: "1", item_code: "T25", name: "Towels - Black", status: "active" },
      { id: "2", item_code: "T22", name: "Towels - Black", status: "active" },
      { id: "3", item_code: "S1", name: "Sheets", status: "active" },
      { id: "4", item_code: "S2", name: "sheets", status: "inactive" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((item) => item.item_code)).toEqual(["T22", "T25"]);
  });

  it("describes a charge by the item's name, not the job number", () => {
    const { lines } = priceJob({
      items: [{ item_id: "i1", item_type: "towels", quantity_type: "exact", exact_quantity: 10 }],
      rateLines: [{
        id: "r", agreement_id: "a", item_id: null, laundry_item_type: "towels", charge_type: "wash_only",
        pricing_model: "per_item", unit_price: 0.5, percentage: null, included_quantity: 0, taxable: true,
      }],
      itemNames: new Map([["i1", "Towels - Black"]]),
    });
    expect(lines[0]!.description).toBe("Towels - Black × 10");
  });

  it("strips the quantity from a description so merged lines read as the item", () => {
    expect(chargeBaseDescription("Towels - Black × 10")).toBe("Towels - Black");
    expect(chargeBaseDescription("Towels — 40")).toBe("Towels");
    expect(chargeBaseDescription("4 bags of Towels")).toBe("Towels");
    expect(chargeBaseDescription("Fuel levy")).toBe("Fuel levy");
  });
});

describe("the job page's one next step (3.7)", () => {
  const base = {
    billingStatus: "pending", deliveryRequired: true, boardName: null, deliveryDay: null, needsPrice: false,
  };

  it("names the ordinary next move for each stage", () => {
    expect(nextStepFor({ ...base, status: "new" })).toMatchObject({ kind: "advance", to: "in_progress" });
    expect(nextStepFor({ ...base, status: "ready_for_delivery" })).toMatchObject({ kind: "assign" });
    expect(nextStepFor({ ...base, status: "ready_for_delivery", deliveryRequired: false }))
      .toMatchObject({ kind: "complete" });
  });

  it("says who has it when the next move is the round's", () => {
    expect(nextStepFor({ ...base, status: "assigned", boardName: "Board 1", deliveryDay: "Tue 21 Oct" }))
      .toEqual({ kind: "wait", sentence: "On Board 1 for Tue 21 Oct. It goes out when the round presses Start my day." });
  });

  it("sends a finished job to its charges, by the capability that clears it", () => {
    expect(nextStepFor({ ...base, status: "completed", billingStatus: "awaiting_review", needsPrice: true }))
      .toMatchObject({ kind: "charges", capability: "billing.write" });
    expect(nextStepFor({ ...base, status: "completed", billingStatus: "approved" })).toBeNull();
  });
});

describe("the activity log (3.8)", () => {
  it("names the board and the date on an assignment", () => {
    expect(describeOrderActivity({
      activity_type: "run_assigned", new_value: { board: "Board 1", assigned_delivery_date: "2026-10-21" },
    })).toBe("put it on Board 1 for Wed, 21 Oct 2026.");
  });

  it("reads Start my day as a load confirmation on the round", () => {
    const text = describeOrderActivity({
      activity_type: "status_changed",
      previous_value: { status: "assigned" },
      new_value: { status: "out_for_delivery", load_confirmed_at: "2026-10-18T22:00:00Z",
                   board: "Board 1", date: "2026-10-18" },
    });
    expect(text).toMatch(/^confirmed the load on Board 1 for /);
    expect(text).toMatch(/went out for delivery\.$/);
  });

  it("resolves an older entry's board id to a name, and never prints the id", () => {
    const id = "0f56b000-0000-4000-8000-000000000001";
    expect(describeOrderActivity(
      { activity_type: "run_removed", previous_value: { board: id } },
      { board: () => "Board 2" },
    )).toBe("took it off Board 2; it is waiting for a driver again.");
    expect(describeOrderActivity({ activity_type: "run_removed", previous_value: { board: id } }))
      .not.toContain(id);
  });

  it("records who delivered it, on which round", () => {
    expect(describeOrderActivity(
      { activity_type: "delivered", new_value: { board: "Board 1", driver: "d1", received_by: "Sam" } },
      { driver: () => "Mario Forte" },
    )).toBe("delivered it on Board 1, driven by Mario Forte, received by Sam and completed the job.");
  });
});

describe("a draft's date (3.10)", () => {
  it("does not claim a draft was issued", () => {
    expect(issueDateText("draft", "2026-10-03", (d) => d)).toBe(DRAFT_DATE_TEXT);
    expect(issueDateText("issued", "2026-10-03", (d) => `on ${d}`)).toBe("on 2026-10-03");
    expect(issueDateText("issued", null, (d) => d)).toBe("—");
  });
});
