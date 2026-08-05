import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkbox, count, describeDbError, firstIssue, money, optionalDate, optionalText, optionalUuid, percent, requiredDate, weekdaysFrom } from "@/lib/actions";

/**
 * The form-coercion helpers every server action parses through. HTML forms post
 * strings and omit unchecked boxes, so these preprocessors carry real behaviour
 * that types alone do not describe — and that a Zod major upgrade could change
 * silently.
 */
describe("form coercion helpers", () => {
  it("treats an empty text input as absent, and trims the rest", () => {
    expect(optionalText.parse("")).toBeUndefined();
    expect(optionalText.parse("  x  ")).toBe("x");
  });
  it("accepts a blank select but rejects a malformed id", () => {
    expect(optionalUuid.parse("")).toBeUndefined();
    expect(() => optionalUuid.parse("nope")).toThrow();
  });
  it("coerces money, percentage and count fields with their bounds", () => {
    expect(money.parse("")).toBe(0);
    expect(money.parse("12.50")).toBe(12.5);
    expect(() => money.parse("-1")).toThrow();
    expect(percent.parse("10")).toBe(10);
    expect(() => percent.parse("101")).toThrow();
    expect(count.parse("3")).toBe(3);
    expect(() => count.parse("1.5")).toThrow();
  });
  it("reads an unchecked box as false rather than undefined", () => {
    expect(checkbox.parse("on")).toBe(true);
    expect(checkbox.parse(undefined)).toBe(false);
  });
  it("requires ISO dates from the date picker", () => {
    expect(optionalDate.parse("")).toBeUndefined();
    expect(requiredDate.parse("2026-03-02")).toBe("2026-03-02");
    expect(() => requiredDate.parse("2/3/26")).toThrow();
  });
  it("firstIssue names the field", () => {
    const r = z.object({ email: z.string().email("bad email") }).safeParse({ email: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toBe("email: bad email");
  });
  it("sorts weekday checkboxes and drops junk values", () => {
    const fd = new FormData();
    ["3","1","9","x"].forEach((v) => fd.append("d", v));
    expect(weekdaysFrom(fd, "d")).toEqual([1, 3]);
  });
  it("turns Postgres error codes into something a user can act on", () => {
    expect(describeDbError({ code: "23505", message: "dup" })).toContain("already in use");
    expect(describeDbError({ code: "P0001", message: "ERROR:  load must be confirmed" })).toBe("load must be confirmed");
  });
});
