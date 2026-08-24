import { describe, expect, it } from "vitest";
import {
  AUTH_LINK_PATH, GENERATE_TYPE, VERIFY_TYPE, authLinkUrl,
} from "@/lib/auth/auth-links";

const TOKEN = "pkce_2f8c1b9a";

describe("the link that goes in the email", () => {
  it("points at this app, not at Supabase", () => {
    const link = authLinkUrl("https://ats.coreit.com.au", "invite", TOKEN);
    expect(link).toBe(
      `https://ats.coreit.com.au${AUTH_LINK_PATH}?token_hash=${TOKEN}&type=invite`,
    );
  });

  it("carries the type verifyOtp will be given at the other end", () => {
    expect(authLinkUrl("https://x.test", "sign-in", TOKEN))
      .toContain(`type=${VERIFY_TYPE["sign-in"]}`);
  });

  /**
   * The origin is read off a request header. Somebody who could set it would
   * otherwise be choosing where a genuine sign-in token is sent — so a value
   * that is not a web address is refused rather than interpolated.
   */
  it.each([
    ["", "empty"],
    ["not a url", "not a URL at all"],
    ["javascript:alert(1)", "a javascript: scheme"],
    ["ftp://elsewhere.test", "a scheme this app is never served over"],
  ])("refuses %s (%s)", (origin) => {
    expect(authLinkUrl(origin, "invite", TOKEN)).toBeNull();
  });

  it("keeps only the origin, so a path smuggled into the header is dropped", () => {
    expect(authLinkUrl("https://ats.coreit.com.au/evil/path?a=b", "invite", TOKEN))
      .toBe(`https://ats.coreit.com.au${AUTH_LINK_PATH}?token_hash=${TOKEN}&type=invite`);
  });

  it("refuses to build a link around no token", () => {
    expect(authLinkUrl("https://x.test", "invite", "")).toBeNull();
  });

  it("escapes a token rather than pasting it into the query raw", () => {
    const link = authLinkUrl("https://x.test", "invite", "a b&type=recovery");
    expect(link).toContain("a+b%26type%3Drecovery");
    // The smuggled second `type` must not be able to change how the token is
    // verified — one `type` parameter, and it is ours.
    expect(new URL(link!).searchParams.getAll("type")).toEqual(["invite"]);
  });

  it("allows http, because a local deployment is served over it", () => {
    expect(authLinkUrl("http://localhost:3000", "invite", TOKEN))
      .toBe(`http://localhost:3000${AUTH_LINK_PATH}?token_hash=${TOKEN}&type=invite`);
  });
});

/**
 * These are two different APIs — what a link is minted as, and what it is
 * verified as. They happen to agree today; the tables exist so that a third
 * kind cannot be added with the halves paired wrongly.
 */
describe("the two type tables", () => {
  it("cover exactly the same kinds", () => {
    expect(Object.keys(GENERATE_TYPE).sort()).toEqual(Object.keys(VERIFY_TYPE).sort());
  });

  it("mints a sign-in link as a recovery link", () => {
    // Deliberate: the login page offers this under "No password, or forgotten
    // it?", so it has to let them set one — and recovery cannot create an
    // account, so a mistyped address still cannot mint an orphan login.
    expect(GENERATE_TYPE["sign-in"]).toBe("recovery");
    expect(GENERATE_TYPE.invite).toBe("invite");
  });

  it("only ever names a type the invite screen already handles", () => {
    for (const type of Object.values(VERIFY_TYPE)) {
      expect(["invite", "recovery"]).toContain(type);
    }
  });
});
