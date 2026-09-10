import { describe, expect, it } from "vitest";
import {
  INTAKE_SKIP_TEXT, PICKUP_INTAKE_EXCLUSIONS, describeSkipped, intakeItemsFromPickup,
  type PickupItem, type PickupLine,
} from "../pickup-intake";
import { validateItem } from "../laundry-orders";

const towel: PickupItem = {
  id: "11111111-1111-4111-8111-111111111111",
  item_code: "TOW001", name: "Bath towel", laundry_category: "bath_towels", pickable: true,
};
const uncategorised: PickupItem = {
  id: "22222222-2222-4222-8222-222222222222",
  item_code: "GL", name: "Gloves - Blue", laundry_category: null, pickable: true,
};
const retired: PickupItem = {
  id: "33333333-3333-4333-8333-333333333333",
  item_code: "OLD", name: "Old sheet", laundry_category: "sheets", pickable: false,
};

const catalogue = new Map([towel, uncategorised, retired].map((item) => [item.id, item]));

function line(over: Partial<PickupLine> & { item_id: string }): PickupLine {
  return { quantity: 0, damaged_quantity: 0, missing_quantity: 0, ...over };
}

describe("what a collection carries into a laundry job", () => {
  it("carries the collected count, the item and the driver's note", () => {
    const { items, skipped } = intakeItemsFromPickup(
      [line({ item_id: towel.id, quantity: 12, notes: "  two short  " })], catalogue,
    );
    expect(skipped).toEqual([]);
    expect(items).toEqual([{
      item_id: towel.id,
      item_type: "bath_towels",
      custom_description: null,
      quantity_type: "exact",
      exact_quantity: 12,
      bag_count: null,
      estimated_quantity: null,
      notes: "two short",
    }]);
  });

  /**
   * The defect this whole feature is one mistake away from. Both columns are
   * already billed off `pickup_lines` by the month-end run — damaged and missing
   * as replacement charges — so a seeded row carrying either would put the same
   * lost towel on the same invoice twice.
   */
  it("does NOT carry damaged or missing quantities into the job", () => {
    const { items } = intakeItemsFromPickup(
      [line({ item_id: towel.id, quantity: 12, damaged_quantity: 3, missing_quantity: 2 })],
      catalogue,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.exact_quantity).toBe(12);
    expect(JSON.stringify(items[0])).not.toContain("3");
    expect(Object.values(items[0] ?? {})).not.toContain(2);
  });

  it("leaves off a line that recorded only damage or loss, and says why", () => {
    const { items, skipped } = intakeItemsFromPickup(
      [line({ item_id: towel.id, quantity: 0, damaged_quantity: 4 })], catalogue,
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([{ label: "TOW001 · Bath towel", reason: "nothing_collected" }]);
  });

  it("keeps the order the lines were counted in", () => {
    const { items } = intakeItemsFromPickup([
      line({ item_id: uncategorised.id, quantity: 2 }),
      line({ item_id: towel.id, quantity: 5 }),
    ], catalogue);
    expect(items.map((item) => item.item_id)).toEqual([uncategorised.id, towel.id]);
  });
});

describe("the kind of laundry a seeded row claims", () => {
  it("comes from the item, so a seeded row and a typed row land in one bucket", () => {
    const { items } = intakeItemsFromPickup([line({ item_id: towel.id, quantity: 1 })], catalogue);
    expect(items[0]?.item_type).toBe("bath_towels");
  });

  it("is `other`, described by the item's name, when the item has no category", () => {
    // 129 of this laundry's 254 items carry no category. Dropping the count over
    // a blank field on another screen would lose a real collection.
    const { items, skipped } = intakeItemsFromPickup(
      [line({ item_id: uncategorised.id, quantity: 7 })], catalogue,
    );
    expect(skipped).toEqual([]);
    expect(items[0]).toMatchObject({
      item_id: uncategorised.id, item_type: "other",
      custom_description: "Gloves - Blue", exact_quantity: 7,
    });
  });

  /**
   * The seed has to survive the form it is seeding. `validateItem` is what
   * `createOrder` runs, so a row this rule emits that it refuses would be a
   * pre-filled form that cannot be saved and says nothing useful about why.
   */
  it("produces rows the job form's own validator accepts, item code required", () => {
    const { items } = intakeItemsFromPickup([
      line({ item_id: towel.id, quantity: 12 }),
      line({ item_id: uncategorised.id, quantity: 7, notes: "left in reception" }),
    ], catalogue);
    expect(items).toHaveLength(2);
    for (const [index, item] of items.entries()) {
      expect(validateItem(item, index + 1, { itemCodeRequired: true })).toBeNull();
    }
  });
});

describe("a line that cannot become a row", () => {
  it("names an item that is no longer on the list rather than seeding a blank picker", () => {
    const { items, skipped } = intakeItemsFromPickup(
      [line({ item_id: retired.id, quantity: 4 })], catalogue,
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([{ label: "OLD · Old sheet", reason: "item_retired" }]);
  });

  it("answers for an item it has never heard of, rather than dropping it silently", () => {
    const { items, skipped } = intakeItemsFromPickup(
      [line({ item_id: "99999999-9999-4999-8999-999999999999", quantity: 4 })], catalogue,
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([{ label: "Item 99999999", reason: "item_unknown" }]);
  });

  it("answers every line — carried or named — so nothing disappears", () => {
    const lines = [
      line({ item_id: towel.id, quantity: 3 }),
      line({ item_id: retired.id, quantity: 4 }),
      line({ item_id: towel.id, quantity: 0, missing_quantity: 1 }),
    ];
    const { items, skipped } = intakeItemsFromPickup(lines, catalogue);
    expect(items.length + skipped.length).toBe(lines.length);
  });
});

describe("what the counter is told", () => {
  it("says why each line was left off, in a sentence", () => {
    expect(describeSkipped([{ label: "TOW001 · Bath towel", reason: "nothing_collected" }]))
      .toEqual(["TOW001 · Bath towel was left off — nothing was collected on that line."]);
  });

  it("has wording for every reason the rule can produce", () => {
    for (const reason of ["nothing_collected", "item_unknown", "item_retired"] as const) {
      expect(INTAKE_SKIP_TEXT[reason]).toBeTruthy();
    }
  });

  it("states the double-billing rule where somebody would otherwise re-type it", () => {
    expect(PICKUP_INTAKE_EXCLUSIONS).toMatch(/damaged or missing/i);
    expect(PICKUP_INTAKE_EXCLUSIONS).toMatch(/twice/i);
  });
});
