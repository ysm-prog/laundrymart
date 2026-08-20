import { describe, expect, it } from "vitest";
import {
  checkItemCode, itemLabel, itemMatches, searchItems, type PickableItem,
} from "@/lib/domain/items";

const item = (over: Partial<PickableItem> = {}): PickableItem => ({
  id: "i1", item_code: "TOW001", name: "Bath Towel", ...over,
});

describe("itemLabel", () => {
  it("leads with the code, because that is what staff know", () => {
    expect(itemLabel(item())).toBe("TOW001 — Bath Towel");
  });

  it("falls back to the name where no code is set", () => {
    expect(itemLabel(item({ item_code: null }))).toBe("Bath Towel");
    expect(itemLabel(item({ item_code: "   " }))).toBe("Bath Towel");
  });
});

describe("itemMatches", () => {
  it("matches the code, the name and the description", () => {
    const towel = item({ description: "Commercial, white" });
    expect(itemMatches(towel, "tow")).toBe(true);
    expect(itemMatches(towel, "bath")).toBe(true);
    expect(itemMatches(towel, "commercial")).toBe(true);
    expect(itemMatches(towel, "sheet")).toBe(false);
  });

  it("matches everything on a blank query, so the picker opens full", () => {
    expect(itemMatches(item(), "")).toBe(true);
    expect(itemMatches(item(), "   ")).toBe(true);
  });
});

describe("searchItems", () => {
  const items = [
    item({ id: "a", item_code: "PIL010", name: "Pillowcase (towelling trim)" }),
    item({ id: "b", item_code: "TOW001", name: "Bath Towel" }),
    item({ id: "c", item_code: "TOW002", name: "Hand Towel" }),
  ];

  it("puts a code match above a name that merely contains the letters", () => {
    // The behaviour the whole picker is for: typing TOW finds the towels.
    expect(searchItems(items, "TOW").map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("puts an exact code first", () => {
    expect(searchItems(items, "TOW002")[0]!.id).toBe("c");
  });

  it("keeps the caller's order inside a rank, so the list does not reshuffle", () => {
    expect(searchItems(items, "tow0").map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("returns the whole list, capped, for a blank query", () => {
    expect(searchItems(items, "").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(searchItems(items, "", 2)).toHaveLength(2);
  });

  it("is case-insensitive both ways", () => {
    expect(searchItems(items, "tow001")[0]!.id).toBe("b");
    expect(searchItems([item({ item_code: "tow001" })], "TOW001")).toHaveLength(1);
  });
});

describe("checkItemCode", () => {
  it("refuses a duplicate, case-insensitively", () => {
    const result = checkItemCode("tow001", ["TOW001", "SHT002"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/already in use/i);
  });

  it("lets an item keep its own code when it is edited", () => {
    const byId = new Map([["i1", "TOW001"]]);
    expect(checkItemCode("TOW001", ["TOW001"], "i1", byId)).toEqual({ ok: true });
  });

  it("refuses blank, over-long and spaced codes", () => {
    expect(checkItemCode("  ", []).ok).toBe(false);
    expect(checkItemCode("A".repeat(21), []).ok).toBe(false);
    expect(checkItemCode("TOW 001", []).ok).toBe(false);
  });

  it("accepts a free code", () => {
    expect(checkItemCode("SHT002", ["TOW001"])).toEqual({ ok: true });
  });
});
