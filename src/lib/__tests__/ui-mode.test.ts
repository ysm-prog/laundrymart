import { describe, expect, it } from "vitest";
import { DEFAULT_UI_MODE, parseUiMode, serialiseUiMode } from "@/lib/ui-mode";

describe("parseUiMode", () => {
  it("defaults to the full app when nothing has been chosen", () => {
    // Every tenant alive today has a settings blob written before this existed.
    // Whatever this returns, they get it without anyone deciding — so it has to
    // be the mode that takes nothing away.
    expect(parseUiMode(undefined)).toBe("full");
    expect(parseUiMode({})).toBe("full");
    expect(parseUiMode({ notifications: { inApp: {} } })).toBe("full");
    expect(DEFAULT_UI_MODE).toBe("full");
  });

  it("reads a stored mode", () => {
    expect(parseUiMode({ ui_mode: "simple" })).toBe("simple");
    expect(parseUiMode({ ui_mode: "full" })).toBe("full");
  });

  it("never throws on a hand-edited column", () => {
    // jsonb is opaque to Postgres, so the shape is only as good as this parser.
    for (const raw of [null, "simple", 7, [], { ui_mode: "SIMPLE" }, { ui_mode: null }]) {
      expect(parseUiMode(raw)).toBe("full");
    }
  });
});

describe("serialiseUiMode", () => {
  it("keeps the rest of the settings bag", () => {
    // The notification screen and this one write the same column. Saving either
    // must not reset a preference it does not show.
    const existing = { notifications: { inApp: { invoice_overdue: false } } };
    expect(serialiseUiMode("simple", existing)).toEqual({
      notifications: { inApp: { invoice_overdue: false } },
      ui_mode: "simple",
    });
  });

  it("survives a column that is not an object", () => {
    expect(serialiseUiMode("simple", null)).toEqual({ ui_mode: "simple" });
    expect(serialiseUiMode("full", ["nonsense"])).toEqual({ ui_mode: "full" });
  });

  it("round-trips", () => {
    expect(parseUiMode(serialiseUiMode("simple", {}))).toBe("simple");
  });
});
