import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION, autoApproveDecision, autoAssignDecision, cleanPricingVerdict,
  describeMonthEndLine, isDeliveryProofPath, isReadyDraft, isoWeekday, monthEndReport,
  nextDeliveryDay, parseAutomation, readDeliveredQuantities, summariseMonthEnd,
  type MonthEndOutcome,
} from "../automation";
import { checkStartMyDay, startableJobs } from "../run-assignment";

const TENANT = "20000000-0000-4000-8000-000000000001";
const ORDER = "30000000-0000-4000-8000-000000000032";

describe("the automation switches (Phase 2)", () => {
  it("defaults to assign and approve on, issue and email off", () => {
    expect(parseAutomation(undefined)).toEqual(DEFAULT_AUTOMATION);
    expect(DEFAULT_AUTOMATION).toEqual({
      autoAssignOnReady: true, autoApproveCleanJobs: true, autoIssuePerJob: false, emailOnIssue: false,
    });
  });
  it("keeps what is stored and ignores what is not a boolean", () => {
    expect(parseAutomation({ automation: { autoAssignOnReady: false, emailOnIssue: "yes" } }))
      .toEqual({ ...DEFAULT_AUTOMATION, autoAssignOnReady: false });
    expect(parseAutomation({ automation: [] })).toEqual(DEFAULT_AUTOMATION);
  });
});

describe("the next delivery day (brief 2.2)", () => {
  const none = new Set<string>();
  it("reads the weekday without a timezone", () => {
    expect(isoWeekday("2026-10-18")).toBe(7); // a Sunday
    expect(isoWeekday("2026-10-19")).toBe(1);
  });
  it("is the expected day when that is a working day in the future", () => {
    expect(nextDeliveryDay("2026-10-21", "2026-10-18", none)).toBe("2026-10-21");
  });
  it("is today when the expected day has already passed", () => {
    expect(nextDeliveryDay("2026-10-10", "2026-10-20", none)).toBe("2026-10-20");
    expect(nextDeliveryDay(null, "2026-10-20", none)).toBe("2026-10-20");
  });
  it("skips a Sunday and a public holiday", () => {
    expect(nextDeliveryDay("2026-10-18", "2026-10-16", none)).toBe("2026-10-19");
    expect(nextDeliveryDay("2026-10-18", "2026-10-16", new Set(["2026-10-19"]))).toBe("2026-10-20");
  });
});

describe("whether a ready job goes onto a round by itself (brief 2.2)", () => {
  const base = {
    settings: DEFAULT_AUTOMATION, status: "ready_for_delivery", deliveryRequired: true,
    assignedBoardId: null, customerBoardId: "board-1",
  };
  it("assigns to the customer's round", () => {
    expect(autoAssignDecision(base)).toEqual({ assign: true, boardId: "board-1" });
  });
  it("leaves it under Needs a driver when the customer has no round", () => {
    expect(autoAssignDecision({ ...base, customerBoardId: null })).toEqual({ assign: false, skip: "no_round" });
  });
  it("never assigns a customer pickup, an assigned job, or with the switch off", () => {
    expect(autoAssignDecision({ ...base, deliveryRequired: false })).toMatchObject({ skip: "not_delivery" });
    expect(autoAssignDecision({ ...base, assignedBoardId: "board-2" })).toMatchObject({ skip: "already_assigned" });
    expect(autoAssignDecision({ ...base, settings: { ...DEFAULT_AUTOMATION, autoAssignOnReady: false } }))
      .toMatchObject({ skip: "setting_off" });
    expect(autoAssignDecision({ ...base, status: "in_progress" })).toMatchObject({ skip: "not_ready" });
  });
});

describe("a clean job is approved without a person (brief 2.3)", () => {
  const fromList = { pricing_model: "per_item", source_agreement_id: null, unit_price: 0.24, amount: 2.4 };
  const fromCard = { pricing_model: "per_kg", source_agreement_id: "agr-1", unit_price: 3, amount: 30 };

  it("is clean when every line came from a rate card or the price list", () => {
    expect(cleanPricingVerdict([fromList, fromCard], 0)).toEqual({ clean: true });
    expect(cleanPricingVerdict([{ ...fromList, pricing_model: "per_bag" }], 0)).toEqual({ clean: true });
  });
  it("is not clean with an unpriced row, a $0.00 line or the item's own selling price", () => {
    expect(cleanPricingVerdict([fromList], 1)).toEqual({ clean: false, reason: "unpriced" });
    expect(cleanPricingVerdict([{ ...fromList, unit_price: 0, amount: 0 }], 0))
      .toEqual({ clean: false, reason: "zero_priced" });
    expect(cleanPricingVerdict([{ ...fromList, pricing_model: "item_price" }], 0))
      .toEqual({ clean: false, reason: "not_from_rates" });
    expect(cleanPricingVerdict([], 0)).toEqual({ clean: false, reason: "no_lines" });
  });
  it("needs both switches on", () => {
    const verdict = { clean: true } as const;
    expect(autoApproveDecision({ settings: DEFAULT_AUTOMATION, customerAutoApprove: true, verdict }))
      .toEqual({ approve: true });
    expect(autoApproveDecision({ settings: DEFAULT_AUTOMATION, customerAutoApprove: false, verdict }))
      .toMatchObject({ approve: false });
    expect(autoApproveDecision({
      settings: { ...DEFAULT_AUTOMATION, autoApproveCleanJobs: false }, customerAutoApprove: true, verdict,
    })).toMatchObject({ approve: false });
  });
  it("says why a job was left for a person", () => {
    expect(autoApproveDecision({
      settings: DEFAULT_AUTOMATION, customerAutoApprove: true,
      verdict: { clean: false, reason: "zero_priced" },
    })).toEqual({ approve: false, why: "a line is priced at $0.00" });
  });
});

