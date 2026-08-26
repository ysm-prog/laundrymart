import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FIELD_LABELS, HANDLED_DB_CODES, databaseMessage, fieldLabel, validationMessage,
} from "@/lib/messages";

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

/*
 * The kinds Zod 4 really produces for the validators this app uses.
 *
 * The first version of `validationMessage` was a denylist of Zod's known
 * default wordings, and it missed two whole families — `z.enum()` and a bare
 * `.min()`/`.max()` — so a counter was shown
 * `Invalid option: expected one of "van"|"truck"|"ute"` and
 * `Too small: expected number to be >=1950`. The tests at the time exercised
 * neither, which is how it shipped behind a green suite. This table is the
 * regression: every row is a validator that exists somewhere in `src/`.
 */
describe("validationMessage never relays Zod's own wording", () => {
  const cases: Array<[string, z.ZodType, unknown]> = [
    ["a missing enum (vehicle_type)", z.object({ vehicle_type: z.enum(["van", "truck", "ute"]) }), {}],
    ["a wrong enum value", z.object({ vehicle_type: z.enum(["van", "truck"]) }), { vehicle_type: "boat" }],
    ["a number below a bare .min()", z.object({ year: z.number().min(1950) }), { year: 1900 }],
    ["a number above a bare .max()", z.object({ year: z.number().max(2100) }), { year: 3000 }],
    ["a string below a bare .min()", z.object({ name: z.string().min(3) }), { name: "a" }],
    ["a string above a bare .max()", z.object({ name: z.string().max(3) }), { name: "abcdef" }],
    ["a non-integer", z.object({ bag_count: z.number().int() }), { bag_count: 1.5 }],
    ["a bad email", z.object({ billing_email: z.string().email() }), { billing_email: "x" }],
    ["a bad uuid", z.object({ customer_id: z.string().uuid() }), { customer_id: "x" }],
    ["a bad url", z.object({ href: z.string().url() }), { href: "x" }],
    ["a bare regex", z.object({ postcode: z.string().regex(/^\d{4}$/) }), { postcode: "xx" }],
    ["a missing field", z.object({ customer_id: z.string() }), {}],
    ["a null where a string was wanted", z.object({ name: z.string() }), { name: null }],
    ["an empty array below .min(1)", z.object({ items: z.array(z.string()).min(1) }), { items: [] }],
    ["a failed union", z.object({ q: z.union([z.string(), z.number()]) }), { q: true }],
    ["a wrong literal", z.object({ mode: z.literal("yes") }), { mode: "no" }],
  ];

  it.each(cases)("says something a person can act on for %s", (_label, schema, value) => {
    const message = validationMessage(issuesFor(schema, value));
    // None of Zod's generated vocabulary, in any form.
    expect(message).not.toMatch(/invalid (input|option|string|email|uuid|url)/i);
    expect(message).not.toMatch(/too (small|big)/i);
    expect(message).not.toMatch(/received (undefined|null|number|boolean|string)/i);
    expect(message).not.toMatch(/expected (one of|number|string|int|array)/i);
    expect(message).not.toMatch(/[><]=/);          // >=1950
    expect(message).not.toMatch(/\|/);              // "van"|"truck"
    expect(message).not.toMatch(/must match pattern/i);
    expect(message).not.toContain("/^");            // a raw regular expression
    // And it is a sentence, not a fragment.
    expect(message.length).toBeGreaterThan(12);
    expect(message).toMatch(/[.!?]$/);
  });

  it("offers the choices rather than listing the stored values", () => {
    const issues = issuesFor(z.object({ vehicle_type: z.enum(["van", "truck"]) }), {});
    expect(validationMessage(issues))
      .toBe('Please check "Kind of vehicle" — please pick one of the choices offered.');
  });

  it("gives a number bound in words", () => {
    expect(validationMessage(issuesFor(z.object({ year: z.number().min(1950) }), { year: 1900 })))
      .toBe('Please check "Year" — it cannot be less than 1950.');
  });

  it("treats a picker's id as a choice that did not come through", () => {
    // A uuid is posted by a picker and never typed, so "that is not a valid
    // UUID" describes a thing the person never saw.
    expect(validationMessage(issuesFor(z.object({ customer_id: z.string().uuid() }), { customer_id: "x" })))
      .toBe('Please check "Customer" — that choice did not come through. Please pick it again.');
  });

  // The other half of the guard: a message somebody wrote on purpose must still
  // survive, or the fix would have made every schema message useless.
  it("still passes our own messages through untouched", () => {
    for (const [schema, value, expected] of [
      [z.object({ unit_price: z.number().min(0, "Cannot be negative") }), { unit_price: -1 },
       'Please check "Price each" — Cannot be negative.'],
      [z.object({ received_date: z.string().regex(/^x$/, "Use the date picker") }), { received_date: "q" },
       'Please check "Date it came in" — Use the date picker.'],
      [z.object({ bag_count: z.number().int("Whole numbers only") }), { bag_count: 1.5 },
       'Please check "Number of bags" — Whole numbers only.'],
    ] as const) {
      expect(validationMessage(issuesFor(schema, value))).toBe(expected);
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

describe("HANDLED_DB_CODES", () => {
  // The set exists so `describeDbError` need not keep its own copy for the
  // logging decision. If they ever disagree, an unhandled code either logs
  // nothing or a handled one logs noise on every occurrence.
  it("names exactly the codes databaseMessage answers specifically", () => {
    for (const code of HANDLED_DB_CODES) {
      expect(databaseMessage({ code, message: "raw postgres detail" }))
        .not.toContain("nothing was changed");
    }
  });

  it("leaves everything else to the generic answer", () => {
    for (const code of ["22P02", "40001", "57014", "08006"]) {
      expect(HANDLED_DB_CODES.has(code)).toBe(false);
      expect(databaseMessage({ code, message: "raw postgres detail" }))
        .toContain("nothing was changed");
    }
  });
});
