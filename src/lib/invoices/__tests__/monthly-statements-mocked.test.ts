import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, filteredOn } from "@/test-support/fake-supabase";

/**
 * The monthly statement run, with the statement loader and the delivery mocked
 * out, so nothing is rendered and no email leaves (brief ground rule 5). What is
 * under test is the run's own rules: when it fires, who it skips, the date it
 * makes the statement up to, and the marker that stops the five daily sweeps
 * sending a customer the same statement five times.
 */

const mocks = vi.hoisted(() => ({
  configured: true,
  list: [] as unknown[],
  loadStatementList: vi.fn(),
  deliverStatement: vi.fn(),
}));

vi.mock("@/lib/email/send", () => ({ emailIsConfigured: () => mocks.configured }));
vi.mock("../statement", () => ({
  loadStatementList: mocks.loadStatementList,
  deliverStatement: mocks.deliverStatement,
}));

import { sendMonthlyStatements } from "../monthly-statements";

const TENANT = "20000000-0000-4000-8000-000000000001";
const ON = { automation: { monthlyStatements: true } };

const row = (customerId: string, over: Record<string, unknown> = {}) => ({
  customerId, name: customerId, customerNumber: "CUST", billingEmail: `${customerId}@example.com`,
  phone: null, contactName: null, remindersEnabled: true,
  statement: { rows: [{ id: "inv" }], total: 10 }, ...over,
});

function harness(alreadySent: string[] = []) {
  return fakeSupabase({
    audit_logs: (query) => (query.op === "select"
      ? alreadySent.map((entity_id) => ({ entity_id }))
      : null),
  });
}

beforeEach(() => {
  mocks.configured = true;
  mocks.loadStatementList.mockImplementation(async () => mocks.list);
  mocks.deliverStatement.mockImplementation(async (_c: unknown, _t: string, id: string) => ({
    kind: "sent", customer: id, recipient: `${id}@example.com`, providerId: `re_${id}`,
    total: 10, invoices: 1, excluded: 0,
  }));
});
afterEach(() => { vi.clearAllMocks(); mocks.list = []; });

describe("sendMonthlyStatements", () => {
  it("does nothing while the laundry has not turned it on", async () => {
    const fake = harness();
    mocks.list = [row("a")];
    const tally = await sendMonthlyStatements(fake.client as never, { id: TENANT, settings: {} }, "2026-11-01");
    expect(tally).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(mocks.loadStatementList).not.toHaveBeenCalled();
  });

  it("does nothing with no mail provider, or outside the first days of the month", async () => {
    mocks.list = [row("a")];
    mocks.configured = false;
    await sendMonthlyStatements(harness().client as never, { id: TENANT, settings: ON }, "2026-11-01");
    mocks.configured = true;
    await sendMonthlyStatements(harness().client as never, { id: TENANT, settings: ON }, "2026-11-04");
    expect(mocks.loadStatementList).not.toHaveBeenCalled();
    expect(mocks.deliverStatement).not.toHaveBeenCalled();
  });

  it("sends each customer last month's statement once, and marks it", async () => {
    const fake = harness(["already"]);
    mocks.list = [
      row("a"),
      row("already"),
      row("nomail", { billingEmail: null }),
      row("optedout", { remindersEnabled: false }),
      row("square", { statement: { rows: [], total: 0 } }),
    ];
    const tally = await sendMonthlyStatements(fake.client as never, { id: TENANT, settings: ON }, "2026-11-02");

    // Made up to the last day of October, leaving later invoices off.
    expect(mocks.loadStatementList).toHaveBeenCalledWith(
      fake.client, TENANT, { asAt: "2026-10-31", upToAsAt: true });
    expect(mocks.deliverStatement).toHaveBeenCalledTimes(1);
    expect(mocks.deliverStatement).toHaveBeenCalledWith(
      fake.client, TENANT, "a", { asAt: "2026-10-31", upToAsAt: true });
    // A customer who owes nothing is not even listed; three are skipped by rule.
    expect(tally).toEqual({ sent: 1, failed: 0, skipped: 3 });

    const read = fake.queries.find((q) => q.table === "audit_logs" && q.op === "select")!;
    expect(filteredOn(read, "tenant_id", TENANT)).toBe(true);
    expect(filteredOn(read, "metadata->>monthlyStatement", "2026-10")).toBe(true);

    const [write] = fake.writes("audit_logs");
    expect(write!.values).toMatchObject({
      tenant_id: TENANT, actor_id: null, entity: "customer", entity_id: "a", action: "send",
      metadata: { monthlyStatement: "2026-10", asAt: "2026-10-31", providerId: "re_a" },
    });
  });

  it("writes no marker when a send fails, so the next sweep tries again", async () => {
    const fake = harness();
    mocks.list = [row("a")];
    mocks.deliverStatement.mockResolvedValueOnce({
      kind: "failed", customer: "a", recipient: "a@example.com", reason: "the address bounced",
    });
    const tally = await sendMonthlyStatements(fake.client as never, { id: TENANT, settings: ON }, "2026-11-01");
    expect(tally).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const [write] = fake.writes("audit_logs");
    expect(write!.values).toMatchObject({ action: "send_failed", metadata: { attemptedMonthlyStatement: "2026-10" } });
    expect((write!.values as { metadata: Record<string, unknown> }).metadata.monthlyStatement).toBeUndefined();
  });
});
