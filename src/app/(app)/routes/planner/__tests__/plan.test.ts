import { describe, expect, it } from "vitest";
import { averageWeights, estimateLoad, isMovable, isReceiving, lockReason } from "../plan";

describe("isMovable", () => {
  it("allows a stop nobody has touched", () => {
    expect(isMovable({ status: "assigned", progress_status: "not_started" })).toBe(true);
  });

  it("allows an exception to be re-dispatched", () => {
    // The whole point of seeing exceptions on the board is to move them.
    expect(isMovable({ status: "exception", progress_status: "not_started" })).toBe(true);
  });

  it("refuses a stop the driver has arrived at", () => {
    expect(isMovable({ status: "in_progress", progress_status: "at_customer" })).toBe(false);
  });

  it("refuses completed and cancelled stops", () => {
    expect(isMovable({ status: "completed", progress_status: "completed" })).toBe(false);
    expect(isMovable({ status: "cancelled", progress_status: "not_started" })).toBe(false);
  });
});

describe("lockReason", () => {
  it("names why a stop is pinned", () => {
    expect(lockReason({ status: "completed", progress_status: "completed" })).toBe("Completed");
    expect(lockReason({ status: "cancelled", progress_status: "not_started" })).toBe("Cancelled");
    expect(lockReason({ status: "in_progress", progress_status: "travelling" })).toBe("Driver on site");
    expect(lockReason({ status: "assigned", progress_status: "not_started" })).toBeNull();
  });
});

describe("isReceiving", () => {
  it("closes the board on finished runs only", () => {
    expect(isReceiving("planned")).toBe(true);
    expect(isReceiving("in_progress")).toBe(true);
    expect(isReceiving("closed")).toBe(false);
    expect(isReceiving("cancelled")).toBe(false);
  });
});

describe("averageWeights", () => {
  it("averages a customer's weighed collections", () => {
    const averages = averageWeights([
      { customer_id: "a", total_weight_kg: 100 },
      { customer_id: "a", total_weight_kg: 200 },
      { customer_id: "b", total_weight_kg: 50 },
    ]);
    expect(averages.get("a")).toBe(150);
    expect(averages.get("b")).toBe(50);
  });

  it("only counts the most recent sample, so old volumes do not anchor it", () => {
    // Rows arrive newest-first; with a sample of 2 the trailing 1000 is ignored.
    const averages = averageWeights(
      [
        { customer_id: "a", total_weight_kg: 10 },
        { customer_id: "a", total_weight_kg: 20 },
        { customer_id: "a", total_weight_kg: 1000 },
      ],
      2,
    );
    expect(averages.get("a")).toBe(15);
  });

  it("ignores rows with no usable weight", () => {
    const averages = averageWeights([
      { customer_id: "a", total_weight_kg: null },
      { customer_id: "a", total_weight_kg: 0 },
      { customer_id: "b", total_weight_kg: "80" },
    ]);
    expect(averages.has("a")).toBe(false);
    expect(averages.get("b")).toBe(80);
  });
});

describe("estimateLoad", () => {
  it("reports how many stops the estimate actually covers", () => {
    const load = estimateLoad(
      [{ estimateKg: 100 }, { estimateKg: 150 }, { estimateKg: null }],
      800,
    );
    expect(load.kg).toBe(250);
    expect(load.known).toBe(2);
    expect(load.unknown).toBe(1);
    expect(load.over).toBe(false);
  });

  it("flags a run over the vehicle's rating", () => {
    const load = estimateLoad([{ estimateKg: 500 }, { estimateKg: 400 }], 800);
    expect(load.over).toBe(true);
    expect(load.ratio).toBeCloseTo(900 / 800);
  });

  it("has no opinion without a rated vehicle", () => {
    const load = estimateLoad([{ estimateKg: 500 }], null);
    expect(load.ratio).toBeNull();
    expect(load.over).toBe(false);
  });

  it("is empty, not zero-confident, when nothing has been weighed", () => {
    const load = estimateLoad([{ estimateKg: null }, { estimateKg: null }], 800);
    expect(load.kg).toBe(0);
    expect(load.known).toBe(0);
    expect(load.unknown).toBe(2);
  });
});
