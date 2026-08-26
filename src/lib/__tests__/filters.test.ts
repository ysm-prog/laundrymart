import { describe, expect, it } from "vitest";
import {
  activeFilterCount, filterHref, isFiltered, parseMulti, toggleMulti,
} from "@/lib/filters";

const STATUSES = ["new", "in_progress", "ready", "completed"] as const;

describe("parseMulti", () => {
  it("reads a comma-joined parameter", () => {
    expect(parseMulti("new,ready", STATUSES)).toEqual(["new", "ready"]);
  });

  it("drops anything not in the allowed set", () => {
    // These arrive off a URL somebody can type. An unrecognised value reaching a
    // query is either an error or a filter that silently matches nothing.
    expect(parseMulti("new,dropped,ready", STATUSES)).toEqual(["new", "ready"]);
    expect(parseMulti("nonsense", STATUSES)).toEqual([]);
  });

  it("is empty for absent, blank and whitespace", () => {
    expect(parseMulti(undefined, STATUSES)).toEqual([]);
    expect(parseMulti("", STATUSES)).toEqual([]);
    expect(parseMulti(" , ,", STATUSES)).toEqual([]);
  });

  it("tolerates padding and duplicates", () => {
    expect(parseMulti(" new , new ,ready", STATUSES)).toEqual(["new", "ready"]);
  });

  it("orders by the allowed set, so two links picking the same set are one link", () => {
    expect(parseMulti("ready,new", STATUSES)).toEqual(parseMulti("new,ready", STATUSES));
  });
});

describe("toggleMulti", () => {
  it("adds an absent value and removes a present one", () => {
    expect(toggleMulti(["new"], "ready", STATUSES)).toBe("new,ready");
    expect(toggleMulti(["new", "ready"], "new", STATUSES)).toBe("ready");
  });

  it("clears the key entirely when the last chip comes off", () => {
    // "no filter" and "filtering by nothing" must not be two URLs.
    expect(toggleMulti(["new"], "new", STATUSES)).toBeUndefined();
    expect(toggleMulti([], "new", STATUSES)).toBe("new");
  });

  it("keeps the allowed order however the chips were pressed", () => {
    expect(toggleMulti(["completed"], "new", STATUSES)).toBe("new,completed");
  });
});

describe("filterHref", () => {
  it("carries the filters already applied", () => {
    expect(filterHref("/orders", { q: "acme", status: "new" }, { priority: "urgent" }))
      .toBe("/orders?q=acme&status=new&priority=urgent");
  });

  it("clears a key set to undefined", () => {
    expect(filterHref("/orders", { q: "acme", status: "new" }, { status: undefined }))
      .toBe("/orders?q=acme");
  });

  it("returns the bare path when nothing is left", () => {
    expect(filterHref("/orders", { status: "new" }, { status: undefined })).toBe("/orders");
    expect(filterHref("/orders", {})).toBe("/orders");
  });

  it("always drops the page", () => {
    // Page 3 of an old filter is rarely page 3 of a new one and is quite often
    // past the end of it — an empty list that reads as "nothing matches".
    expect(filterHref("/orders", { page: "3", status: "new" }, { status: "ready" }))
      .toBe("/orders?status=ready");
  });

  it("drops a stale flash parameter rather than re-showing the message", () => {
    expect(filterHref("/orders", { error: "forbidden", ok: "1", q: "a" })).toBe("/orders?q=a");
  });

  it("escapes what it puts in the query", () => {
    expect(filterHref("/customers", { q: "a&b c" })).toBe("/customers?q=a%26b+c");
  });
});

describe("activeFilterCount", () => {
  it("counts only the keys it was given", () => {
    expect(activeFilterCount({ q: "a", status: "new", page: "2" }, ["q", "status"])).toBe(2);
    expect(activeFilterCount({ page: "2" }, ["q", "status"])).toBe(0);
  });

  it("treats blank and whitespace as no filter", () => {
    // An empty search box submits `?q=`, which is not a filter and must not make
    // an empty list say "no rows match those filters".
    expect(activeFilterCount({ q: "", status: "  " }, ["q", "status"])).toBe(0);
    expect(isFiltered({ q: "" }, ["q"])).toBe(false);
    expect(isFiltered({ q: "a" }, ["q"])).toBe(true);
  });
});
