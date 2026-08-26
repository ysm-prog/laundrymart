import { describe, expect, it } from "vitest";
import { buildAuthEmail } from "@/lib/email/auth-email";

const LINK = "https://ats.coreit.com.au/auth/invite?token_hash=abc123&type=invite";

describe("the invitation email", () => {
  const email = buildAuthEmail({
    kind: "invite",
    tenantName: "Adelaide Towel Service",
    recipientName: "Priya Raman",
    invitedBy: "jay@ctnorwood.com.au",
    link: LINK,
  });

  it("names the business in the subject, so a two-laundry deployment reads right", () => {
    expect(email.subject).toContain("Adelaide Towel Service");
  });

  it("greets them by name", () => {
    expect(email.text).toContain("Hello Priya Raman,");
    expect(email.html).toContain("Hello Priya Raman,");
  });

  it("says who added them", () => {
    expect(email.text).toContain("jay@ctnorwood.com.au has added you");
  });

  /**
   * The plain-text half is not a courtesy. A mail client that strips the button
   * must not strip the only way in, so the link appears as text in both halves.
   */
  it("carries the link in the text part as well as the button", () => {
    // The text half is verbatim; the HTML half writes `&` as `&amp;`, which is
    // how a literal ampersand is spelled inside an attribute and is what every
    // client decodes back. Asserted in that form rather than "fixed", because
    // emitting a bare `&` in an href is the actual bug.
    const inHtml = LINK.replace(/&/g, "&amp;");
    expect(email.text).toContain(LINK);
    expect(email.html).toContain(`href="${inHtml}"`);
    expect(email.html.split(inHtml).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("says what to do when the link has gone stale, and who to ask", () => {
    expect(email.text).toContain("only be used once");
    expect(email.text).toContain("ask whoever invited you");
  });

  it("tells somebody who was not expecting it that ignoring it is safe", () => {
    expect(email.text).toContain("you can ignore it");
  });

  /** The reader has not seen the app, so none of its internal words belong here. */
  it("uses none of the app's own vocabulary", () => {
    for (const jargon of ["tenant", "membership", "RLS", "board", "capability"]) {
      expect(email.text.toLowerCase()).not.toContain(jargon);
    }
  });
});

describe("the sign-in link email", () => {
  const email = buildAuthEmail({
    kind: "sign-in",
    tenantName: "Electro Services",
    link: LINK,
  });

  it("is a different subject from an invitation, because it is a different thing", () => {
    expect(email.subject).toContain("sign-in link");
    expect(email.subject).not.toContain("you have been added");
  });

  it("greets somebody whose name we were never given", () => {
    expect(email.text).toContain("Hello,");
    expect(email.text).not.toContain("Hello undefined");
  });

  it("says they can get another themselves — the remedy differs from an invitation", () => {
    expect(email.text).toContain("ask for another from the sign-in page");
    expect(email.text).not.toContain("ask whoever invited you");
  });

  it("promises the password step, which is what the login page's button offers", () => {
    expect(email.text).toContain("set a new password");
  });
});

describe("escaping", () => {
  it("escapes a business name that contains markup", () => {
    const email = buildAuthEmail({
      kind: "invite",
      tenantName: '<script>alert("x")</script> Laundry',
      recipientName: "A & B",
      link: LINK,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("A &amp; B");
  });

  /**
   * The link is built by `authLinkUrl`, which percent-encodes — but it lands in
   * an `href` and in text, so it is escaped here too rather than trusted twice.
   */
  it("escapes a link carrying a quote rather than breaking out of the attribute", () => {
    const email = buildAuthEmail({
      kind: "sign-in",
      tenantName: "X",
      link: 'https://x.test/a"onmouseover="alert(1)',
    });
    expect(email.html).not.toContain('"onmouseover="');
    expect(email.html).toContain("&quot;onmouseover=&quot;");
  });
});
