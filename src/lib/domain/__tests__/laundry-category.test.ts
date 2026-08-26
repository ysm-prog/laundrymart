import { describe, expect, it } from "vitest";
import { categoriseItem, categoryTally } from "@/lib/domain/laundry-category";

/**
 * Every name below is a real row from the client's MYOB inventory export, not a
 * fixture invented to suit the rule. That matters: this rule decides what a
 * customer is charged, and the failure it exists to prevent is a *plausible*
 * category rather than an obviously wrong one.
 */
const item = (item_code: string, name: string) => ({ item_code, name });

describe("categoriseItem — the five traps in the real list", () => {
  it("files a bath sheet as a bath towel, not as bedding", () => {
    // Six of their rows say "Bath Sheet". A generic `sheet` rule reaching them
    // first bills every one at the bed-sheet rate.
    for (const name of [
      "Bath Sheet 5 Star 90x170", "Bath Sheet Ultra 90x170 White",
      "Bath Sheets - Charcoal", "Bath Sheet - Alliance Stering",
    ]) {
      expect(categoriseItem(item("x", name))).toBe("bath_towels");
    }
  });

  it("leaves the washroom's paper hand towels alone", () => {
    // The trap that would put paper stock on a customer's laundry list. All
    // four are `4-` rows: consumables the laundry buys.
    for (const [code, name] of [
      ["4-150160U", "TCA Ultraslim Hand Towel 150 S"],
      ["4-7200", "Hand Towel Salute Premium Comp"],
      ["4-HTKRT2400", "Hand Towel Regal Gold"],
      ["4-CD-8035B", "Hand Towel Dispenser"],
    ] as const) {
      expect(categoriseItem(item(code, name)), name).toBeNull();
    }
    // …while the linen ones beside them are still placed.
    expect(categoriseItem(item("HTW", "Hand Towels - White"))).toBe("hand_towels");
  });

  it("does not treat a charge or a sale as laundry", () => {
    expect(categoriseItem(item("LT", "Lost Towels"))).toBeNull();
    expect(categoriseItem(item("TBD", "New Towels Black - dozen"))).toBeNull();
    expect(categoriseItem(item("SAL", "Outsourced Washing Of Towels"))).toBeNull();
  });

  it("tells a container bag from laundry that is charged by the bag", () => {
    // The blanket `/\bbags?\b/` this started as swallowed all four of the
    // second group — a false exclusion, which is the quiet way to get this
    // wrong: the item simply stays uncategorised.
    for (const name of [
      "Blue Rhino Laundry Bags", "Laundry Bags - Royal", "Printed Laundry Bags",
      "Soluble Strip Bags", "710 X 1000 20UM HDPE Bags", "Garbage Bag Glad Black 240L Ro",
    ]) {
      expect(categoriseItem(item("x", name)), name).toBeNull();
    }
    expect(categoriseItem(item("TL", "Towels Per Bag"))).toBe("towels");
    expect(categoriseItem(item("TTL", "Tea Towels Per Bag"))).toBe("towels");
    expect(categoriseItem(item("OC13", "Rugby Tops per bag"))).toBe("uniforms");
    expect(categoriseItem(item("SB", "Sleeping Bags"))).toBe("linen");
  });

  it("does not turn toilet paper into bedding", () => {
    // "Toilet Paper 2Ply 400 Sheet" matches the generic `sheet` rule happily.
    expect(categoriseItem(item("TR-CAP400V", "Toilet Paper 2Ply 400 Sheet"))).toBeNull();
    expect(categoriseItem(item("100839", "Toilet Paper - Quilton"))).toBeNull();
  });
});

describe("categoriseItem — the kinds it does place", () => {
  it("puts the towel family under towels, as Harbour's tea towel already is", () => {
    for (const name of [
      "Tea Towel Blue Super Soaker", "Ttowel Jumbo Waffle 60x90 Asso",
      "Glass Cloth White With Blue St", "Glasscloth Cotton Printed",
      "Dish Cloth Otex Blue Stripe", "Face Washer Ultra 34x34 Charco",
      "Face Towel Charcoal", "Alliance Salon Towel Black", "Gym Towel White",
      "Small Beauty Towel", "Towels - Wash & Dry Only", "Client's Own Towels",
    ]) {
      expect(categoriseItem(item("x", name)), name).toBe("towels");
    }
  });

  it("separates bath towels, hand towels and bath mats", () => {
    expect(categoriseItem(item("BT", "Bath Towel - White"))).toBe("bath_towels");
    expect(categoriseItem(item("HTC", "Hand Towels - Charcoal"))).toBe("hand_towels");
    expect(categoriseItem(item("BMC", "Bath Mats - Charcoal"))).toBe("bath_mats");
    expect(categoriseItem(item("28654", "Bathmat Actil Downunder 50 x 7"))).toBe("bath_mats");
  });

  it("places bed and flat linen", () => {
    expect(categoriseItem(item("SH", "Sheets - Single Bed"))).toBe("sheets");
    expect(categoriseItem(item("32682", "Drawsheets"))).toBe("sheets");
    expect(categoriseItem(item("PC", "Pillow Case"))).toBe("pillowcases");
    expect(categoriseItem(item("TC", "Table Cloths"))).toBe("linen");
    expect(categoriseItem(item("Bl", "Blanket"))).toBe("linen");
    expect(categoriseItem(item("Cu", "Curtain"))).toBe("linen");
  });

  it("places what people wear", () => {
    expect(categoriseItem(item("Capes", "Capes"))).toBe("uniforms");
    expect(categoriseItem(item("OC15", "Rugby Tops - Extra Wash"))).toBe("uniforms");
  });
});

describe("categoriseItem — what it refuses to guess", () => {
  it("leaves everything the laundry buys rather than launders", () => {
    for (const name of [
      "Vinyl Gloves Clear Large", "FABRIC CONDITIONER 200L", "Fan Motor - IPSO DR 120G2",
      "Coffee Cup Biopak 12oz Single", "Level 3 Surgical Face Mask", "Delivery Charge",
      "Hand Sanitiser 500ML Pump Pack", "450 Litre Linen Tub Trolley",
    ]) {
      expect(categoriseItem(item("x", name)), name).toBeNull();
    }
  });

  it("leaves a name the export truncated past the point of saying what it is", () => {
    // MYOB cuts at 30 characters. These two lost the word that would have
    // placed them — their siblings "Ttowel Jumbo Waffle 60x90 Asso" and
    // "Ttowel Super Soaker Waffle Gre" are tea towels. Guessing from a sibling
    // is exactly the inference this rule declines to make.
    expect(categoriseItem(item("29927", "Waffle Check Super Soaker - Re"))).toBeNull();
    expect(categoriseItem(item("50761", "Waffle Check Jumbo - Blue"))).toBeNull();
  });

  it("leaves a service line that names no kind of laundry", () => {
    for (const name of ["Guest Laundry", "Laundry - Per Bag", "Laundry - Half Load", "Dry Only"]) {
      expect(categoriseItem(item("x", name)), name).toBeNull();
    }
  });
});

describe("categoryTally", () => {
  it("counts every kind and what is left over", () => {
    const tally = categoryTally([
      item("BT", "Bath Towel - White"),
      item("HTW", "Hand Towels - White"),
      item("Del", "Delivery Charge"),
    ]);
    expect(tally.bath_towels).toBe(1);
    expect(tally.hand_towels).toBe(1);
    expect(tally.uncategorised).toBe(1);
    expect(tally.sheets).toBe(0);
  });
});
