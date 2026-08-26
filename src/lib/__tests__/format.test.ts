import { describe, expect, it } from "vitest";
import { counted, plural } from "@/lib/format";

describe("plural and counted", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "invoice")).toBe("invoice");
    expect(counted(1, "invoice")).toBe("1 invoice");
  });

  it("uses the plural for none and for many", () => {
    // Zero takes the plural in English — "0 invoices", not "0 invoice".
    expect(counted(0, "invoice")).toBe("0 invoices");
    expect(counted(2, "invoice")).toBe("2 invoices");
  });

  it("takes an irregular plural where English does not just add an s", () => {
    expect(counted(1, "person", "people")).toBe("1 person");
    expect(counted(3, "person", "people")).toBe("3 people");
  });

  it("groups large counts the way the rest of the app formats numbers", () => {
    expect(counted(1200, "job")).toBe("1,200 jobs");
  });

  // The whole reason this exists: "1 invoice(s)" is the shape that tells an
  // unsure reader they are looking at a machine rather than at a sentence.
  it("never produces a parenthetical plural", () => {
    for (const n of [0, 1, 2, 17]) expect(counted(n, "invoice")).not.toContain("(s)");
  });
});
