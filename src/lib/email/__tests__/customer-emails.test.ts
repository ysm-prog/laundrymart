import { describe, expect, it } from "vitest";
import { buildDeliveryEmail } from "@/lib/email/delivery-email";
import { buildOverdueEmail } from "@/lib/email/overdue-email";

/**
 * These two templates are the only things in the app that write to a *customer*
 * under the tenant's name, so the parts worth pinning are the parts a reviewer
 * would actually object to: unescaped customer names in markup, internal
 * vocabulary leaking out, and money appearing where it should not.
 */
describe("delivery confirmation", () => {
  const base = {
    tenantName: "Harbour Commercial Laundry",
    customerName: "Quay Hotel",
    locationName: "Level 3 linen room",
    completedAt: "2026-08-05T04:30:00.000Z",
    signedBy: "R. Patel",
    lines: [{ name: "Bath towel", quantity: 40 }, { name: "Flat sheet", quantity: 25 }],
    photoUrls: ["https://example.test/p1"],
    signatureUrl: "https://example.test/sig",
  };

  it("names what was delivered, who signed, and totals it", () => {
    const email = buildDeliveryEmail(base);
    expect(email.text).toContain("40 × Bath towel");
    expect(email.text).toContain("65 items in total");
    expect(email.text).toContain("R. Patel");
    expect(email.html).toContain("Level 3 linen room");
  });

  it("renders in Adelaide time, not UTC", () => {
    // 04:30Z on 5 Aug is 14:00 in Adelaide (ACST, +9:30) — the same calendar
    // day, but a template formatting in UTC would say 4:30 am.
    const email = buildDeliveryEmail(base);
    expect(email.subject).toContain("05/08/2026");
    expect(email.subject).toContain("2:00 pm");
  });

  it("escapes a customer name that contains markup", () => {
    const email = buildDeliveryEmail({
      ...base, customerName: '<script>alert("x")</script>',
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("drops the proof block entirely when nothing was captured", () => {
    const email = buildDeliveryEmail({ ...base, photoUrls: [], signatureUrl: null });
    expect(email.html).not.toContain("7 days");
    expect(email.text).not.toContain("Signature:");
  });

  it("carries no dollar figure — a delivery docket is not an invoice", () => {
    const email = buildDeliveryEmail(base);
    expect(email.text).not.toMatch(/\$/);
    expect(email.html).not.toMatch(/\$/);
  });

  it("credits Core IT, because a delivery note is customer-facing", () => {
    const email = buildDeliveryEmail(base);
    expect(email.html).toContain("https://coreit.com.au/");
    expect(email.text).toContain("App is developed & designed by CoreIT");
  });
});

describe("overdue reminder", () => {
  const base = {
    tenantName: "Harbour Commercial Laundry",
    customerName: "Quay Hotel",
    invoiceNumber: "INV-00042",
    balance: 1234.5,
    currency: "AUD",
    dueDate: "2026-07-29",
    daysOverdue: 7,
    sequence: 1,
  };

  it("states the invoice, the amount and how late it is", () => {
    const email = buildOverdueEmail(base);
    expect(email.subject).toContain("INV-00042");
    expect(email.text).toContain("$1,234.50");
    expect(email.text).toContain("29/07/2026");
    expect(email.text).toContain("7 days ago");
  });

  it("stays friendly and makes no threat, on the first pass and the last", () => {
    const first = buildOverdueEmail(base).text.toLowerCase();
    const last = buildOverdueEmail({ ...base, sequence: 3, daysOverdue: 21 }).text.toLowerCase();
    for (const body of [first, last]) {
      expect(body).toContain("reply to this email");
      expect(body).not.toMatch(/legal|debt collect|suspend|overdue account|final notice/);
    }
    // The first nudge assumes an oversight; a later one stops implying they
    // have not seen it, without hardening the tone.
    expect(first).toContain("slip through");
    expect(last).not.toContain("slip through");
  });

  it("offers no payment link, because the schema holds none", () => {
    // This used to assert `not.toContain("href=")`, which said the rule by
    // saying "no links at all" — true until the Core IT credit made the chase
    // carry its first hyperlink, and then it failed for a reason that had
    // nothing to do with the rule it was defending. Rewritten to the decision:
    // **nothing in this email invites a payment**, because the schema holds no
    // payment URL and inventing one would send customers somewhere real money
    // could go astray.
    const email = buildOverdueEmail(base);
    const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

    expect(hrefs).toEqual(["https://coreit.com.au/"]);
    expect(email.html.toLowerCase()).not.toMatch(/pay now|pay online|payment link|checkout/);
    expect(email.text.toLowerCase()).not.toMatch(/pay now|pay online|payment link|checkout/);
  });

  it("credits Core IT on customer mail, in both halves", () => {
    // YSM Hub's own rule, from the top of its `lib/_credit.js`: the credit goes
    // on mail a customer reads. Both halves, because a plain-text client is
    // still a customer reading it.
    const email = buildOverdueEmail(base);
    expect(email.html).toContain("https://coreit.com.au/");
    expect(email.html).toContain("App is developed &amp; designed by");
    expect(email.text).toContain("App is developed & designed by CoreIT");
  });
});
