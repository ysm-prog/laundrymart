import { describe, expect, it } from "vitest";
import {
  parseIncomeAccountCode, parseSellPriceBasis, parseSellingUnit, readItemsRegister,
  type RegisterRow,
} from "../items-register";

/** A row in the shape the real export gives, with only the interesting bits set. */
const row = (over: RegisterRow = {}): RegisterRow => ({
  "Item ID": "T37", "Name": "Towels - Black", "Sell item": "Y", "Buy item": "Y",
  "Selling price": 0.37, "Selling price basis": "Tax exclusive",
  "Selling tax code": "GST", "Income category": "4-1100 Towels - Black",
  "Buying price": 8.9, ...over,
});

describe("the three lines on the client's invoice", () => {
  it("reads each one out of the register", () => {
    const { items } = readItemsRegister([
      row(),
      row({ "Item ID": "TL", "Name": "Towels Per Bag", "Selling price": null,
            "Income category": "4-1200 Towels - NOG" }),
      row({ "Item ID": "TFSC", "Name": "Temporary Fuel Surcharge", "Selling price": 2,
            "Income category": "4-6000 Miscellaneous Income" }),
    ]);
    expect(items.map((i) => [i.code, i.sellPrice, i.incomeAccountCode])).toEqual([
      ["T37", 0.37, "4-1100"],
      ["TL", null, "4-1200"],     // no price in the register; typed on the line
      ["TFSC", 2, "4-6000"],
    ]);
  });
});

describe("parseIncomeAccountCode", () => {
  it("takes the code and leaves the name behind", () => {
    expect(parseIncomeAccountCode("4-1100 Towels - Black")).toBe("4-1100");
    expect(parseIncomeAccountCode("4-6000 Miscellaneous Income")).toBe("4-6000");
    expect(parseIncomeAccountCode("5-1000 Towel Purchases")).toBe("5-1000");
  });
  it("refuses to guess at anything not in that shape", () => {
    // A wrong account posts real money to the wrong place.
    expect(parseIncomeAccountCode("Towels")).toBeNull();
    expect(parseIncomeAccountCode("")).toBeNull();
    expect(parseIncomeAccountCode(null)).toBeNull();
  });
});

describe("parseSellPriceBasis", () => {
  it("reads MYOB's two answers", () => {
    expect(parseSellPriceBasis("Tax exclusive")).toBe("exclusive");
    expect(parseSellPriceBasis("Tax inclusive")).toBe("inclusive");
  });
  it("says nothing where MYOB says nothing", () => {
    expect(parseSellPriceBasis("")).toBeNull();
    expect(parseSellPriceBasis("dunno")).toBeNull();
  });
});

describe("parseSellingUnit", () => {
  it("folds the three spellings of each into one", () => {
    // 13 rows say "ea", 11 say "ea." and 10 say "each".
    expect(["ea", "ea.", "each", "EA"].map(parseSellingUnit)).toEqual(["ea", "ea", "ea", "ea"]);
  });
  it("drops a bare number, which is not a unit", () => {
    // 93 of the client's rows carry "1" here. Showing that in a Unit column
    // would be a value nobody can read.
    expect(parseSellingUnit("1")).toBeNull();
    expect(parseSellingUnit("2.5")).toBeNull();
  });
  it("keeps a real unit it does not recognise", () => {
    expect(parseSellingUnit("dozen")).toBe("dozen");
    expect(parseSellingUnit("bag")).toBe("bag");
  });
});

describe("the flags", () => {
  it("reads Y as yes and blank as no — MYOB never writes N here", () => {
    const { items } = readItemsRegister([
      row({ "Sell item": "Y", "Buy item": null }),
      row({ "Item ID": "X2", "Sell item": null, "Buy item": "Y" }),
    ]);
    expect(items.map((i) => [i.isSell, i.isBuy])).toEqual([[true, false], [false, true]]);
  });
});

describe("the defects in the real file", () => {
  it("drops a row with no name and says which", () => {
    const { items, problems } = readItemsRegister([
      row(), row({ "Item ID": "8f2c-4a11-...", "Name": "" }),
    ]);
    expect(items).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: "8f2c-4a11-...", reason: expect.stringMatching(/no name/) });
  });

  it("catches a code that repeats when case is ignored, before the index does", () => {
    const { items, problems } = readItemsRegister([
      row({ "Item ID": "5A-LAUNDRYSE200" }),
      row({ "Item ID": "5a-laundryse200" }),
    ]);
    expect(items).toHaveLength(1);
    expect(problems[0]?.reason).toMatch(/same code as row 2, ignoring case/);
  });

  it("counts the names MYOB cut at thirty characters rather than hiding them", () => {
    const { items, truncatedNames } = readItemsRegister([
      row({ "Name": "Salon Smart Premium Towels Bla" }),   // exactly 30
      row({ "Item ID": "X2", "Name": "Short name" }),
    ]);
    expect(truncatedNames).toBe(1);
    expect(items[0]?.nameTruncated).toBe(true);
    expect(items[1]?.nameTruncated).toBe(false);
  });

  it("refuses a code longer than the column holds", () => {
    const { items, problems } = readItemsRegister([row({ "Item ID": "X".repeat(31) })]);
    expect(items).toHaveLength(0);
    expect(problems[0]?.reason).toMatch(/longer than 30/);
  });
});

describe("the tax code", () => {
  it("normalises MYOB's bare N, which this register uses on one row", () => {
    // The column only accepts GST / FRE / N-T, so an unnormalised import would
    // be refused by the check constraint at the very last moment.
    const { items } = readItemsRegister([row({ "Selling tax code": "N" })]);
    expect(items[0]?.taxCode).toBe("N-T");
  });
  it("keeps GST and FRE as they are, and says nothing for a blank", () => {
    expect(readItemsRegister([row({ "Selling tax code": "GST" })]).items[0]?.taxCode).toBe("GST");
    expect(readItemsRegister([row({ "Selling tax code": "FRE" })]).items[0]?.taxCode).toBe("FRE");
    expect(readItemsRegister([row({ "Selling tax code": "" })]).items[0]?.taxCode).toBeNull();
  });
});
