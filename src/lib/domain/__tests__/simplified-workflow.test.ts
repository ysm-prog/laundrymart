import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPERATIONS, parseOperations, readOperationsForm,
} from "@/lib/domain/operations-settings";
import {
  actionsFor, buildStatusTrack, checkTransition, nextStatuses,
} from "@/lib/domain/laundry-orders";
import { nextStepFor } from "@/lib/domain/job-next-step";
import { describeOrderActivity } from "@/lib/domain/order-activity";

/**
 * Change request 3 (2026-11-23): a new laundry job is completed and ready to
 * invoice as it is saved, behind a setting that keeps the full process.
 */

const ALL = () => true;

describe("the workflow setting", () => {
  it("is simplified when nothing is stored — the client's default", () => {
    expect(DEFAULT_OPERATIONS.workflow).toBe("simplified");
    expect(parseOperations({}).workflow).toBe("simplified");
    expect(parseOperations(null).workflow).toBe("simplified");
    // The live laundry has saved other operations settings but never this one.
    expect(parseOperations({ operations: { plantStages: true } }).workflow).toBe("simplified");
  });

  it("keeps the full process when it is chosen", () => {
    expect(parseOperations({ operations: { workflow: "full" } }).workflow).toBe("full");
  });

  it("reads an unknown stored value as the default rather than as full", () => {
    expect(parseOperations({ operations: { workflow: "partial" } }).workflow).toBe("simplified");
  });

  it("reads the form, and refuses a value it does not know", () => {
    const base = { plantStages: null, defaultTurnaroundDays: "2" };
    expect(readOperationsForm({ ...base, workflow: "full" }))
      .toMatchObject({ ok: true, value: { workflow: "full" } });
    expect(readOperationsForm({ ...base, workflow: "simplified" }))
      .toMatchObject({ ok: true, value: { workflow: "simplified" } });
    expect(readOperationsForm({ ...base, workflow: "sideways" }).ok).toBe(false);
    // A form that predates the field cannot switch a laundry to full by omission.
    expect(readOperationsForm(base)).toMatchObject({ ok: true, value: { workflow: "simplified" } });
  });
});

describe("rule 4 under each workflow (mirrors 0065)", () => {
  it("lets a delivery job be completed from every plant stage when simplified", () => {
    for (const from of ["new", "in_progress", "ready_for_delivery"] as const) {
      expect(checkTransition(from, "completed", true, { simplified: true })).toEqual({ ok: true });
    }
  });

  it("refuses the same moves in the full workflow, which is also what no option means", () => {
    for (const from of ["new", "in_progress", "ready_for_delivery"] as const) {
      expect(checkTransition(from, "completed", true, { simplified: false }).ok).toBe(false);
      expect(checkTransition(from, "completed", true).ok).toBe(false);
    }
  });

  it("still sends a job that is on a round out before it is completed", () => {
    expect(checkTransition("assigned", "completed", true, { simplified: true }).ok).toBe(false);
    expect(checkTransition("out_for_delivery", "completed", true, { simplified: true }))
      .toEqual({ ok: true });
  });

  it("changes nothing else: terminal stays terminal and the other three rules hold", () => {
    expect(checkTransition("completed", "new", true, { simplified: true }).ok).toBe(false);
    expect(checkTransition("cancelled", "completed", true, { simplified: true }).ok).toBe(false);
    expect(checkTransition("new", "out_for_delivery", true, { simplified: true }).ok).toBe(false);
    expect(checkTransition("new", "assigned", true, { simplified: true }).ok).toBe(false);
    expect(checkTransition("new", "assigned", false, { simplified: true }).ok).toBe(false);
    // The original stages are all still reachable in the simplified workflow.
    expect(nextStatuses("ready_for_delivery", true, { simplified: true })).toContain("assigned");
  });

  it("offers the job page's Mark as delivered from the shelf only when simplified", () => {
    const keys = (simplified: boolean) =>
      actionsFor("ready_for_delivery", true, { simplified }).map((action) => action.key);
    expect(keys(true)).toContain("deliver");
    expect(keys(false)).not.toContain("deliver");
  });

  it("draws the track with the same answer", () => {
    const completed = (simplified: boolean) =>
      buildStatusTrack({ status: "new", deliveryRequired: true, simplified }, ALL)
        .find((step) => step.status === "completed");
    // Not a jump either way: completing captures who and when on its own form.
    expect(completed(true)).toMatchObject({ jump: false });
    expect(completed(true)?.note).not.toMatch(/send it out first/);
    expect(completed(false)?.note).toMatch(/send it out first/);
  });

  it("names completing, not a round, as a ready delivery job's next step", () => {
    const base = {
      status: "ready_for_delivery", billingStatus: "pending", deliveryRequired: true,
      boardName: null, deliveryDay: null, needsPrice: false,
    };
    expect(nextStepFor({ ...base, simplified: true })).toMatchObject({ kind: "complete" });
    expect(nextStepFor(base)).toMatchObject({ kind: "assign" });
  });
});

describe("the timeline", () => {
  it("says a completion on save was a decision, not a delivery", () => {
    const sentence = describeOrderActivity({
      activity_type: "status_changed",
      previous_value: { status: "new" },
      new_value: { status: "completed", workflow: "simplified" },
    } as never, {});
    expect(sentence).toMatch(/completed and ready to invoice/);
    expect(sentence).not.toMatch(/deliver/);
  });
});

/**
 * The seam, read from source: `createOrder` and the job pages reach
 * `next/headers`, so they cannot be imported here — the trap this repo records
 * three times over.
 */
describe("the wiring", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const actions = read("src/app/(app)/orders/actions.ts");
  const create = actions.slice(actions.indexOf("export async function createOrder"),
                               actions.indexOf("export async function updateOrder"));

  it("completes a new job through the one completion routine, gated on the setting", () => {
    expect(create).toMatch(/laundryWorkflow\(supabase, session\.tenantId\)\s*===\s*"simplified"/);
    expect(create).toMatch(/completeLaundryOrder\(/);
    expect(create).toMatch(/simplified: true/);
    expect(create).toMatch(/recordHandover: false/);
  });

  it("completes it as at the day it was received, so it bills to that month", () => {
    expect(create).toMatch(/at: receivedAt/);
  });

  it("never issues or sends an invoice from job creation", () => {
    expect(create).not.toMatch(/issueOneInvoice|sendInvoice|placeApprovedJobs|generateInvoices/);
  });

  it("does not touch an edit: updateOrder never completes a job", () => {
    const update = actions.slice(actions.indexOf("export async function updateOrder"),
                                 actions.indexOf("export async function advanceOrder"));
    expect(update).not.toMatch(/completeLaundryOrder|laundryWorkflow/);
  });

  it("posts the field the settings action reads", () => {
    const page = read("src/app/(app)/admin/operations/page.tsx");
    const action = read("src/app/(app)/admin/operations/actions.ts");
    expect(page).toMatch(/name="workflow"/);
    expect(action).toMatch(/formData\.get\("workflow"\)/);
  });

  it("names the tenant when it reads the setting", () => {
    expect(read("src/lib/orders/workflow.ts")).toMatch(/\.eq\("id", tenantId\)/);
  });
});
