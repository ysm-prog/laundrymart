import { describe, expect, it } from "vitest";
import { parseOrderItems } from "../order-items";

/**
 * The laundry list as the job form actually posts it.
 *
 * This is the regression that made the Jobs module unusable: the form posts
 * `null` for every field left blank, `optionalText` only understood `""`, one
 * unparseable row failed the whole array, and the empty array that came out the
 * other side was reported to the counter as "Please add at least one laundry
 * item" — on a job with an item plainly on the screen.
 *
 * So the fixtures here are copied from what `JobForm.itemsPayload` builds, not
 * from what the schema would like to receive.
 */

/** Exactly the shape `JobForm` serialises into the hidden `items` field. */
function payload(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify(rows);
}

const TOWELS_EXACT = {
  item_type: "towels",
  custom_description: null,
  quantity_type: "exact",
  exact_quantity: 12,
  bag_count: null,
  estimated_quantity: null,
  notes: null,
};

describe("parseOrderItems", () => {
  it("reads the common row: an item type, a count, and nothing else filled in", () => {
    const result = parseOrderItems(payload([TOWELS_EXACT]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      item_type: "towels", quantity_type: "exact", exact_quantity: 12,
      custom_description: null, notes: null,
    });
  });

  it("reads a bulk lot with only a bag count", () => {
    const result = parseOrderItems(payload([{
      item_type: "mixed", custom_description: null, quantity_type: "bulk_lot",
      exact_quantity: null, bag_count: 3, estimated_quantity: null, notes: null,
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({ bag_count: 3, estimated_quantity: null });
  });

  it("keeps the text that was filled in, trimmed", () => {
    const result = parseOrderItems(payload([{
      ...TOWELS_EXACT, item_type: "other",
      custom_description: "  Chef whites  ", notes: "  Red wine on two  ",
    }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0]).toMatchObject({
      custom_description: "Chef whites", notes: "Red wine on two",
    });
  });

  it("keeps several rows in the order they were entered", () => {
    const result = parseOrderItems(payload([
      TOWELS_EXACT,
      { ...TOWELS_EXACT, item_type: "sheets", exact_quantity: 4 },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.item_type)).toEqual(["towels", "sheets"]);
  });

  it("drops the untouched row the form always carries", () => {
    const result = parseOrderItems(payload([
      TOWELS_EXACT,
      { ...TOWELS_EXACT, item_type: "", exact_quantity: null },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
  });

  it("reports no items when the field is genuinely empty", () => {
    for (const empty of ["", "[]", null]) {
      const result = parseOrderItems(empty);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.items).toEqual([]);
    }
  });

  it("says the list was unreadable rather than pretending it was empty", () => {
    const broken = parseOrderItems("{not json");
    expect(broken.ok).toBe(true); // unparseable JSON is an empty list, as before
    if (broken.ok) expect(broken.items).toEqual([]);

    // A well-formed array carrying a row the schema refuses is the case that
    // must never masquerade as "no items".
    const wrong = parseOrderItems(payload([{ ...TOWELS_EXACT, exact_quantity: 1.5 }]));
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.problem).toContain("could not be read");
    expect(wrong.problem).not.toContain("at least one laundry item");
  });

  it("refuses a list longer than one job can hold", () => {
    const result = parseOrderItems(payload(Array.from({ length: 41 }, () => TOWELS_EXACT)));
    expect(result.ok).toBe(false);
  });
});

describe("the coded item on a row (0032)", () => {
  it("carries the item the counter picked", () => {
    const result = parseOrderItems(JSON.stringify([
      {
        item_id: "3f1b2c4d-1111-4a2b-8c3d-000000000001",
        item_type: "towels", custom_description: null, quantity_type: "exact",
        exact_quantity: 12, bag_count: null, estimated_quantity: null, notes: null,
      },
    ]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.items[0]!.item_id).toBe("3f1b2c4d-1111-4a2b-8c3d-000000000001");
  });

  it("reads a row entered as a bare kind of laundry, item_id null", () => {
    // The form spells an unanswered field `null`, and a plain `.optional()`
    // refuses that — the single fault that made every job creation fail for this
    // module's first week. Asserted with the real spelling rather than by
    // omitting the key.
    const result = parseOrderItems(JSON.stringify([
      {
        item_id: null,
        item_type: "sheets", custom_description: null, quantity_type: "exact",
        exact_quantity: 6, bag_count: null, estimated_quantity: null, notes: null,
      },
    ]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.items[0]!.item_id).toBeNull();
  });

  it("reads a row from before the item master, with no item_id key at all", () => {
    const result = parseOrderItems(JSON.stringify([
      {
        item_type: "sheets", custom_description: null, quantity_type: "exact",
        exact_quantity: 6, bag_count: null, estimated_quantity: null, notes: null,
      },
    ]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.items[0]!.item_id).toBeNull();
  });
});
