import { describe, expect, it } from "vitest";
import { formatAbn, isValidAbn, normaliseAbn } from "../abn";

describe("isValidAbn", () => {
  it("accepts real ABNs in any spacing", () => {
    expect(isValidAbn("51824753556")).toBe(true);   // CSIRO, the ATO's own example
    expect(isValidAbn("51 824 753 556")).toBe(true);
    expect(isValidAbn("51-824-753-556")).toBe(true);
  });

  it("rejects a transposition that still has 11 digits", () => {
    expect(isValidAbn("51824753565")).toBe(false);
  });

  it("rejects wrong lengths and non-digits", () => {
    expect(isValidAbn("5182475355")).toBe(false);
    expect(isValidAbn("518247535567")).toBe(false);
    expect(isValidAbn("51824753A56")).toBe(false);
    expect(isValidAbn("")).toBe(false);
  });
});

describe("formatting", () => {
  it("strips spaces and dashes", () => {
    expect(normaliseAbn(" 51 824-753 556 ")).toBe("51824753556");
  });

  it("formats to the ATO's grouping", () => {
    expect(formatAbn("51824753556")).toBe("51 824 753 556");
  });

  it("leaves an unrecognisable value alone", () => {
    expect(formatAbn("not-an-abn")).toBe("not-an-abn");
  });
});
