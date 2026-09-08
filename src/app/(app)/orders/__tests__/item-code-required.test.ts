import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The item-code rule is actually asked, by both writers, on a real count.
 *
 * `validateItem` gained `itemCodeRequired` and has its own tests; what those
 * cannot see is whether anything ever passes it. That seam is the failure this
 * repo keeps recording — a rule that exists, is tested, and is never called
 * reads as shipped and does nothing. `createOrder` and `updateOrder` are
 * `"use server"` modules reaching `lib/env`, so vitest can neither import nor
 * render them; their source is what is reachable.
 *
 * The condition matters as much as the call. Requiring a code unconditionally
 * would give a laundry with no item master a job form nobody could submit — so
 * the gate is a head count of sellable items, and it fails **open**: a read that
 * errors leaves the form behaving as it did before, because refusing to take
 * laundry in is a worse outcome than an unpriced row.
 */

const ACTIONS = join(__dirname, "..", "actions.ts");
const FORM = join(__dirname, "..", "job-form.tsx");

/** Strip comments, or the paragraphs explaining the rule would satisfy it. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("an item code is required where there is an item master", () => {
  const actions = code(ACTIONS);

  it("was found, and still validates its items", () => {
    // Non-vacuous: an empty read would satisfy every assertion below.
    expect(actions).toContain("validateItem");
    expect(actions).toContain("crossFieldProblem");
  });

  it("passes the requirement through to the rule", () => {
    expect(actions).toMatch(/validateItem\(item, index \+ 1, \{ itemCodeRequired \}\)/);
  });

  it("asks both writers, not just the one that creates a job", () => {
    // An edit that could drop the code would leave the five stranded jobs
    // stranded, and would be a second door onto the state this closes.
    const calls = actions.match(/crossFieldProblem\(\s*\n?\s*parsed\.data, items, await hasItemMaster\(/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("decides it from a head count of sellable items, scoped to the tenant", () => {
    expect(actions).toMatch(/async function hasItemMaster/);
    expect(actions).toMatch(/count: "exact", head: true/);
    expect(actions).toMatch(/\.eq\("tenant_id", tenantId\)/);
    expect(actions).toMatch(/\.eq\("is_sell", true\)/);
  });

  it("fails open, so a broken read cannot stop laundry being taken in", () => {
    expect(actions).toMatch(/if \(error\) return false;/);
  });

  it("marks the field required on the form", () => {
    // Decorative — the picker holds a search term, not the chosen value — but a
    // field the server will refuse must say so before the round trip.
    expect(code(FORM)).toMatch(/purpose="laundry"[\s\S]{0,80}required/);
  });
});
