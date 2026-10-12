import { describe, expect, it } from "vitest";
import { listboxKey } from "../listbox-keys";

describe("listboxKey", () => {
  it("highlights the FIRST option on the first ArrowDown, not the second", () => {
    expect(listboxKey("ArrowDown", -1, 3)).toEqual({ kind: "move", active: 0 });
    expect(listboxKey("ArrowDown", 0, 3)).toEqual({ kind: "move", active: 1 });
    expect(listboxKey("ArrowDown", 2, 3)).toEqual({ kind: "move", active: 0 });
  });
  it("Enter with nothing highlighted never submits the form", () => {
    expect(listboxKey("Enter", -1, 3)).toEqual({ kind: "swallow" });
    expect(listboxKey("Enter", -1, 0)).toEqual({ kind: "swallow" });
  });
  it("Enter picks the highlighted option", () => {
    expect(listboxKey("Enter", 0, 3)).toEqual({ kind: "pick", index: 0 });
  });
  it("ArrowUp from nothing goes to the last", () => {
    expect(listboxKey("ArrowUp", -1, 3)).toEqual({ kind: "move", active: 2 });
  });
  it("leaves other keys alone", () => {
    expect(listboxKey("a", 0, 3)).toEqual({ kind: "ignore" });
    expect(listboxKey("Escape", 0, 3)).toEqual({ kind: "close" });
  });
});
