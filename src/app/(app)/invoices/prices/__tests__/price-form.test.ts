import { describe, expect, it } from "vitest";
import {
  bagField, parsePriceForm, PRESENT_FIELD, taxableField, unitField,
} from "../price-form";

/**
 * Written against what the price screen actually posts: a `present` field per
 * item code it is showing, plus that row's three inputs, with the unpriced ones
 * blank. That is the case the parser exists for — a blank field has to clear a
 * price, never store a zero, and never touch a code the form was not showing.
 */
const T22 = "11111111-1111-4111-8111-111111111111";
const TW = "22222222-2222-4222-8222-222222222222";
const HTW = "33333333-3333-4333-8333-333333333333";

const LABELS = new Map([
  [T22, "T22 — Towels - Black"],
  [TW, "TW — Towels - Wash & Dry Only"],
  [HTW, "HTW — Hand Towels - White"],
]);

/** The rows the form is showing, with whatever was typed into them. */
function form(present: string[], fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const id of present) data.append(PRESENT_FIELD, id);
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("parsePriceForm", () => {
  it("reads a priced row, GST included", () => {
    const parsed = parsePriceForm(form([T22, TW], {
      [unitField(T22)]: "0.24",
      [taxableField(T22)]: "on",
    }), LABELS);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.entries).toEqual([
      { itemId: T22, unitPrice: 0.24, bagPrice: null, taxable: true },
    ]);
    expect(parsed.cleared).toEqual([TW]);
  });

  it("treats an unticked GST box as not taxable", () => {
    const parsed = parsePriceForm(form([T22], { [unitField(T22)]: "2" }));
    expect(parsed.ok && parsed.entries[0]?.taxable).toBe(false);
  });

  it("keeps a bag price without a piece price", () => {
    const parsed = parsePriceForm(form([HTW], { [bagField(HTW)]: "12" }));
    expect(parsed.ok && parsed.entries).toEqual([
      { itemId: HTW, unitPrice: 0, bagPrice: 12, taxable: false },
    ]);
  });

  it("clears a row left blank rather than storing zero", () => {
    const parsed = parsePriceForm(form([T22], {
      [unitField(T22)]: "", [bagField(T22)]: "  ",
    }));
    expect(parsed.ok && parsed.entries).toEqual([]);
    expect(parsed.ok && parsed.cleared).toEqual([T22]);
  });

  it("keeps an explicit zero, which is not the same as blank", () => {
    const parsed = parsePriceForm(form([T22], { [unitField(T22)]: "0" }));
    expect(parsed.ok && parsed.entries[0]).toMatchObject({ itemId: T22, unitPrice: 0 });
    expect(parsed.ok && parsed.cleared).not.toContain(T22);
  });

  it("rounds to cents rather than letting the database do it", () => {
    const parsed = parsePriceForm(form([T22], { [unitField(T22)]: "1.005" }));
    expect(parsed.ok && parsed.entries[0]?.unitPrice).toBe(1.01);
  });

  it("refuses a negative price, naming the item code", () => {
    const parsed = parsePriceForm(form([T22], { [unitField(T22)]: "-1" }), LABELS);
    expect(parsed).toEqual({
      ok: false,
      error: "T22 — Towels - Black: enter a price of zero or more, or leave it blank.",
    });
  });

  it("refuses something that is not a number", () => {
    const parsed = parsePriceForm(form([TW], { [bagField(TW)]: "two dollars" }));
    expect(parsed.ok).toBe(false);
  });

  /*
   * The safety property the `present` field exists for, and the one the
   * nine-category form it replaces could not have had.
   *
   * Nine rows could always all be posted, so "not posted" and "posted blank"
   * were the same thing and it was safe to read the absence as a clear. This
   * form shows a searched slice of 254 items, and reading the absence the same
   * way would delete the price of every code that did not happen to be on
   * screen. Both directions are asserted, because only the pair proves it.
   */
  it("never touches an item the form was not showing", () => {
    const parsed = parsePriceForm(form([T22], { [unitField(TW)]: "9.99" }));
    expect(parsed.ok && parsed.entries).toEqual([]);
    expect(parsed.ok && parsed.cleared).toEqual([T22]);
  });

  it("clears nothing at all when the form posts no rows", () => {
    const parsed = parsePriceForm(form([]));
    expect(parsed.ok && parsed.entries).toEqual([]);
    expect(parsed.ok && parsed.cleared).toEqual([]);
  });

  it("reads a repeated item once rather than in both lists", () => {
    // A duplicated `present` would otherwise be read twice: priced on the first
    // pass and, because `getAll` returns it again, considered again on the
    // second — which for a blank row would land the same id in `cleared` as
    // well, and the action would insert and delete the same price in one save.
    const parsed = parsePriceForm(form([T22, T22], { [unitField(T22)]: "1.50" }));
    expect(parsed.ok && parsed.entries).toEqual([
      { itemId: T22, unitPrice: 1.5, bagPrice: null, taxable: false },
    ]);
    expect(parsed.ok && parsed.cleared).toEqual([]);
  });

  it("falls back to the id when the caller cannot name the item", () => {
    // The screen and the item list disagreeing is worth surfacing rather than
    // hiding: a row posted for a code the server cannot resolve is a refusal
    // somebody has to see, even if all it can say is the id.
    const parsed = parsePriceForm(form([T22], { [unitField(T22)]: "-1" }));
    expect(parsed).toEqual({
      ok: false, error: `${T22}: enter a price of zero or more, or leave it blank.`,
    });
  });
});
