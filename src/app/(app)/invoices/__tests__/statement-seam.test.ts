import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Statements screen's form and the two actions it posts to, read as source.
 * `actions.ts` is a `"use server"` module that reaches `lib/env`, so it cannot be
 * imported here; and a field name the form posts that the action never reads is
 * the seam this repo has shipped broken behind a green `verify` three times. The
 * statement date is the one that matters: a statement sent from a list dated the
 * 31st must not quietly go out dated today.
 */

const dir = join(process.cwd(), "src/app/(app)/invoices/statements");
const form = readFileSync(join(dir, "statement-selection.tsx"), "utf8");
const actions = readFileSync(join(dir, "actions.ts"), "utf8");
const route = readFileSync(join(process.cwd(), "src/app/api/customers/[id]/statement/route.ts"), "utf8");

describe("the Statements form and its actions", () => {
  it.each(["as_at", "upto", "return_to", "selected", "id"])("posts %s, which the actions read", (field) => {
    expect(form).toContain(`name="${field}"`);
    // `return_to` is read through `returnTo()`, which re-checks it is a same-site path.
    const reader = field === "return_to"
      ? /returnTo\(formData, /
      : new RegExp(`formData\\.(get|getAll)\\("${field}"\\)`);
    expect(actions).toMatch(reader);
  });

  it("passes the statement date to both sends", () => {
    expect(actions.match(/statementOptions\(formData\)/g)?.length).toBe(2);
  });

  it("asks the PDF route for the same date and choice the list was drawn with", () => {
    expect(form).toContain("as_at=${asAt}");
    expect(form).toContain("&upto=0");
    expect(form).toContain("&download=1");
    for (const param of ['get("as_at")', 'get("upto")', 'get("download")']) expect(route).toContain(param);
  });
});
