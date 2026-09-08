import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Everything a customer has is reachable from their record.
 *
 * Read the *source*, in the `one-door.test.ts` pattern, because none of these
 * files can be imported into vitest: each is an async server component that
 * reaches Supabase at module scope. The properties below are structural — a
 * missing `.eq()` and a link with the wrong query string are both invisible to a
 * typecheck and to every behavioural test in the suite, and both were live.
 *
 * What went wrong without it, on 511 real customers:
 *
 * - **The Customer laundry filter capped its picker at 200.** Six of the nine
 *   businesses that actually have jobs sort past 200th, so they could not be
 *   picked — and worse, a `<select>` whose `defaultValue` matches no option
 *   silently shows the first one, so arriving from a customer's "All jobs" link
 *   and pressing Search posted `customer=""` and threw the filter away.
 * - **Driver visits had no customer filter at all**, so the only link a customer
 *   record could offer for them would have shown every customer's visits.
 * - **`/jobs` opens on today**, so a customer link without `period=all` lands on
 *   an empty list — which reads as "no visits recorded", not as "wrong window".
 */

const app = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(app, ...parts), "utf8");

/** Strip comments, or the paragraphs *explaining* these defects would satisfy them. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the Customer laundry list can be filtered to any customer", () => {
  const source = code(read("orders", "page.tsx"));

  it("loads the picker to the shared cap rather than a literal of its own", () => {
    expect(source).toContain("CUSTOMER_LIMIT");
    // The cap that was live. Named so this fails on the value, not merely on the
    // absence of an import somebody could add beside it.
    expect(source).not.toMatch(/\.limit\(\s*200\s*\)/);
  });

  it("adds the filtered customer to the options when the cap left them out", () => {
    // Without this the select falls back to "Any customer" and the next submit
    // writes that back — the filter is lost with nothing on screen saying so.
    expect(source).toMatch(/params\.customer\s*&&\s*!\s*options\.some/);
  });

  it("still applies the filter to the query", () => {
    expect(source).toMatch(/params\.customer\)\s*query\s*=\s*query\.eq\("customer_id", params\.customer\)/);
  });
});

describe("Driver visits can be filtered to one customer", () => {
  const source = code(read("jobs", "page.tsx"));

  it("applies a customer filter to the query", () => {
    expect(source).toMatch(/query\.eq\("customer_id", params\.customer\)/);
  });

  it("counts customer among the filters, so the empty state and Clear are right", () => {
    // `isFiltered` drives *no rows match those filters* versus *there is nothing
    // here*, which need different next steps (§29).
    expect(source).toMatch(/FILTER_KEYS\s*=\s*\[[^\]]*"customer"/);
  });

  it("offers a picker rather than only honouring a link", () => {
    // The filter shipped reachable only by arriving from a customer's record,
    // which is half a feature: the screen itself had no way to choose one.
    expect(source).toContain('name: "customer"');
    expect(source).toContain("filterCustomers");
  });

  it("draws that picker for the office and not for a round", () => {
    // `/jobs` is gated on `routes.read`, which a board and a driver hold;
    // `customers.read` is what means "you may look a customer up", and neither
    // round-facing role has it. So a round loads no customer list at all.
    expect(source).toMatch(/can\(session\.role, "customers\.read"\)/);
  });

  it("shares the cap with the other two pickers rather than restating one", () => {
    expect(source).toContain("CUSTOMER_LIMIT");
    expect(source).not.toMatch(/\.limit\(\s*200\s*\)/);
  });
});

describe("a customer record reaches the rest of their history", () => {
  const source = code(read("customers", "[id]", "page.tsx"));

  it("links laundry jobs to the filtered list", () => {
    expect(source).toContain("/orders?customer=${customerId}");
  });

  it("links driver visits to the filtered list, over all time", () => {
    // Both halves matter: without `customer` it is every customer's visits, and
    // without `period=all` it is an empty list for all but today's.
    expect(source).toContain("/jobs?customer=${customerId}&period=all");
  });

  it("asks for a total, so a capped card cannot read as the whole of it", () => {
    // Two cards, both capped; both must count. `count: "exact"` is what lets
    // them say "the 10 most recent of 34" instead of implying there are 10.
    expect(source.match(/count: "exact"/g) ?? []).toHaveLength(2);
  });
});
