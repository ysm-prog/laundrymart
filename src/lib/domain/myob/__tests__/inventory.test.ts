import { describe, expect, it } from "vitest";
import {
  INVENTORY_COLUMNS, cleanCode, isPlaceholderRow, readInventory,
} from "@/lib/domain/myob/inventory";

/**
 * Written against the client's real 257-row export, not an invented one. Every
 * fixture below is a row that is actually in that file — including the four
 * shapes that would otherwise land in front of staff.
 */
const HEADER = [...INVENTORY_COLUMNS];
const sheet = (...rows: unknown[][]) => [HEADER, ...rows];

describe("cleanCode", () => {
  it("undoes the markdown escaping that leaked into the export", () => {
    expect(cleanCode("2-B201\\_PK100")).toBe("2-B201_PK100");
    expect(cleanCode("2-GLOVECLASTRAPF\\_PK1000")).toBe("2-GLOVECLASTRAPF_PK1000");
  });

  it("leaves a code that has no escaping alone", () => {
    expect(cleanCode("TW")).toBe("TW");
    expect(cleanCode(" 42469 ")).toBe("42469");
    expect(cleanCode("5A-SHOREDET15")).toBe("5A-SHOREDET15");
  });

  it("does not invent a rule for a backslash before anything else", () => {
    // A code that genuinely contains one is somebody's real code.
    expect(cleanCode("A\\B")).toBe("A\\B");
  });
});

describe("isPlaceholderRow", () => {
  it("catches the nameless GUID rows", () => {
    expect(isPlaceholderRow("337ef806-4795-495d-9aa9-e780ad", "")).toBe(true);
  });

  it("does not catch a real item", () => {
    expect(isPlaceholderRow("TW", "Towels - Wash & Dry Only")).toBe(false);
    expect(isPlaceholderRow("42469", "Towel Ultra 70 x 150 White")).toBe(false);
  });
});

describe("readInventory", () => {
  it("reads the code from Item Number, never MYOB's internal Item ID", () => {
    // The trap: `Item ID` is 239, 229, 265 — a row number nobody types. Reading
    // the wrong column would import 257 items nobody can find.
    const { items } = readInventory(sheet(
      ["112", "TW", "Towels - Wash & Dry Only", 0, null, null, "Excluded"],
    ));
    expect(items).toHaveLength(1);
    expect(items[0]!.code).toBe("TW");
    expect(items[0]!.myobItemId).toBe("112");
  });

  it("carries a price where MYOB holds one and null where it does not", () => {
    const { items } = readInventory(sheet(
      ["288", "42469", "Towel Ultra 70 x 150 White", 72, 648, 2, "Excluded"],
      ["36", "Mop", "Mop Head", 0, 0, 0.95, "Included"],
      ["112", "TW", "Towels - Wash & Dry Only", 0, null, null, "Excluded"],
    ));
    expect(items.map((item) => item.sellPrice)).toEqual([2, 0.95, null]);
    // Zero is a price somebody set; null is a price nobody has. Not the same.
    expect(items[1]!.sellPrice).not.toBeNull();
  });

  it("records whether MYOB's price includes GST without touching a tax code", () => {
    const { items } = readInventory(sheet(
      ["36", "Mop", "Mop Head", 0, 0, 0.95, "Included"],
      ["112", "TW", "Towels", 0, null, null, "Excluded"],
    ));
    expect(items.map((item) => item.taxInclusive)).toEqual([true, false]);
  });

  it("un-escapes the backslash codes and says how many it fixed", () => {
    const { items, notes } = readInventory(sheet(
      ["263", "2-B201\\_PK100", "Garbage Bag Glad Black 240L Ro", 0, null, null, "Excluded"],
    ));
    expect(items[0]!.code).toBe("2-B201_PK100");
    expect(notes.some((note) => note.includes("backslash"))).toBe(true);
  });

  it("drops the nameless GUID rows and says which", () => {
    const { items, skipped } = readInventory(sheet(
      ["285", "337ef806-4795-495d-9aa9-e780ad", null, 0.7, null, null, "Excluded"],
      ["112", "TW", "Towels - Wash & Dry Only", 0, null, null, "Excluded"],
    ));
    expect(items).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toContain("no name");
  });

  it("flags a truncated name rather than pretending it is complete", () => {
    const cut = "Salon Smart Premium Towels Bla"; // exactly 30 characters
    expect(cut).toHaveLength(30);
    const { items, notes } = readInventory(sheet(
      ["265", "126033", cut, 0.3, null, null, "Excluded"],
    ));
    expect(items[0]!.nameTruncated).toBe(true);
    expect(notes.some((note) => note.includes("cut off"))).toBe(true);
  });

  it("refuses a second row with the same code, case-insensitively", () => {
    // Our unique index is case-insensitive per laundry, so this would fail the
    // insert. Better to name the row here than to relay a constraint name.
    const { items, skipped } = readInventory(sheet(
      ["1", "TW", "Towels", 0, null, null, "Excluded"],
      ["2", "tw", "Towels again", 0, null, null, "Excluded"],
    ));
    expect(items).toHaveLength(1);
    expect(skipped[0]!.reason).toContain("same code as row 2");
  });

  it("says where the rate comes from when nothing is priced", () => {
    const { notes } = readInventory(sheet(
      ["112", "TW", "Towels", 0, null, null, "Excluded"],
    ));
    expect(notes.some((note) => note.includes("laundry price list"))).toBe(true);
  });

  it("never infers sell-versus-buy, and says so", () => {
    const { notes } = readInventory(sheet(
      ["112", "TW", "Towels", 0, null, null, "Excluded"],
    ));
    expect(notes.some((note) => note.includes("sell") && note.includes("buy"))).toBe(true);
  });

  it("refuses a file that is not this export, by name", () => {
    const { items, notes } = readInventory([["Code", "Name", "Type"], ["4-1100", "Towels", "Income"]]);
    expect(items).toHaveLength(0);
    expect(notes[0]).toContain("Item Number");
  });

  it("ignores blank rows rather than counting them", () => {
    const { items, skipped } = readInventory(sheet(
      ["112", "TW", "Towels", 0, null, null, "Excluded"],
      [null, null, null, null, null, null, null],
    ));
    expect(items).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });
});
