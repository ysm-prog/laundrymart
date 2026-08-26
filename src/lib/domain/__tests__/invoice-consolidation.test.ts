import { describe, expect, it } from "vitest";
import {
  buildServiceBreakdown, consolidateChargeLines, consolidatedSubtotal, consolidationKey,
  isMergeable, itemTotals, type ChargeEntry, type ConsolidatableCharge,
} from "@/lib/domain/invoice-consolidation";

const charge = (over: Partial<ConsolidatableCharge> = {}): ConsolidatableCharge => ({
  description: "Towels",
  charge_type: "wash_only",
  quantity: 10,
  unit_price: 1.5,
  amount: 15,
  taxable: true,
  source_item_id: null,
  source_agreement_id: null,
  source_laundry_item_type: "towels",
  ...over,
});

const entry = (
  jobId: string, orderNumber: string, date: string | null, over: Partial<ConsolidatableCharge> = {},
): ChargeEntry => ({ job: { id: jobId, orderNumber, date }, charge: charge(over) });

describe("isMergeable", () => {
  it("merges anything naming a kind of laundry", () => {
    expect(isMergeable(charge({ source_laundry_item_type: "towels" }))).toBe(true);
    expect(isMergeable(charge({ source_laundry_item_type: null, source_item_id: "i1" }))).toBe(true);
  });

  it("refuses a charge with no item identity — a levy is an event, not a total", () => {
    const levy = charge({
      charge_type: "fuel_levy", description: "Fuel levy",
      source_item_id: null, source_laundry_item_type: null,
    });
    expect(isMergeable(levy)).toBe(false);
    expect(consolidationKey(levy)).toBeNull();
  });
});

describe("consolidationKey", () => {
  it("prefers the item id over the kind of laundry", () => {
    const key = consolidationKey(charge({ source_item_id: "item-1", source_laundry_item_type: "towels" }));
    expect(key).toContain("item:item-1");
    expect(key).not.toContain("type:towels");
  });

  it("puts the unit price in the key, so two rates stay two lines", () => {
    const a = consolidationKey(charge({ unit_price: 1.5 }));
    const b = consolidationKey(charge({ unit_price: 1.75 }));
    expect(a).not.toEqual(b);
  });

  it("puts GST in the key", () => {
    expect(consolidationKey(charge({ taxable: true })))
      .not.toEqual(consolidationKey(charge({ taxable: false })));
  });
});

describe("consolidationKey · the account (0039)", () => {
  it("keeps two accounts apart, even for the same item at the same rate", () => {
    // The failure this prevents: two charges for the same towels, one coded to
    // 4-1100 and one overridden to 4-1200, merged into one line — which posts
    // the whole amount to whichever account happened to be first.
    expect(consolidationKey(charge({ gl_account_id: "acct-a" })))
      .not.toBe(consolidationKey(charge({ gl_account_id: "acct-b" })));
  });

  it("treats an uncoded charge as its own bucket, not as any account", () => {
    expect(consolidationKey(charge({ gl_account_id: null })))
      .not.toBe(consolidationKey(charge({ gl_account_id: "acct-a" })));
    // Absent and explicitly null are the same absence — the payload can spell it
    // either way and neither should split a line in two.
    expect(consolidationKey(charge({ gl_account_id: null })))
      .toBe(consolidationKey(charge({})));
  });

  it("still merges two charges that agree about the account", () => {
    expect(consolidationKey(charge({ gl_account_id: "acct-a" })))
      .toBe(consolidationKey(charge({ gl_account_id: "acct-a" })));
  });
});

describe("consolidateChargeLines · the account (0039)", () => {
  it("carries the account onto the rolled-up line", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ00001", "2026-08-01", { gl_account_id: "acct-a" }),
      entry("j2", "LJ00002", "2026-08-02", { gl_account_id: "acct-a" }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.gl_account_id).toBe("acct-a");
    expect(lines[0]!.merged).toBe(true);
    expect(lines[0]!.quantity).toBe(20);
  });

  it("splits a line when the two charges code differently", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ00001", "2026-08-01", { gl_account_id: "acct-a" }),
      entry("j2", "LJ00002", "2026-08-02", { gl_account_id: "acct-b" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.gl_account_id)).toEqual(["acct-a", "acct-b"]);
    // And the money still adds up to what the charges said.
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(30);
  });

  it("is null on a line whose charges carry no account", () => {
    const lines = consolidateChargeLines([entry("j1", "LJ00001", "2026-08-01")]);
    expect(lines[0]!.gl_account_id).toBeNull();
  });
});

