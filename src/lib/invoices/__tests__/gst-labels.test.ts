import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No screen tells somebody a GST-inclusive figure is exclusive of GST.
 *
 * Since `0043_myob_invoice_lines`, an `invoice_lines.amount` is **GST-inclusive**:
 * `recalculate_invoice` stores `subtotal = total` and extracts the tax from
 * inside it rather than adding it on top. A job charge amount becomes a line
 * amount unchanged, so every figure summed by `jobChargeSubtotal`,
 * `consolidatedSubtotal` and `period.ts`'s `chargeSubtotal` already carries GST.
 *
 * What went wrong without this: 0043 landed from a branch whose own source
 * changes never merged, and **thirteen** places went on saying "before GST"
 * about those sums — two toasts, four screens, three Stat hints, two inline
 * subtotals and three doc comments — while `/reports` printed the inclusive
 * total under an "Invoiced (ex GST)" label beside the identical figure labelled
 * "inc GST". One claim, copied thirteen times, wrong in all of them at once.
 *
 * A source sweep rather than a behavioural test, for `one-door.test.ts`'s
 * reason: these are strings inside async server components and `"use server"`
 * modules that reach `lib/env`, so vitest cannot render or import them. What is
 * reachable is their source.
 *
 * This deliberately does **not** ban "ex GST", because an ex-GST figure is a
 * legitimate thing to show: `/reports` derives one as `total − tax` and labels
 * it honestly.
 *
 * It used to say the credit note earned that label too — *"a credit note really
 * is entered exclusive of GST"* — which was true of the old arithmetic and is
 * not true any more. `0046` put credit notes on the same GST-inclusive model as
 * invoices, so that form now says "(inc GST)" and there is no longer a form in
 * this app asking for a figure exclusive of GST.
 */

const SRC = join(__dirname, "..", "..", "..");

/** Comments are stripped, or the paragraph *explaining* the old wording would fail the sweep. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Tests are not user-facing copy, and this file names the phrase itself.
      if (entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(path, found);
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/** "before GST" / "Before GST", however the sentence around it is punctuated. */
const EXCLUSIVE_CLAIM = /\bbefore\s+GST\b/i;

describe("GST wording matches what the amount actually is", () => {
  const files = sourceFiles(SRC);

  it("scans the application source", () => {
    // Non-vacuous: a walk that found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(join("domain", "job-pricing.ts")))).toBe(true);
  });

  it("catches the claim it exists to catch", () => {
    expect(EXCLUSIVE_CLAIM.test("Charges saved — $105.00 before GST.")).toBe(true);
    expect(EXCLUSIVE_CLAIM.test('hint="Before GST"')).toBe(true);
    // and leaves a legitimately ex-GST label alone — /reports derives one
    expect(EXCLUSIVE_CLAIM.test('<Stat label="Invoiced (ex GST)" value={money(total - tax)} />')).toBe(false);
  });

  it("has no screen calling a GST-inclusive amount exclusive of GST", () => {
    const offenders = files.filter((f) => EXCLUSIVE_CLAIM.test(code(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
