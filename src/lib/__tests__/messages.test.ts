import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FIELD_LABELS, databaseMessage, fieldLabel, validationMessage } from "@/lib/messages";

/** The shape `validationMessage` reads, built the way Zod really builds it. */
function issuesFor(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the schema to refuse this value");
  return result.error.issues;
}

describe("fieldLabel", () => {
  it("uses the words on the label where the derived name would be wrong", () => {
    expect(fieldLabel(["depot_id"])).toBe("Site");
    expect(fieldLabel(["special_instructions"])).toBe("Machine instructions");
    expect(fieldLabel(["abn"])).toBe("ABN (the business tax number)");
  });

  // A field added tomorrow gets no entry here, and must still read as English
  // rather than as nothing.
  it("derives a readable name for a field it has never seen", () => {
    expect(fieldLabel(["delivery_window_start"])).toBe("Delivery window start");
    expect(fieldLabel(["trailer_registration"])).toBe("Trailer registration");
  });

  // `_id` is a database suffix. The person picked a customer, not a customer id.
  it("drops the id suffix when deriving", () => {
    expect(fieldLabel(["supplier_id"])).toBe("Supplier");
  });

  // The job form, the contract wizard and the planner all post arrays, so the
  // path is `items.2.quantity`. "Items 2 quantity" is an index nobody counted.
  it("keeps only the last named segment of a nested path", () => {
    expect(fieldLabel(["items", 2, "quantity"])).toBe("Quantity");
    expect(fieldLabel(["lines", 0, "unit_price"])).toBe("Price each");
  });

  it("returns nothing for a path with no named segment", () => {
    expect(fieldLabel([])).toBe("");
    expect(fieldLabel([0])).toBe("");
  });
});

describe("validationMessage", () => {
  it("names a missing field and says what to do about it", () => {
    const issues = issuesFor(z.object({ customer_id: z.string() }), {});
    expect(validationMessage(issues)).toBe('Please check "Customer" — it needs to be filled in.');
  });

  it("reports a badly-formed value as wrong rather than as missing", () => {
    const issues = issuesFor(z.object({ received_date: z.number() }), { received_date: "x" });
    expect(validationMessage(issues)).toBe('Please check "Date it came in" — it does not look right.');
  });

  // A message written on purpose in the schema already says the useful thing.
  it("passes a message we wrote through as an instruction", () => {
    const issues = issuesFor(
      z.object({ unit_price: z.number().min(0, "Cannot be negative") }),
      { unit_price: -1 },
    );
    expect(validationMessage(issues)).toBe('Please check "Price each" — Cannot be negative.');
  });

  it("carries a form-wide refusal on its own, having no box to point at", () => {
    const schema = z.object({ a: z.string() })
      .refine(() => false, { message: "Pick a delivery date after the collection date" });
    expect(validationMessage(issuesFor(schema, { a: "x" })))
      .toBe("Pick a delivery date after the collection date.");
  });

  it("has something to say when handed no issues at all", () => {
    expect(validationMessage([])).toBe(
      "Something on that form was not right. Please check it and try again.",
    );
  });

  // The whole point of the change: the previous format was `field: message`.
  it("never renders a snake_case schema key", () => {
    for (const key of Object.keys(FIELD_LABELS)) {
      const issues = issuesFor(z.object({ [key]: z.string() }), {});
      expect(validationMessage(issues)).not.toContain(key);
    }
  });
});

describe("databaseMessage", () => {
  it("explains the codes it recognises without naming a constraint", () => {
    expect(databaseMessage({ code: "23505", message: 'duplicate key value violates unique constraint "uq_x"' }))
      .toBe("That value is already in use. Please use a different one.");
    expect(databaseMessage({ code: "42501", message: "permission denied for table invoices" }))
      .toContain("not allowed");
  });

  // The case that mattered: it used to `return error.message`, so Postgres
  // talked straight to a counter — table names, column names and all.
  it("never relays an unrecognised Postgres message", () => {
    const message = databaseMessage({
      code: "22P02",
      message: 'invalid input syntax for type uuid: "abc" at character 42 in relation laundry_orders',
    });
    expect(message).not.toContain("laundry_orders");
    expect(message).not.toContain("uuid");
    expect(message).toContain("nothing was changed");
  });

  it("says nothing changed when there is no code at all", () => {
    expect(databaseMessage({ message: "socket hang up" })).not.toContain("socket");
  });

  // Our own triggers raise sentences meant for people, so they are kept — but
  // they interpolate the row's raw status, which is not a word anybody says.
  it("keeps our own trigger messages and spaces out the status in them", () => {
    expect(databaseMessage({
      code: "P0001",
      message: "ERROR:  a job cannot go from ready_for_delivery to out_for_delivery",
    })).toBe("a job cannot go from ready for delivery to out for delivery");
  });

  it("leaves a trigger message with no raw status untouched", () => {
    expect(databaseMessage({ code: "P0001", message: "a job is assigned to a board, not to a driver" }))
      .toBe("a job is assigned to a board, not to a driver");
  });
});
