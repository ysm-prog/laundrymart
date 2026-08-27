import { describe, expect, it } from "vitest";
import {
  createLoginFailureMessage, MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem,
} from "../passwords";

describe("passwordProblem", () => {
  it("accepts an ordinary password an owner would actually set", () => {
    expect(passwordProblem("Towel-Owner-8401!")).toBeNull();
  });

  it("names the empty box and points at the other button", () => {
    // The two ways in sit in one form (see the People screen), so the message
    // for "no password" has to say the other one exists.
    expect(passwordProblem("")).toMatch(/Send invitation/);
  });

  it("refuses a password one character under the minimum, and says how long it is", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const problem = passwordProblem(short);
    expect(problem).toContain(String(MIN_PASSWORD_LENGTH));
    expect(problem).toContain(String(MIN_PASSWORD_LENGTH - 1));
  });

  it("accepts a password exactly at the minimum", () => {
    expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("refuses surrounding whitespace rather than trimming it away", () => {
    // The whole point: trimming would store a different credential from the one
    // the administrator believes they set, and the person could never sign in.
    expect(passwordProblem("Towel-Owner-8401! ")).toMatch(/space/i);
    expect(passwordProblem(" Towel-Owner-8401!")).toMatch(/space/i);
    expect(passwordProblem("Towel-Owner-8401!\n")).toMatch(/space/i);
  });

  it("keeps a space in the middle, which is a legitimate character", () => {
    expect(passwordProblem("correct horse battery")).toBeNull();
  });

  it("counts the bcrypt limit in bytes, not characters", () => {
    // 72 ASCII characters is exactly at the limit and fine...
    expect(passwordProblem("a".repeat(MAX_PASSWORD_BYTES))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD_BYTES + 1))).toMatch(/too long/i);

    // ...but 30 four-byte emoji is 120 bytes and must be refused, even though
    // its `.length` is only 60 — each one is a surrogate pair, so it counts as
    // two UTF-16 units and four UTF-8 bytes. A character-count check would let
    // this through and bcrypt would silently ignore everything past byte 72.
    const emoji = "🧺".repeat(30);
    expect(emoji.length).toBeLessThan(MAX_PASSWORD_BYTES);
    expect(passwordProblem(emoji)).toMatch(/too long/i);
  });
});

describe("createLoginFailureMessage", () => {
  it("names the remedy for an address that already has a login", () => {
    // The fix is another control on the same screen, so the message says which.
    for (const reason of [
      "A user with this email address has already been registered",
      "Email address already exists",
      "email_exists",
    ]) {
      const message = createLoginFailureMessage(reason);
      expect(message).toMatch(/Send invitation/);
      expect(message).toMatch(/sign-in link/i);
    }
  });

  it("passes a password refusal through, since the administrator can act on it", () => {
    expect(createLoginFailureMessage("Password should be at least 6 characters"))
      .toContain("Password should be at least 6 characters");
  });

  it("still says something useful when the auth API says nothing at all", () => {
    expect(createLoginFailureMessage(undefined)).toMatch(/could not be created/);
    expect(createLoginFailureMessage("")).toMatch(/could not be created/);
  });
});
