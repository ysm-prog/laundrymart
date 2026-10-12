import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Complete → price → approve → running draft → issue → send → payment, at the
 * seams vitest can reach. The rules are pure and tested in
 * `lib/domain/__tests__/payment-gate.test.ts`; this holds the callers to them,
 * because both callers reach `lib/env` and cannot be imported here.
 */
const src = join(__dirname, "../../..");
const read = (file: string) => readFileSync(join(src, file), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the invoice lifecycle, as wired", () => {
  it("issue counts the draft's lines and asks issueRefusal before it recalculates", () => {
    const issue = code(read("lib/invoices/issue.ts"));
    expect(issue).toMatch(/issueRefusal\(\{ status: terms\.status, lineCount/);
    expect(issue.indexOf("issueRefusal(")).toBeLessThan(issue.indexOf("recalculate_invoice"));
  });

  it("both payment forms are drawn by the one rule", () => {
    expect(code(read("app/(app)/invoices/page.tsx"))).toMatch(/canTakePayment\(invoice\)/);
    expect(code(read("app/(app)/invoices/[id]/page.tsx"))).toMatch(/canTakePayment\(invoice\)/);
  });

  it("a payment on an invoice with lines recalculates; a bare header is added to", () => {
    const actions = code(read("app/(app)/invoices/actions.ts"));
    expect(actions).toMatch(/lineCount && lineCount > 0[\s\S]{0,120}recalculate_invoice/);
    expect(actions).toMatch(/settleHeaderOnly\(/);
  });

  it("paying in full settles the jobs on it, from either invoiced state", () => {
    const send = code(read("lib/invoices/send.ts"));
    expect(send).toMatch(/billing_status: "paid"[\s\S]{0,200}\["invoice_generated", "invoice_sent"\]/);
  });
});
