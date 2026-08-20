import { describe, expect, it } from "vitest";
import { MAGIC_LINK_SENT, magicLinkOutcome } from "../magic-link";

/** The shape supabase-js hands back on `signInWithOtp`. */
const err = (code: string, status = 400) => ({ code, status, message: code });

describe("magic link outcome", () => {
  it("reports a send Supabase accepted", () => {
    expect(magicLinkOutcome(null)).toEqual({ ok: MAGIC_LINK_SENT });
  });

  it("answers an address with no login exactly as it answers success", () => {
    // The whole anti-enumeration property, and the reason `otp_disabled` is
    // kept out of the deployment table: with `shouldCreateUser: false` that is
    // what an unknown address comes back as, so naming it would confirm which
    // addresses have logins.
    expect(magicLinkOutcome(err("otp_disabled"))).toEqual({ ok: MAGIC_LINK_SENT });
    expect(magicLinkOutcome(err("user_not_found", 404))).toEqual({ ok: MAGIC_LINK_SENT });
  });

  it("says so when the deployment cannot send mail at all", () => {
    // The live case this was written for: `laundrymart-syd` has never sent an
    // auth email in its life, and the old code reported "on its way" every
    // time — so an owner pressing the button had no way to learn that.
    const outcome = magicLinkOutcome(err("error_sending_email", 500));
    expect(outcome).not.toHaveProperty("ok");
    expect("error" in outcome && outcome.error).toMatch(/not working|not set up/i);
  });

  it("names the other faults only an administrator can fix", () => {
    for (const code of [
      "email_provider_disabled", "over_email_send_rate_limit",
      "over_request_rate_limit", "validation_failed",
    ]) {
      expect(magicLinkOutcome(err(code)), code).toHaveProperty("error");
    }
  });

  it("treats any 5xx as the deployment falling over, whatever it calls itself", () => {
    const outcome = magicLinkOutcome({ code: "unexpected_failure", status: 503 });
    expect(outcome).toHaveProperty("error");
  });

  it("does not turn an unrecognised 4xx into an account-existence signal", () => {
    // Anything not in the table is about this address until proven otherwise,
    // so the vague answer is the safe default rather than the fallback.
    expect(magicLinkOutcome(err("something_new", 400))).toEqual({ ok: MAGIC_LINK_SENT });
    expect(magicLinkOutcome({ message: "no code at all" })).toEqual({ ok: MAGIC_LINK_SENT });
  });

  it("never puts the address it was asked about into the answer", () => {
    const outcomes = [null, err("error_sending_email", 500), err("otp_disabled")]
      .map((e) => magicLinkOutcome(e));
    for (const outcome of outcomes) {
      const text = "ok" in outcome ? outcome.ok : outcome.error;
      expect(text).not.toMatch(/@/);
    }
  });
});
