import { describe, expect, it } from "vitest";
import {
  MAGIC_LINK_SENT, inviteFailureMessage, magicLinkOutcome,
} from "@/lib/auth/magic-link";
import { classifyLinkError, type LinkFailure } from "@/lib/auth/auth-links";

/**
 * The rule under test is one distinction, and it is a security property rather
 * than a wording preference: a failure true of **every** address is named, a
 * failure true of **this** address is hidden behind the same answer as success.
 */
describe("what the sign-in form says back", () => {
  it("says the same thing on success as on an address with no login", () => {
    expect(magicLinkOutcome(null)).toEqual({ ok: MAGIC_LINK_SENT });
    expect(magicLinkOutcome({ reason: "unknown-address" })).toEqual({ ok: MAGIC_LINK_SENT });
  });

  it("names a deployment with no mail provider, because it is true of everybody", () => {
    const outcome = magicLinkOutcome({ reason: "not-configured" });
    expect(outcome).toHaveProperty("error");
    expect("error" in outcome && outcome.error).toContain("RESEND_API_KEY");
  });

  it.each([
    ["no-service-key"], ["no-origin"], ["rate-limited"], ["unreachable"],
  ] as const)("names %s", (reason) => {
    const outcome = magicLinkOutcome({ reason } as LinkFailure);
    expect(outcome).toHaveProperty("error");
  });

  it("names a refusal from the mail provider without repeating its words", () => {
    const outcome = magicLinkOutcome({ reason: "send-refused", detail: "no-reply@x is not verified" });
    expect(outcome).toHaveProperty("error");
    // The provider's own text can name the address it refused, which is the one
    // thing this form must not echo back.
    expect("error" in outcome && outcome.error).not.toContain("no-reply@x");
  });

  it("never leaks the address into any answer", () => {
    const reasons: LinkFailure[] = [
      { reason: "unknown-address" }, { reason: "not-configured" }, { reason: "rate-limited" },
      { reason: "unreachable" }, { reason: "no-origin" }, { reason: "no-service-key" },
      { reason: "send-refused", detail: "someone@example.com rejected" },
    ];
    for (const failure of reasons) {
      const outcome = magicLinkOutcome(failure);
      const said = "ok" in outcome ? outcome.ok : outcome.error;
      expect(said).not.toContain("someone@example.com");
    }
  });
});

describe("reading a refusal from the auth service", () => {
  it("is nothing at all when there was no error", () => {
    expect(classifyLinkError(null)).toBeNull();
  });

  it("names the rate limits and the disabled provider", () => {
    expect(classifyLinkError({ code: "over_email_send_rate_limit" }))
      .toEqual({ reason: "rate-limited" });
    expect(classifyLinkError({ code: "over_request_rate_limit" }))
      .toEqual({ reason: "rate-limited" });
    expect(classifyLinkError({ code: "email_provider_disabled" }))
      .toEqual({ reason: "not-configured" });
  });

  it("treats a 5xx as the service falling over, whatever it called itself", () => {
    expect(classifyLinkError({ code: "unexpected_failure", status: 503, message: "boom" }))
      .toEqual({ reason: "unreachable" });
  });

  /**
   * The default matters more than any individual case. An unrecognised refusal
   * is assumed to be about the address, so the sign-in form hides it — guessing
   * the other way would turn every new Supabase error code into an enumeration
   * oracle.
   */
  it("falls back to the address, so a new error code cannot become an oracle", () => {
    expect(classifyLinkError({ code: "user_not_found", status: 404, message: "User not found" }))
      .toEqual({ reason: "unknown-address" });
    expect(classifyLinkError({ code: "something_invented_in_2027", status: 400, message: "?" }))
      .toEqual({ reason: "unknown-address" });
    expect(magicLinkOutcome(classifyLinkError({ code: "something_invented_in_2027" })))
      .toEqual({ ok: MAGIC_LINK_SENT });
  });
});

/**
 * The administrator typed the address themselves and has to act on the answer,
 * so this half is allowed to be specific — including passing the provider's own
 * words through.
 */
describe("what an administrator is told", () => {
  it("relays why the provider refused, and says nothing was changed", () => {
    const said = inviteFailureMessage({ reason: "send-refused", detail: "domain not verified" });
    expect(said).toContain("domain not verified");
    expect(said).toContain("nothing was changed");
  });

  it("has an answer for every failure there is", () => {
    const reasons: LinkFailure[] = [
      { reason: "not-configured" }, { reason: "no-service-key" }, { reason: "no-origin" },
      { reason: "rate-limited" }, { reason: "unreachable" }, { reason: "unknown-address" },
      { reason: "send-refused", detail: "x" },
    ];
    for (const failure of reasons) {
      expect(inviteFailureMessage(failure).length).toBeGreaterThan(20);
    }
  });
});
