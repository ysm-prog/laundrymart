import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_PALETTE, emailShell } from "@/lib/email/layout";
import { buildInvoiceEmail } from "@/lib/email/invoice-email";
import { buildOverdueEmail } from "@/lib/email/overdue-email";
import { buildDeliveryEmail } from "@/lib/email/delivery-email";
import { buildAuthEmail } from "@/lib/email/auth-email";

/**
 * The branding guard.
 *
 * Four templates used to carry four copies of the same chrome, and the drift
 * that produced was not subtle: a grey `#f6f7f9` page nothing in the brand
 * uses, a system font stack, and the teal appearing in exactly one button of
 * one email. `layout.ts` fixed it; this file is what stops it coming back,
 * because the next person adding a template will copy an existing one and a
 * code review is not a reliable place to catch a hex code.
 *
 * It reads the template *sources* rather than only their output, so a colour
 * hard-coded on a branch nothing in these fixtures exercises still fails.
 */

const EMAIL_DIR = join(process.cwd(), "src/lib/email");

/**
 * Comments are stripped before every sweep below.
 *
 * Not a convenience: the files that *explain* the old greys and the old shell
 * name them in prose, so a sweep over raw source would fail on the very
 * comments recording the fix — and the obvious way to "fix" that is to delete
 * the explanation, which is the wrong repair.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TEMPLATES = readdirSync(EMAIL_DIR)
  .filter((name) => name.endsWith("-email.ts"))
  .map((name) => ({ name, source: code(readFileSync(join(EMAIL_DIR, name), "utf8")) }));

/** Every colour the brand allows in an email, lower-cased for comparison. */
const ALLOWED = new Set([
  ...Object.values(EMAIL_PALETTE).map((hex) => hex.toLowerCase()),
  // The only literal: text on a solid teal button. The app spells this
  // `--on-status`; an email has no tokens, and white on `#01696F` is 8.6:1.
  "#ffffff",
]);

describe("email branding", () => {
  it("finds the templates it is meant to be guarding", () => {
    // Without this, deleting or renaming every template would make the sweep
    // below pass over an empty list and report success — the vacuous-pass trap
    // this repo has recorded twice.
    expect(TEMPLATES.map((t) => t.name).sort()).toEqual([
      "auth-email.ts", "delivery-email.ts", "invoice-email.ts", "overdue-email.ts",
    ]);
  });

  it.each(TEMPLATES)("$name uses no colour outside the palette", ({ source }) => {
    const hexes = [...source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    const strays = [...new Set(hexes)].filter((hex) => !ALLOWED.has(hex));

    expect(strays).toEqual([]);
  });

  it.each(TEMPLATES)("$name builds no shell of its own", ({ source }) => {
    // One `<!doctype html>` in the codebase, and it is in `layout.ts`.
    expect(source).not.toContain("<!doctype html>");
  });

  it("puts the Core IT credit on customer mail", () => {
    // The three a customer reads. YSM Hub's `lib/_credit.js` draws this line
    // itself: "Customer-facing only — not used on internal/staff notification
    // emails."
    const customer = [
      buildOverdueEmail({
        tenantName: "A Laundry", customerName: "A Customer", invoiceNumber: "INV-1",
        balance: 10, currency: "AUD", dueDate: "2026-07-29", daysOverdue: 7, sequence: 1,
      }),
      buildDeliveryEmail({
        tenantName: "A Laundry", customerName: "A Customer", locationName: null,
        completedAt: "2026-08-05T04:30:00.000Z", signedBy: null,
        lines: [{ name: "Towel", quantity: 1 }], photoUrls: [], signatureUrl: null,
      }),
    ];

    for (const email of customer) {
      expect(email.html).toContain("https://coreit.com.au/");
      expect(email.text).toContain("App is developed & designed by CoreIT");
    }
  });

  it("keeps the Core IT credit off staff mail", () => {
    // An invitation telling a counter hand to choose a password is not
    // marketing surface. Asserted in both halves, because `withTextCredit`
    // and the shell are two different switches and either could be flipped.
    for (const kind of ["invite", "sign-in"] as const) {
      const email = buildAuthEmail({
        kind, tenantName: "A Laundry", link: "https://example.test/auth/invite?token_hash=abc",
      });
      expect(email.html).not.toContain("coreit.com.au");
      expect(email.text).not.toContain("CoreIT");
    }
  });

  it("carries the brand on every email, not just the ones with a button", () => {
    const invoice = buildInvoiceEmail({
      tenant: { name: "A Laundry", abn: "12 345 678 901" },
      customer: { business_name: "A Customer" },
      invoice: {
        invoice_number: "INV-1", total: "100", balance: "100", currency: "AUD",
        due_date: "2026-09-09", period_start: null, period_end: null,
        purchase_order_number: null,
      },
    // The PDF payload is much wider than the email reads; this fixture is the
    // slice the template touches.
    } as unknown as Parameters<typeof buildInvoiceEmail>[0]);

    expect(invoice.html).toContain(EMAIL_PALETTE.paper);
    expect(invoice.html).toContain(EMAIL_PALETTE.surface);
    expect(invoice.html).toContain("Instrument Sans");
  });

  it("gives the inbox a preview line rather than letting it scrape the body", () => {
    const html = emailShell({
      audience: "staff", brandName: "A Laundry", preview: "Something worth previewing",
      body: "<p>Body</p>",
    });
    expect(html).toContain("Something worth previewing");
    // Hidden, not merely small — a visible duplicate at the top of the card is
    // how a preheader goes wrong.
    expect(html).toMatch(/display:none;max-height:0;overflow:hidden/);
  });

  it("escapes a brand name that contains markup", () => {
    const html = emailShell({
      audience: "customer", brandName: '<script>alert("x")</script>', body: "",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