describe("Start my day (brief 2.4)", () => {
  it("takes every assigned job, confirmed or not", () => {
    const jobs = [
      { status: "assigned", load_confirmed_at: null },
      { status: "assigned", load_confirmed_at: "2026-10-18T22:00:00Z" },
      { status: "out_for_delivery", load_confirmed_at: "2026-10-18T22:00:00Z" },
    ];
    expect(startableJobs(jobs)).toHaveLength(2);
    expect(checkStartMyDay(jobs)).toMatchObject({ ok: true });
  });
  it("says so when everything is already out, or nothing is assigned", () => {
    expect(checkStartMyDay([{ status: "out_for_delivery" }]))
      .toEqual({ ok: false, reason: "Everything for this day is already out for delivery." });
    expect(checkStartMyDay([])).toEqual({ ok: false, reason: "There is nothing assigned to take out for this day." });
  });
});

describe("what the round handed over (brief 2.4)", () => {
  const items = [{ id: "a", takenIn: 10 }, { id: "b", takenIn: null }];
  it("defaults each line to what was taken in", () => {
    const read = readDeliveredQuantities(items, {}, false);
    expect(read).toMatchObject({ ok: true, short: false });
    if (read.ok) expect([...read.quantities]).toEqual([["a", 10], ["b", null]]);
  });
  it("calls a lower count short whether or not the box was ticked", () => {
    expect(readDeliveredQuantities(items, { delivered_a: "8" }, false)).toMatchObject({ ok: true, short: true });
    expect(readDeliveredQuantities(items, {}, true)).toMatchObject({ ok: true, short: true });
  });
  it("refuses more than was taken in, and a number it cannot read", () => {
    expect(readDeliveredQuantities(items, { delivered_a: "11" }, false)).toMatchObject({ ok: false });
    expect(readDeliveredQuantities(items, { delivered_a: "ten" }, false)).toMatchObject({ ok: false });
  });
  it("only accepts proof stored under this job's own folder", () => {
    expect(isDeliveryProofPath(`${TENANT}/delivery/${ORDER}/signature-0.png`, TENANT, ORDER)).toBe(true);
    expect(isDeliveryProofPath(`${TENANT}/delivery/other-job/signature-0.png`, TENANT, ORDER)).toBe(false);
    expect(isDeliveryProofPath(`another-tenant/delivery/${ORDER}/photo-0.jpg`, TENANT, ORDER)).toBe(false);
    expect(isDeliveryProofPath(`${TENANT}/delivery/${ORDER}/../x.png`, TENANT, ORDER)).toBe(false);
  });
});

describe("month end: issue and send all ready (brief 2.5)", () => {
  it("covers a draft whose period has ended and that carries lines", () => {
    expect(isReadyDraft({ periodEnd: "2026-09-30", lineCount: 3 }, "2026-10-18")).toBe(true);
    expect(isReadyDraft({ periodEnd: "2026-10-31", lineCount: 3 }, "2026-10-18")).toBe(false);
    expect(isReadyDraft({ periodEnd: "2026-09-30", lineCount: 0 }, "2026-10-18")).toBe(false);
    expect(isReadyDraft({ periodEnd: null, lineCount: 3 }, "2026-10-18")).toBe(false);
  });
  it("reports each invoice and sums the run", () => {
    const outcomes: MonthEndOutcome[] = [
      { invoiceNumber: "INV00010", issued: "issued", emailed: "sent", xero: "pushed" },
      { invoiceNumber: "INV00011", issued: "issued", emailed: "no_address", xero: "failed" },
      { invoiceNumber: "INV00012", issued: "already", emailed: "not_issued", xero: "not_issued" },
    ];
    expect(describeMonthEndLine(outcomes[0]!)).toBe("INV00010: issued, emailed, sent to Xero");
    expect(describeMonthEndLine(outcomes[1]!)).toBe("INV00011: issued, no invoice email on file, Xero refused it");
    expect(summariseMonthEnd(outcomes)).toBe(
      "Issued 2 of 3. 1 had already been issued. Emailed 1. 1 could not be sent to Xero — open them to retry.");
    expect(monthEndReport(outcomes)).toContain("INV00012: already issued, left alone");
  });
});
