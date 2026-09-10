import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The collection loop is wired the way the rules say it is.
 *
 * `pickup-intake.ts` (the domain rule) has its own behavioural tests and 0050
 * has its own pgTAP proof. What neither can see is the **wiring**, and every
 * property below is one this repo has shipped broken behind a green `verify`: a
 * form posting a field its action never reads, a read feeding a write with no
 * tenant on it, a capability gate that quietly widened, and — the one specific
 * to this feature — a reader that disagrees with the unique index it is standing
 * in front of.
 *
 * Read the *source*, in the `one-door.test.ts` pattern, because none of these
 * modules can be imported into vitest: the action is a `"use server"` module,
 * both pages are async server components reaching Supabase at module scope, and
 * the loader takes a live client.
 */

const root = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const repo = (...parts: string[]) => readFileSync(join(root, "..", ...parts), "utf8");

/** Strip comments, or the paragraphs *explaining* each rule would satisfy it. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the field the form posts and the action reads", () => {
  const form = code(read("app", "(app)", "orders", "job-form.tsx"));
  const actions = code(read("app", "(app)", "orders", "actions.ts"));

  it("was found, and both files still hold what is being compared", () => {
    // Non-vacuous: an empty read would satisfy every assertion below.
    expect(form).toContain("JobSeed");
    expect(actions).toContain("createOrder");
  });

  /**
   * The producer/consumer seam. This exact shape — a form field name and the
   * schema that reads it — has disagreed three times in this repo, and twice it
   * shipped: the job form's own items, and the dispatch planner's whole board.
   * Here the failure would be silent in the worse direction: the job saves, the
   * link is never written, and the collection comes up as waiting to be taken in
   * for ever.
   */
  it("agree on the name `source_pickup_id`", () => {
    expect(form).toMatch(/name="source_pickup_id" value=\{seed\.source_pickup_id\}/);
    expect(actions).toMatch(/source_pickup_id: optionalUuid/);
    expect(actions).toMatch(/source_pickup_id: parsed\.data\.source_pickup_id \?\? null/);
  });

  /**
   * Written once, at take-in, and never afterwards. `toRow` is shared by
   * `createOrder` and `updateOrder`, so a `source_pickup_id` in it would let an
   * edit point the job at a different collection — or clear it — and a cleared
   * link is a collection that can be taken in a second time.
   */
  it("do NOT carry the link through toRow, so an edit cannot move or clear it", () => {
    const toRow = actions.slice(actions.indexOf("function toRow"));
    const body = toRow.slice(0, toRow.indexOf("\n}"));
    expect(body).toContain("customer_id: input.customer_id");
    expect(body).not.toContain("source_pickup_id");
  });
});

describe("reading a collection to take in", () => {
  const loader = code(read("lib", "runs", "pickup-intake.ts"));
  const migration = repo("supabase", "migrations", "0050_pickup_to_job.sql");

  it("was found, and still holds both reads", () => {
    expect(loader).toContain("collectionToTakeIn");
    expect(loader).toContain("takenInByPickup");
  });

  /**
   * §23: a read whose ids are posted into a write names its tenant. `is_member()`
   * is true of every laundry for a platform admin, so an unfiltered read would
   * offer one business's collection to a counter working in another — where the
   * guard refuses it with a sentence they can do nothing about.
   */
  it("names the tenant on every read, because each one feeds a write", () => {
    const reads = loader.match(/\.from\("[a-z_]+"\)/g) ?? [];
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect((loader.match(/\.eq\("tenant_id", tenantId\)/g) ?? []).length).toBe(reads.length);
  });

  /**
   * The reader and the index have to draw the same line. `uq_laundry_orders_source_pickup`
   * is partial on `status <> 'cancelled'`, so cancelling a job releases the
   * collection; a reader that counted cancelled jobs would hide a "Take in" link
   * the database would happily accept, and one that ignored the clause entirely
   * would offer a link the database refuses.
   */
  it("excludes a cancelled job exactly as the unique index does", () => {
    expect(migration).toMatch(/where source_pickup_id is not null and status <> 'cancelled'/);
    expect((loader.match(/\.neq\("status", "cancelled"\)/g) ?? []).length).toBe(2);
  });

  it("asks the domain rule what the laundry rows are rather than mapping them itself", () => {
    // A second mapping is a second answer to "what does a collection become",
    // and the one no unit test reaches is the one that drifts.
    expect(loader).toContain("intakeItemsFromPickup");
    expect(loader).not.toContain("damaged_quantity +");
  });
});

describe("the screens that offer it", () => {
  const newJob = code(read("app", "(app)", "orders", "new", "page.tsx"));
  const collections = code(read("app", "(app)", "operations", "pickups", "page.tsx"));
  const stop = code(read("app", "(app)", "jobs", "[id]", "page.tsx"));

  it("were found, and still hold the entry points", () => {
    expect(newJob).toContain("collectionToTakeIn");
    expect(collections).toContain("/orders/new?pickup=");
    expect(stop).toContain("/orders/new?pickup=");
  });

  /**
   * A board and a driver hold `operations.read` and `routes.read` and take
   * nothing in, so they get no link at all rather than one that lands on a
   * screen the auth gate bounces them off — and no extra query either, since the
   * read is skipped with it.
   */
  it("offer the take-in only to a role that can actually take laundry in", () => {
    expect(collections).toMatch(/canWrite: can\(session\.role, "orders\.write"\)/);
    expect(collections).toMatch(/if \(!canWrite\) return/);
    expect(stop).toMatch(/canTakeIn=\{can\(session\.role, "orders\.write"\)\}/);
    expect(stop).toMatch(/\{canTakeIn \? <TakeInLink/);
  });

  it("skip the extra read for a role that cannot act on the answer", () => {
    expect(collections).toMatch(/intake\.canRead\s*\?\s*await takenInByPickup/);
    expect(stop).toMatch(/canTakeIn\s*\?\s*await takenInByPickup/);
  });

  /**
   * Refused before the form is drawn, not on save. The guard's sentence arrives
   * after a screenful of counts has been re-confirmed, and the answer the
   * counter actually wants is the job it is already on.
   */
  it("stop a second take-in at the page, and link to the job it is already on", () => {
    expect(newJob).toMatch(/if \(collection\?\.takenInAs\)/);
    expect(newJob).toMatch(/bill them twice/);
    expect(newJob).toMatch(/\/orders\/\$\{collection\.takenInAs\.id\}/);
  });

  it("come back to the seeded form after a rejection, not to a blank one", () => {
    // A rejection redirects, so the browser's copy is gone either way. Coming
    // back to the seeded address restores the collection's rows rather than the
    // single blank one an unseeded form starts with.
    expect(newJob).toMatch(/returnPath = collection \? `\/orders\/new\?pickup=\$\{collection\.id\}`/);
  });

  it("say on the seeded form what deliberately did not come across", () => {
    // The one sentence that stops a counter reading the damaged and missing
    // counts off the collection and adding them to the laundry list.
    expect(newJob).toContain("PICKUP_INTAKE_EXCLUSIONS");
  });
});
