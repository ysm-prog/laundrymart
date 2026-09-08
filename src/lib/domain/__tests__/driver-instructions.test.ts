import { describe, expect, it } from "vitest";
import {
  driverInstructions, hasDriverInstructions, type InstructedJob,
} from "../driver-instructions";

const job = (overrides: InstructedJob = {}): InstructedJob => ({ ...overrides });

describe("driverInstructions", () => {
  it("says nothing when there is nothing to say", () => {
    expect(driverInstructions(job())).toEqual([]);
    expect(driverInstructions(job({
      delivery_instructions: "", special_instructions: "   ",
      customers: { special_instructions: null },
    }))).toEqual([]);
    expect(hasDriverInstructions(job())).toBe(false);
  });

  it("carries the customer's standing instructions, which My Runs never fetched", () => {
    // The defect this module exists for: `customers.special_instructions` is
    // where "gate code 1234" lives, and it reached no screen the round opens.
    const result = driverInstructions(job({
      customers: { special_instructions: "Gate code 1234, leave with reception" },
    }));
    expect(result).toEqual([
      { kind: "standing", label: "Always for this customer", text: "Gate code 1234, leave with reception" },
    ]);
    expect(hasDriverInstructions(job({ customers: { special_instructions: "x" } }))).toBe(true);
  });

  it("orders them most specific first", () => {
    const result = driverInstructions(job({
      customers: { special_instructions: "Always use the side door" },
      special_instructions: "Do not tumble dry",
      delivery_instructions: "Ring twice, they are upstairs",
    }));
    expect(result.map((entry) => entry.kind)).toEqual(["delivery", "handling", "standing"]);
    expect(result.map((entry) => entry.text)).toEqual([
      "Ring twice, they are upstairs", "Do not tumble dry", "Always use the side door",
    ]);
  });

  it("labels each one by where it came from, in the round's words", () => {
    const result = driverInstructions(job({
      delivery_instructions: "Ring twice",
      special_instructions: "No bleach",
      customers: { special_instructions: "Side door" },
    }));
    expect(result.map((entry) => entry.label)).toEqual([
      // "Machine instructions" is what the counter form calls that box; the
      // round should not meet a second name for one field.
      "For this delivery", "Machine instructions", "Always for this customer",
    ]);
  });

  it("says a repeated instruction once", () => {
    // A counter hand copying the customer's standing note onto the job is
    // ordinary; two headings over one sentence reads as two instructions.
    const result = driverInstructions(job({
      delivery_instructions: "Leave with reception",
      customers: { special_instructions: "leave with   Reception " },
    }));
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("delivery");
  });

  it("trims, and keeps the text otherwise exactly as it was typed", () => {
    const result = driverInstructions(job({
      delivery_instructions: "  Second\nfloor  ",
    }));
    // Trimmed at the ends and untouched in the middle: a line break inside a
    // driver's instruction is a line break they meant.
    expect(result[0]!.text).toBe("Second\nfloor");
  });

  it("shows the site's access note, which the depot screen fetched and never rendered", () => {
    const result = driverInstructions(job({
      customer_locations: { access_notes: "Rear lane, door 3. Bell is broken." },
    }));
    expect(result).toEqual([
      { kind: "access", label: "Getting in", text: "Rear lane, door 3. Bell is broken." },
    ]);
  });

  it("puts the site's note above the customer's, because a site is more specific", () => {
    // One business, three sites: one standing instruction and three back doors.
    const result = driverInstructions(job({
      customers: { special_instructions: "Invoice goes to head office" },
      customer_locations: { access_notes: "Rear lane, door 3" },
      special_instructions: "No bleach",
    }));
    expect(result.map((entry) => entry.kind)).toEqual(["handling", "access", "standing"]);
  });

  it("treats a missing customer as no standing instruction", () => {
    expect(driverInstructions(job({
      delivery_instructions: "Ring twice", customers: null,
    }))).toHaveLength(1);
  });
});
