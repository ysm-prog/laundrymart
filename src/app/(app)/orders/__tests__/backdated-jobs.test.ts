import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Laundry can be taken in on an earlier day, by anybody who may take it in,
 * and a customer's record opens the job form with them already chosen
 * (2026-11-23).
 *
 * Two things stopped a job being entered after the fact: the server refused a
 * past received date unless the caller held `orders.manage`, and the form set
 * `min` = today on the return dates, so the browser refused a delivery date
 * earlier than today before anything was posted — which every retrospective job
 * has. A future receipt stays refused for everybody (brief 1.5).
 *
 * Read the source, for the reason `customer-picker.test.ts` gives: the action
 * and the pages reach `next/headers` and cannot be imported into vitest.
 */

const app = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(app, file), "utf8");

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\}/g, "{}")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("backdated laundry jobs", () => {
  const actions = code(read("orders/actions.ts"));
  const form = code(read("orders/job-form.tsx"));

  it("does not tie an earlier received date to a manager", () => {
    expect(actions).not.toMatch(/received_date\s*<\s*businessToday\(\)/);
    expect(actions).not.toMatch(/Only a manager can (record|move)/);
  });

  it("still refuses a received date in the future, on create and on edit", () => {
    expect(actions.match(/receivedInFuture\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("floors the return dates at the received date, not at today", () => {
    expect(form).not.toMatch(/min=\{businessToday\(\)\}/);
    expect(form).toMatch(/name="expected_delivery_date"[^>]*min=\{received/);
    expect(form).toMatch(/name="expected_collection_date"[^>]*min=\{received/);
  });

  it("still caps the received date at today in the form", () => {
    expect(form).toMatch(/name="received_date"[\s\S]{0,200}max=\{/);
  });
});

describe("Take laundry on a customer's record", () => {
  const page = code(read("customers/[id]/page.tsx"));

  it("opens the ordinary job form with that customer chosen", () => {
    expect(page).toMatch(/href=\{`\/orders\/new\?customer=\$\{id\}`\}[^>]*>Take laundry</);
  });

  it("is offered only to a role that may take laundry in", () => {
    expect(page).toMatch(/can\(session\.role, "orders\.write"\)\s*\?\s*<ButtonLink href=\{`\/orders\/new\?customer=\$\{id\}`\}/);
  });

  it("lands on a page that reads the customer it was handed", () => {
    const newPage = code(read("orders/new/page.tsx"));
    expect(newPage).toMatch(/params\.customer/);
    expect(newPage).toMatch(/defaultCustomerId=\{chosenCustomer\}/);
  });
});
