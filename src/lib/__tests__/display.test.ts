import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_SIZE, TEXT_SIZES, TEXT_SIZE_LABELS, nextTextSize, parseTextSize,
  textSizeActionLabel,
} from "@/lib/display";

describe("parseTextSize", () => {
  it("accepts every size it offers", () => {
    for (const size of TEXT_SIZES) expect(parseTextSize(size)).toBe(size);
  });

  it.each([
    ["null (storage disabled, or never set)", null],
    ["undefined (no attribute on the root element)", undefined],
    ["an older release's value", "huge"],
    ["a hand-edited entry", ""],
    ["the wrong type entirely", 3],
  ])("falls back to the default for %s", (_why, value) => {
    expect(parseTextSize(value)).toBe(DEFAULT_TEXT_SIZE);
  });
});

describe("nextTextSize", () => {
  it("steps upwards through the sizes in order", () => {
    expect(nextTextSize("normal")).toBe("large");
    expect(nextTextSize("large")).toBe("xlarge");
  });

  // One button serves all three sizes, so the largest has to lead somewhere. A
  // control that silently stops responding reads as broken, and the header has
  // no room to explain that you have reached the end.
  it("wraps round from the largest rather than stopping", () => {
    expect(nextTextSize("xlarge")).toBe("normal");
  });

  it("visits every size before repeating", () => {
    const seen = new Set([DEFAULT_TEXT_SIZE]);
    let size = DEFAULT_TEXT_SIZE;
    for (let i = 0; i < TEXT_SIZES.length - 1; i++) {
      size = nextTextSize(size);
      seen.add(size);
    }
    expect(seen.size).toBe(TEXT_SIZES.length);
  });
});

describe("textSizeActionLabel", () => {
  // The button names the size it moves *to*, which is the promise ThemeToggle
  // makes ("Switch to dark mode" while you are looking at the light one).
  it("names the size it will move to, not the one you are on", () => {
    expect(textSizeActionLabel("normal")).toBe("Make text large");
    expect(textSizeActionLabel("large")).toBe("Make text biggest");
    expect(textSizeActionLabel("xlarge")).toBe("Make text normal");
  });
});

describe("TEXT_SIZE_LABELS", () => {
  it("names every size, so the picker cannot render a blank option", () => {
    for (const size of TEXT_SIZES) {
      expect(TEXT_SIZE_LABELS[size].label).toBeTruthy();
      expect(TEXT_SIZE_LABELS[size].hint).toBeTruthy();
    }
  });

  // The audience for this feature is the reason it exists: somebody who does
  // not know what "typography", "scale" or "115%" mean. If a label needs one of
  // those words to make sense, it is the wrong label.
  it("describes each size without a word of jargon", () => {
    const jargon = /\b(font|typograph|scale|rem|px|percent|%|zoom|magnif)/i;
    for (const size of TEXT_SIZES) {
      const { label, hint } = TEXT_SIZE_LABELS[size];
      expect(`${label} ${hint}`).not.toMatch(jargon);
    }
  });
});
