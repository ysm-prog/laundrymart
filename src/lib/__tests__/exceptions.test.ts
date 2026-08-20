import { describe, expect, it } from "vitest";
import { packExceptionNotes, parseExceptionNotes } from "../exceptions";

const PATH = "11111111-1111-1111-1111-111111111111/exception/ref-abc123/photo-0.jpg";

describe("packExceptionNotes", () => {
  it("keeps a plain note plain", () => {
    expect(packExceptionNotes("Gate locked", [])).toBe("Gate locked");
  });

  it("returns null when there is nothing at all", () => {
    expect(packExceptionNotes("", [])).toBeNull();
    expect(packExceptionNotes(null, [])).toBeNull();
  });

  it("appends photo markers after the note", () => {
    expect(packExceptionNotes("Gate locked", [PATH])).toBe(`Gate locked\n[photo:${PATH}]`);
  });

  it("carries photos with no note", () => {
    expect(packExceptionNotes(null, [PATH])).toBe(`[photo:${PATH}]`);
  });
});

describe("parseExceptionNotes", () => {
  it("round-trips note and photos", () => {
    const packed = packExceptionNotes("Gate locked, no answer", [PATH, PATH.replace("photo-0", "photo-1")]);
    const parsed = parseExceptionNotes(packed);
    expect(parsed.note).toBe("Gate locked, no answer");
    expect(parsed.photos).toEqual([PATH, PATH.replace("photo-0", "photo-1")]);
  });

  it("passes through legacy plain-text notes untouched", () => {
    expect(parseExceptionNotes("Just a note from the office")).toEqual({
      note: "Just a note from the office", photos: [],
    });
  });

  it("is calm about null and empty", () => {
    expect(parseExceptionNotes(null)).toEqual({ note: "", photos: [] });
    expect(parseExceptionNotes("")).toEqual({ note: "", photos: [] });
  });
});
