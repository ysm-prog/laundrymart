import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The month-end run names its tenant on every read it makes.
 *
 * A narrower property than `tenant-scoped-reads.test.ts` polices, and it needs
 * its own guard because it is a different *shape*: that sweep catches a read
 * keyed on an id posted from a form, and none of this action's reads are keyed
 * on an id at all. They are keyed on a **period** — every active agreement, every
 * approved job, every weighed collection in a date window — which is precisely
 * what makes them dangerous. `is_member()` is true of every laundry for a
 * platform admin (0019), and both real owner logins hold that role, so an
 * unfiltered sweep here would raise one laundry's invoices from another
 * laundry's contracts and jobs. Blast radius is zero while there is one tenancy
 * (§11) and total the day there are two, which is exactly when nobody would be
 * looking for it.
 *
 * Source rather than behaviour, for `one-door.test.ts`'s reason: this is a
 * `"use server"` module that reaches `lib/env`, so vitest can neither import it
 * nor render its caller.
 */

const ACTIONS = join(__dirname, "..", "actions.ts");

/**
 * Just `generateInvoices`, from its signature to the next top-level export, with
 * its comments stripped.
 *
 * Stripped for `email-branding.test.ts`'s reason: this action's comments quote
 * the message it used to print, so a sweep reading them would fail on the very
 * paragraph explaining the fix — and the obvious way to make it pass would be to
 * delete the explanation.
 */
function monthEndRun(): string {
  const source = readFileSync(ACTIONS, "utf8");
  const start = source.indexOf("export async function generateInvoices(");
  expect(start, "generateInvoices must still exist under that name").toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return source
    .slice(start, next === -1 ? undefined : next)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Each `.from("table")` and the chained statement it belongs to. */
function reads(body: string): Array<{ table: string; statement: string }> {
  const out: Array<{ table: string; statement: string }> = [];
  for (const match of body.matchAll(/\.from\(\s*"([a-z_]+)"/g)) {
    const table = match[1];
    if (table === undefined) continue;
    const tail = body.slice(match.index ?? 0);
    const end = /;\s*\n/.exec(tail);
    out.push({ table, statement: end ? tail.slice(0, end.index) : tail.slice(0, 600) });
  }
  return out;
}

describe("the month-end invoice run", () => {
  const body = monthEndRun();

  it("was found, and reads the tables the run is built on", () => {
    // Non-vacuous: an empty slice would satisfy every assertion below.
    const tables = new Set(reads(body).map((r) => r.table));
    for (const table of ["service_agreements", "laundry_orders", "invoices"]) {
      expect(tables, `expected the run to read ${table}`).toContain(table);
    }
  });

  it("filters every read by tenant", () => {
    const unscoped = reads(body)
      // A write carries its own `tenant_id` in the row it inserts.
      .filter((r) => !/\.(insert|update|upsert|delete)\(/.test(r.statement))
      .filter((r) => !r.statement.includes("tenant_id"))
      .map((r) => r.table);
    expect(unscoped).toEqual([]);
  });

  it("bills only approved jobs", () => {
    // The rule the report below has to explain rather than contradict: a job
    // nobody has reviewed is not billed, and that is deliberate.
    expect(body).toContain('.eq("billing_status", "approved")');
  });

  it("says what is waiting instead of reciting a zero", () => {
    // "Nothing to invoice — 0 customer(s) were already billed for that period,
    // and no approved job was waiting" was true, mentioned a zero nobody asked
    // about, and named no remedy. The count that matters is the work sitting in
    // review, which is why the run now looks for it.
    expect(body).toContain("describeWorkAwaitingApproval");
    expect(body).toContain('.eq("billing_status", "awaiting_review")');
    expect(body).not.toContain("no approved job was waiting");
  });
});
