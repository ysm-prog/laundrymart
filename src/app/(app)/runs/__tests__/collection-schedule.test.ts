import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The weekly collection is wired the way the rules say it is.
 *
 * `collections.ts` (the domain rule) has its own behavioural tests and 0047 has
 * its own pgTAP proof. What neither can see is the **wiring**, and every
 * property below is one this repo has shipped broken behind a green `verify`:
 * a form that posts a column its own page never read, a capability gate that
 * quietly widened, and a read feeding a write with no tenant on it. All three
 * are invisible to a typecheck.
 *
 * Read the *source*, in the `one-door.test.ts` pattern, because none of these
 * modules can be imported into vitest: the action is a `"use server"` module and
 * both pages are async server components reaching Supabase at module scope.
 */

const root = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

/** Strip comments, or the paragraphs *explaining* each rule would satisfy it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("putting the day's collections on their rounds", () => {
  const actions = code(read("app", "(app)", "runs", "actions.ts"));

  it("was found, and still holds the action", () => {
    // Non-vacuous: an empty read would satisfy every assertion below.
    expect(actions).toContain("createCollectionStops");
  });

  it("is gated on routes.write, not routes.sequence and not routes.read", () => {
    // Planning, not ordering. `routes.sequence` is the Owner's and the Office
    // manager's alone (0036) and would lock a dispatcher out of their own job;
    // `routes.read` is held by a board, which may not put work on a round.
    expect(actions).toMatch(
      /createCollectionStops\(formData: FormData\): Promise<void> \{\s*const session = await assertCapability\("routes\.write"\)/,
    );
  });

  it("reports a batch that only half worked as a failure, naming the first", () => {
    // A partial batch reported as a success is how the missing half is never
    // found — the call `describeUnpriced` and the bulk move both make.
    expect(actions).toMatch(/outcome\.failures\.length > 0/);
    expect(actions).toMatch(/could not be added/);
  });

  it("treats 'everything is already on a round' as success, not as an error", () => {
    // It is the ordinary state after the first press of the day. Reporting it
    // red is how people learn to ignore the message.
    expect(actions).toMatch(/created === 0 && outcome\.failures\.length === 0[\s\S]{0,200}return done\(/);
  });
});

describe("the read that feeds that write", () => {
  const source = code(read("lib", "runs", "collections.ts"));

  it("names the tenant (§23)", () => {
    // `is_member()` is true of every laundry for a platform admin, and every
    // customer id this returns is posted straight back into a scoped write.
    expect(source).toMatch(/\.from\("customers"\)[\s\S]{0,400}\.eq\("tenant_id", tenantId\)/);
    expect(source).toMatch(/\.from\("jobs"\)[\s\S]{0,400}\.eq\("tenant_id", tenantId\)/);
  });

  it("creates a collection stop, not a delivery one", () => {
    // A delivery stop would put the round's collection capture behind the wrong
    // half of `/run`, and would take the wrong door: `customer_locations`
    // carries `is_pickup` and `is_delivery` separately.
    expect(source).toContain("findOrCreateCollectionStop");
    expect(source).not.toContain("assignOneJobToBoard");
  });

  it("resolves each board's run once, not once per customer", () => {
    // Twenty customers on one round is one run; asking twenty times is twenty
    // chances to open a second one.
    expect(source).toMatch(/runs = new Map/);
  });
});

describe("the stop finder that both callers share", () => {
  const source = code(read("lib", "runs", "assign.ts"));

  it("passes the service type through to the row it inserts", () => {
    expect(source).toMatch(/service_type: serviceType/);
    expect(source).not.toMatch(/service_type: "delivery"/);
  });

  it("takes the door that matches the call", () => {
    expect(source).toMatch(/serviceType === "pickup" \? "is_pickup" : "is_delivery"/);
  });

  it("widens an existing stop to both rather than adding a second visit", () => {
    // The round knocks once: a delivery booked for Tuesday and a standing
    // Tuesday collection are one call at one address.
    expect(source).toMatch(/service_type: "both"/);
  });

  it("never retires a stop that is not purely a delivery", () => {
    // Nothing points at a collection stop through `laundry_orders`, so "no
    // orders left" does not mean "nothing to do here".
    expect(source).toMatch(/stop\.service_type !== "delivery"\) return;/);
  });
});

describe("the arrangement on the customer's own record", () => {
  const actions = code(read("app", "(app)", "customers", "actions.ts"));
  const editPage = code(read("app", "(app)", "customers", "[id]", "edit", "page.tsx"));
  const form = code(read("app", "(app)", "customers", "customer-form.tsx"));

  it("can be taken away again, not only set", () => {
    // `optionalUuid` and `count` fold an empty box to `undefined`, which
    // supabase-js drops — so a customer put on a Tuesday round could never be
    // taken off one. `clearable` is the fix and the reason it moved into
    // `lib/actions.ts`.
    expect(actions).toMatch(/collection_weekday: clearable\(/);
    expect(actions).toMatch(/collection_board_id: clearable\(/);
  });

  it("bounds the weekday in the action as well as in the database", () => {
    // A refusal from Postgres names a constraint; a person choosing a day needs
    // a sentence. Both halves must agree or the form offers a refused value.
    expect(actions).toMatch(/\.min\(1, "Choose a day of the week"\)/);
    expect(actions).toMatch(/\.max\(7, "Choose a day of the week"\)/);
  });

  it("reads back both columns the form posts", () => {
    // A form that posts a field its own page never read clears it on every
    // save. Invisible to a typecheck; the drift §25 records for `ITEM_COLUMNS`.
    expect(editPage).toContain("collection_weekday, collection_board_id");
  });

  it("offers only the rounds of this laundry", () => {
    expect(editPage).toMatch(/listActiveBoards\(supabase, session\.tenantId\)/);
  });

  it("names both fields exactly as the action reads them", () => {
    expect(form).toMatch(/name="collection_weekday"/);
    expect(form).toMatch(/name="collection_board_id"/);
  });

  it("lets a day be chosen back to nothing", () => {
    // The placeholder is what posts "" — without it the select has no option
    // meaning "no standing collection" and the arrangement is a one-way door.
    expect(form).toMatch(/placeholder="No standing collection"/);
  });
});

describe("where the screen sits", () => {
  const nav = code(read("lib", "nav.ts"));
  const page = code(read("app", "(app)", "runs", "collections", "page.tsx"));

  it("is a tab under Runs, gated on routes.write", () => {
    // A board holds `routes.read` and cannot put work on a round, so offering
    // it the tab would be offering a screen it can only look at — and the list
    // is of customers, which `customers.read` governs and a board lacks.
    expect(nav).toMatch(/href: "\/runs\/collections", capability: "routes\.write"/);
  });

  it("gates the page itself the same way, not one step looser", () => {
    // The tab is presentation; the page is the boundary. A screen reachable by
    // typing its URL is a screen anybody with a session can open.
    expect(page).toMatch(/requireCapability\("routes\.write"\)/);
  });

  it("leaves the area itself on routes.read, so a board still reaches Run order", () => {
    expect(nav).toMatch(/href: "\/runs", capability: "routes\.read"/);
  });
});
