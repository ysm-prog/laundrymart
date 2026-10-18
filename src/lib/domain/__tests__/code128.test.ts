import { describe, expect, it } from "vitest";
import {
  CODE128_PATTERNS, START_B, STOP, code128BBars, code128BValues, encodableInCode128B,
} from "../code128";

describe("the Code 128 symbol table (brief 3.4)", () => {
  it("has 107 symbols", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
  });
  it("gives every data symbol six elements of 11 modules, and the stop seven of 13", () => {
    // The standard's own invariant: a typo in any width breaks one of these.
    CODE128_PATTERNS.slice(0, 106).forEach((pattern, value) => {
      expect(pattern, String(value)).toMatch(/^[1-4]{6}$/);
      expect([...pattern].reduce((sum, d) => sum + Number(d), 0), String(value)).toBe(11);
    });
    expect(CODE128_PATTERNS[STOP]).toBe("2331112");
  });
  it("gives every symbol an even number of bar modules, and no two symbols the same pattern", () => {
    // Bars (positions 0, 2, 4) always sum to an even count in Code 128.
    CODE128_PATTERNS.slice(0, 106).forEach((pattern, value) => {
      const bars = Number(pattern[0]) + Number(pattern[2]) + Number(pattern[4]);
      expect(bars % 2, String(value)).toBe(0);
    });
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });
});

describe("encoding a job number", () => {
  it("frames the characters with start B, the check symbol and stop", () => {
    // "LJ00032": L=44 J=42 0=16 0=16 0=16 3=19 2=18.
    const values = code128BValues("LJ00032");
    expect(values[0]).toBe(START_B);
    expect(values.slice(1, 8)).toEqual([44, 42, 16, 16, 16, 19, 18]);
    const check = (104 + 44 * 1 + 42 * 2 + 16 * 3 + 16 * 4 + 16 * 5 + 19 * 6 + 18 * 7) % 103;
    expect(values[8]).toBe(check);
    expect(values.at(-1)).toBe(STOP);
  });
  it("is 11 modules a symbol plus 13 for the stop", () => {
    const { width } = code128BBars("LJ00032");
    expect(width).toBe(11 * (1 + 7 + 1) + 13);
  });
  it("refuses what subset B cannot carry", () => {
    expect(encodableInCode128B("")).toBe(false);
    expect(encodableInCode128B("LJé00032")).toBe(false);
    expect(() => code128BValues("")).toThrow();
  });
});
