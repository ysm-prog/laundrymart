import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A job's money reaches an invoice through a draft, and through nothing else.
 *
 * The owner's rule, and the one this repository could not state in a unit test
 * any other way: the modules that write invoices reach `recordAudit` →
 * `lib/env`, which throws without a configured environment, so their behaviour
 * is unreachable from vitest. What *is* reachable is their source, which is how
 * `email-branding.test.ts` polices the palette — and the property here is
 * structural in exactly the same way.
 *
 * What went wrong without it: `from-jobs.ts` inserted an invoice of its own
 * whenever a group had no billing period — a per-job customer, or a `manual`
 * one — so pressing **Approve** could mint a whole invoice document straight off
 * a job, with no draft in between. Nothing failed; there was simply a second
 * door, and it was the one an owner found.
 *
 * Read the source rather than the behaviour, so a branch no fixture exercises
 * still fails.
 */

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** Strip comments, or the paragraph *explaining* the old insert would fail the sweep. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** `.from("invoices")` followed by `.insert(`, across the line break it is written on. */
const INVOICE_INSERT = /\.from\(\s*["']invoices["']\s*\)\s*(?:\.[a-zA-Z]+\([^)]*\)\s*)*?\.insert\(/;

describe("one door onto an invoice", () => {
  it("has open-draft.ts as the only module that inserts an invoice for a job", () => {
    // Non-vacuous: prove the pattern matches the one place that *does* insert
    // before trusting it to say the others do not.
    expect(code(read("open-draft.ts"))).toMatch(INVOICE_INSERT);

    for (const file of ["from-jobs.ts", "issue.ts", "send.ts", "period.ts", "breakdown.ts"]) {
      expect(code(read(file)), `${file} must not insert an invoice of its own`)
        .not.toMatch(INVOICE_INSERT);
    }
  });

  it("opens every one of them as a draft", () => {
    // The status is not a variable and must not become one. An invoice a job
    // reaches is a draft until somebody issues it, and `issueOneInvoice` is the
    // only thing that moves it off `draft`.
    const source = code(read("open-draft.ts"));
    // `(?<![\w_])` so `billing_status:` — a different column, on the job — is not
    // mistaken for the invoice's own.
    const statuses = source.match(/(?<![\w_])status:\s*["'][a-z_]+["']/g);
    expect(statuses).toEqual(['status: "draft"']);
  });

  it("routes from-jobs.ts through the opener", () => {
    // The other half of the first assertion: not inserting is only the rule if
    // the module still puts the jobs somewhere.
    const source = code(read("from-jobs.ts"));
    expect(source).toMatch(/findOrOpenDraft\s*\(/);
  });
});