describe("consolidateChargeLines", () => {
  it("rolls three jobs' towels into one line carrying the total", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02", { quantity: 150, amount: 225 }),
      entry("j2", "LJ002", "2026-08-05", { quantity: 130, amount: 195 }),
      entry("j3", "LJ003", "2026-08-09", { quantity: 180, amount: 270 }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(460);
    expect(lines[0]!.amount).toBe(690);
    expect(lines[0]!.merged).toBe(true);
    expect(lines[0]!.contributions.map((c) => c.orderNumber)).toEqual(["LJ001", "LJ002", "LJ003"]);
  });

  it("drops the job-number prefix — a rolled-up line belongs to several jobs", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02"),
      entry("j2", "LJ002", "2026-08-05"),
    ]);
    expect(lines[0]!.description).toBe("Towels");
  });

  it("keeps different kinds of laundry apart", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02", { source_laundry_item_type: "towels", description: "Towels" }),
      entry("j1", "LJ001", "2026-08-02", { source_laundry_item_type: "sheets", description: "Sheets" }),
      entry("j2", "LJ002", "2026-08-05", { source_laundry_item_type: "towels", description: "Towels" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.description)).toEqual(["Towels", "Sheets"]);
    expect(lines[0]!.quantity).toBe(20);
  });

  it("keeps a mid-period rate change as two lines at the two real rates", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02", { unit_price: 1.5, quantity: 100, amount: 150 }),
      entry("j2", "LJ002", "2026-08-20", { unit_price: 1.75, quantity: 100, amount: 175 }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.unit_price)).toEqual([1.5, 1.75]);
  });

  it("never merges two fuel levies — three deliveries were levied three times", () => {
    const levy = { charge_type: "fuel_levy", description: "Fuel levy",
      source_laundry_item_type: null, source_item_id: null, quantity: 1, unit_price: 5, amount: 5 };
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02", levy),
      entry("j2", "LJ002", "2026-08-05", levy),
      entry("j3", "LJ003", "2026-08-09", levy),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.merged === false)).toBe(true);
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);
  });

  it("sums amounts rather than recomputing them, so the invoice matches the snapshots", () => {
    // 3 × $0.335 rounds to $1.01 line by line and to $1.005 → $1.01 recomputed;
    // the point is that the total equals what was frozen, whatever the rounding.
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02", { quantity: 1, unit_price: 0.335, amount: 0.34 }),
      entry("j2", "LJ002", "2026-08-05", { quantity: 1, unit_price: 0.335, amount: 0.34 }),
      entry("j3", "LJ003", "2026-08-09", { quantity: 1, unit_price: 0.335, amount: 0.34 }),
    ]);
    expect(lines[0]!.amount).toBe(1.02);
  });

  it("is empty for no entries", () => {
    expect(consolidateChargeLines([])).toEqual([]);
    expect(consolidatedSubtotal([])).toBe(0);
  });

  it("totals to the sum of every entry's amount", () => {
    const lines = consolidateChargeLines([
      entry("j1", "LJ001", "2026-08-02", { amount: 15 }),
      entry("j2", "LJ002", "2026-08-05", { amount: 20, source_laundry_item_type: "sheets" }),
      entry("j3", "LJ003", "2026-08-09", { amount: 5, charge_type: "fuel_levy",
        source_laundry_item_type: null, source_item_id: null }),
    ]);
    expect(consolidatedSubtotal(lines)).toBe(40);
  });
});

describe("buildServiceBreakdown", () => {
  it("groups jobs into ISO weeks, in order", () => {
    const weeks = buildServiceBreakdown([
      entry("j1", "LJ001", "2026-08-04", { amount: 10 }),   // Tue, week of Mon 3 Aug
      entry("j2", "LJ002", "2026-08-06", { amount: 20 }),   // Thu, same week
      entry("j3", "LJ003", "2026-08-11", { amount: 30 }),   // Tue, week of Mon 10 Aug
    ]);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-08-03", "2026-08-10"]);
    expect(weeks[0]!.jobs.map((j) => j.orderNumber)).toEqual(["LJ001", "LJ002"]);
    expect(weeks[0]!.total).toBe(30);
    expect(weeks[1]!.total).toBe(30);
  });

  it("keeps every item of a job together with the job's total", () => {
    const weeks = buildServiceBreakdown([
      entry("j1", "LJ001", "2026-08-04", { description: "Towels", amount: 10 }),
      entry("j1", "LJ001", "2026-08-04", { description: "Sheets", amount: 15 }),
    ]);
    expect(weeks[0]!.jobs).toHaveLength(1);
    expect(weeks[0]!.jobs[0]!.items.map((i) => i.description)).toEqual(["Towels", "Sheets"]);
    expect(weeks[0]!.jobs[0]!.total).toBe(25);
  });

  it("shows an undated job last rather than dropping it", () => {
    const weeks = buildServiceBreakdown([
      entry("j0", "LJ000", null, { amount: 5 }),
      entry("j1", "LJ001", "2026-08-04", { amount: 10 }),
    ]);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-08-03", null]);
    expect(weeks[1]!.jobs[0]!.orderNumber).toBe("LJ000");
  });

  it("sorts jobs within a week by date, then by number", () => {
    const weeks = buildServiceBreakdown([
      entry("j2", "LJ002", "2026-08-06"),
      entry("j1", "LJ001", "2026-08-04"),
    ]);
    expect(weeks[0]!.jobs.map((j) => j.orderNumber)).toEqual(["LJ001", "LJ002"]);
  });
});

describe("itemTotals", () => {
  it("totals a kind of laundry across the period, ignoring rate changes", () => {
    const totals = itemTotals([
      entry("j1", "LJ001", "2026-08-02", { quantity: 150, unit_price: 1.5, amount: 225 }),
      entry("j2", "LJ002", "2026-08-20", { quantity: 130, unit_price: 1.75, amount: 227.5 }),
    ]);
    expect(totals).toHaveLength(1);
    expect(totals[0]!.quantity).toBe(280);
    expect(totals[0]!.amount).toBe(452.5);
  });

  it("leaves non-item charges out — a levy is not a quantity of laundry", () => {
    const totals = itemTotals([
      entry("j1", "LJ001", "2026-08-02", { quantity: 150, amount: 225 }),
      entry("j1", "LJ001", "2026-08-02", { charge_type: "fuel_levy", description: "Fuel levy",
        source_laundry_item_type: null, source_item_id: null, quantity: 1, amount: 5 }),
    ]);
    expect(totals).toHaveLength(1);
    expect(totals[0]!.description).toBe("Towels");
  });
});
