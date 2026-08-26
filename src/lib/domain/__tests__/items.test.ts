import { describe, expect, it } from "vitest";
import {
  MAX_ITEM_CODE, PRICE_BASIS_OPTIONS, checkItemCode, itemLabel, itemMatches,
  priceBasisHint, searchItems, sellPriceLabel, type PickableItem,
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
    expect(checkItemCode("A".repeat(MAX_ITEM_CODE + 1), []).ok).toBe(false);
    expect(checkItemCode("TOW 001", []).ok).toBe(false);
  });

  it("accepts the longest code this business actually uses", () => {
    // 23 characters, straight out of their MYOB inventory. A 20-character cap
    // would have refused a code they type every week — which is why the limit
    // is MYOB's own field width rather than a number somebody liked.
    expect(checkItemCode("2-GLOVECLASTRAPF_PK1000", [])).toEqual({ ok: true });
    expect("2-GLOVECLASTRAPF_PK1000".length).toBeLessThanOrEqual(MAX_ITEM_CODE);
  });

  it("accepts a free code", () => {
    expect(checkItemCode("SHT002", ["TOW001"])).toEqual({ ok: true });
  });
});

describe("sellPriceLabel", () => {
  it("puts the unit beside the price, which is what stops it being read wrong", () => {
    expect(sellPriceLabel("$0.22", "ea")).toBe("$0.22 / ea");
    expect(sellPriceLabel("$18.00", "ctn")).toBe("$18.00 / ctn");
  });

  it("gives the price alone when nobody has said what it is per", () => {
    // The ordinary case, not the exception: `selling_unit` is null on all 254 of
    // this laundry's imported items, so this is the branch the list renders today.
    expect(sellPriceLabel("$0.22", null)).toBe("$0.22");
    expect(sellPriceLabel("$0.22", undefined)).toBe("$0.22");
  });

  it("treats a whitespace-only unit as no unit", () => {
    // `selling_unit` is free text copied out of an accounting package. "$0.22 / "
    // with nothing after the slash reads as a fault in the app rather than as a
    // field nobody filled in.
    expect(sellPriceLabel("$0.22", "   ")).toBe("$0.22");
  });

  it("trims a unit somebody typed with a space", () => {
    expect(sellPriceLabel("$0.22", " ea ")).toBe("$0.22 / ea");
  });
});

describe("priceBasisHint", () => {
  it("says which of the two things the price on screen means", () => {
    expect(priceBasisHint("inclusive", true)).toBe("This price includes GST");
    expect(priceBasisHint("exclusive", true)).toBe("GST is added to this price");
  });

  it("says nothing when the item has no basis on it", () => {
    // Every one of this laundry's 254 items, so an absent basis is the ordinary
    // case rather than an error to narrate at somebody.
    expect(priceBasisHint(null, true)).toBeNull();
    expect(priceBasisHint(undefined, true)).toBeNull();
    expect(priceBasisHint("   ", true)).toBeNull();
  });

  it("says nothing on a line that carries no GST", () => {
    // **Both sentences are claims about GST.** On a FRE or N-T line neither is
    // true, and saying either would be worse than saying nothing — the same call
    // `taxableFromTaxCode` makes when it does not recognise a code.
    expect(priceBasisHint("inclusive", false)).toBeNull();
    expect(priceBasisHint("exclusive", false)).toBeNull();
  });

  it("does not guess at a basis it does not recognise", () => {
    // `sell_price_basis` is constrained to two values in the database, so this is
    // unreachable through the app — and a rule that guessed would put a claim
    // about somebody's tax on the screen on the strength of a typo.
    expect(priceBasisHint("Inclusive of GST", true)).toBeNull();
    expect(priceBasisHint("gst", true)).toBeNull();
  });

  it("reads the basis however it was cased or spaced", () => {
    expect(priceBasisHint(" Inclusive ", true)).toBe("This price includes GST");
    expect(priceBasisHint("EXCLUSIVE", true)).toBe("GST is added to this price");
  });

  it("recognises exactly the two values the picker offers and the database allows", () => {
    // The pin that matters: the picker, the check constraint and this rule are
    // three statements of one vocabulary, and a value offered by one and refused
    // by another would be a save that fails on a constraint name. Driven off the
    // options list rather than restating it, so adding a third option here fails
    // rather than silently rendering no hint.
    for (const option of PRICE_BASIS_OPTIONS) {
      expect(priceBasisHint(option.value, true)).not.toBeNull();
    }
    expect(PRICE_BASIS_OPTIONS.map((option) => option.value)).toEqual(["inclusive", "exclusive"]);
  });
});
