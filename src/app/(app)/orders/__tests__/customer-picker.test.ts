import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The counter's customer picker offers the customer database, not a subset of
 * its own choosing.
 *
 * Reported from the deployed app as "customer doesn't pick up when we create
 * new laundry from customer database", and the cause was one clause:
 * `form-data.ts` narrowed to `["active", "prospect", "on_hold"]` while the
 * Customers screen listed all five statuses and `createOrder` checked none of
 * them. The laundry's MYOB import had left 508 of its 511 customers `inactive`,
 * so the search box could find three businesses out of five hundred — and said
 * nothing, so a customer that was on file read exactly like one that was not.
 *
 * Read the source rather than the behaviour, for the reason `one-door.test.ts`
 * gives: `form-data.ts` reaches `requireSession` → `next/headers`, so it cannot
 * be imported into vitest and this clause is otherwise unreachable from a test.
 */

const app = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(app, file), "utf8");

/** Strip comments, or the paragraph *explaining* the old clause would fail the sweep. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** `.neq("status", "archived")` — the line the invoice and contract pickers draw. */
const EXCLUDES_ARCHIVED = /\.neq\(\s*["']status["']\s*,\s*["']archived["']\s*\)/;

/** `.in("status", [...])` — the allow-list shape that hid a laundry's own customers. */
const ALLOW_LIST = /\.in\(\s*["']status["']\s*,\s*\[/;

describe("the job form's customer picker", () => {
  const source = code(read("orders/form-data.ts"));

  it("draws the same line as every other customer picker", () => {
    // Non-vacuous: prove the pattern is the house one by finding it in the two
    // pickers that already had it, before asserting the job form now agrees.
    expect(code(read("invoices/page.tsx"))).toMatch(EXCLUDES_ARCHIVED);
    expect(code(read("agreements/new/page.tsx"))).toMatch(EXCLUDES_ARCHIVED);

    expect(source).toMatch(EXCLUDES_ARCHIVED);
  });

  it("holds no allow-list of statuses of its own", () => {
    // The whole defect. An allow-list here is a customer the Customers screen
    // shows and this screen refuses, with nothing on screen saying why.
    expect(source).not.toMatch(ALLOW_LIST);
  });

  it("selects the status it is about to show", () => {
    // The select string is hand-maintained, so a column the form renders and
    // the query never fetches is invisible to the typechecker — the picker
    // would simply stop marking anyone as on hold. Both reads are asserted:
    // the column requested, and the field handed to the form.
    //
    // Asserted against the *declaration*, not the file: the first draft of this
    // matched `CUSTOMER_COLUMNS` followed by `status` anywhere later on, which
    // the `.neq("status", …)` clause two lines down satisfies on its own. It
    // passed with the column removed.
    const columns = source.match(/CUSTOMER_COLUMNS\s*=\s*([\s\S]*?);/)?.[1];
    expect(columns, "CUSTOMER_COLUMNS must still be a single declaration").toBeTruthy();
    expect(columns).toMatch(/\bstatus\b/);
    expect(source).toMatch(/status:\s*customer\.status/);
  });

  it("fetches a customer it is handed without judging their status", () => {
    // The customer's own record page links straight here with `?customer=<id>`,
    // and that customer may be inactive — which is exactly how this defect hid,
    // since that door always worked while the search box did not. The top-up
    // read must stay unfiltered, or the form renders as though nothing were
    // selected while the hidden field still posts that id.
    const topUp = source.slice(source.indexOf("ensureCustomerId &&"));
    expect(topUp).toContain("maybeSingle");
    expect(topUp).not.toMatch(/\.(eq|neq|in)\(\s*["']status["']/);
  });
});
