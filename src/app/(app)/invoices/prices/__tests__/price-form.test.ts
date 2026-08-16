import { describe, expect, it } from "vitest";
import { bagField, parsePriceForm, taxableField, unitField } from "../price-form";

/**
 * Written against what the price screen actually posts: all nine kinds of
 * laundry, every time, with the unpriced ones blank. That is the case the
 * parser exists for — a blank field has to clear a price, never store a zero.
 */
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("parsePriceForm", () => {
  it("reads a priced row, GST included", () => {
    const parsed = parsePriceForm(form({
      [unitField("towels")]: "2.50",
      [taxableField("towels")]: "on",
    }));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([
      { itemType: "towels", unitPrice: 2.5, bagPrice: null, taxable: true },
    ]);
    expect(parsed.cleared).toContain("sheets");
    expect(parsed.cleared).toHaveLength(8);
  });

  it("treats an unticked GST box as not taxable", () => {
    const parsed = parsePriceForm(form({ [unitField("towels")]: "2" }));
    expect(parsed.ok && parsed.entries[0]?.taxable).toBe(false);
  });

  it("keeps a bag price without a piece price", () => {
    const parsed = parsePriceForm(form({ [bagField("uniforms")]: "12" }));
    expect(parsed.ok && parsed.entries).toEqual([
      { itemType: "uniforms", unitPrice: 0, bagPrice: 12, taxable: false },
    ]);
  });

  it("clears a row left blank rather than storing zero", () => {
    const parsed = parsePriceForm(form({
      [unitField("towels")]: "", [bagField("towels")]: "  ",
    }));
    expect(parsed.ok && parsed.entries).toEqual([]);
    expect(parsed.ok && parsed.cleared).toContain("towels");
  });

  it("keeps an explicit zero, which is not the same as blank", () => {
    const parsed = parsePriceForm(form({ [unitField("towels")]: "0" }));
    expect(parsed.ok && parsed.entries[0]).toMatchObject({ itemType: "towels", unitPrice: 0 });
    expect(parsed.ok && parsed.cleared).not.toContain("towels");
  });

  it("rounds to cents rather than letting the database do it", () => {
    const parsed = parsePriceForm(form({ [unitField("towels")]: "1.005" }));
    expect(parsed.ok && parsed.entries[0]?.unitPrice).toBe(1.01);
  });

  it("refuses a negative price, naming the row", () => {
    const parsed = parsePriceForm(form({ [unitField("bath_mats")]: "-1" }));
    expect(parsed).toEqual({
      ok: false, error: "Bath mats: enter a price of zero or more, or leave it blank.",
    });
  });

  it("refuses something that is not a number", () => {
    const parsed = parsePriceForm(form({ [bagField("sheets")]: "two dollars" }));
    expect(parsed.ok).toBe(false);
  });

  it("clears every row when the whole form is empty", () => {
    const parsed = parsePriceForm(form({}));
    expect(parsed.ok && parsed.entries).toEqual([]);
    expect(parsed.ok && parsed.cleared).toHaveLength(9);
  });
});
