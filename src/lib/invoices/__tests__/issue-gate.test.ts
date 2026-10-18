import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every way a draft becomes a tax invoice goes through one gate (brief 1.1).
 *
 * The single Issue button, Issue now on the drafts board, Issue Selected on the
 * register and the drafts board's bulk list all call `issueOneInvoice`, and it
 * checks the laundry's ABN, address and bank details before it reads or writes
 * anything. Read from the source for the reason `one-door.test.ts` gives: these
 * modules reach `lib/env` and cannot be imported into vitest.
 */

const src = join(__dirname, "..", "..", "..");
const read = (file: string) => readFileSync(join(src, file), "utf8");

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** `.from("invoices")` … `.update({ … status: "issued"`, within one statement. */
const ISSUE_WRITE = /\.from\(\s*["']invoices["']\s*\)\s*\.update\(\s*\{[^}]*?(?<![\w_])status:\s*["']issued["']/;

describe("one gate onto issuing", () => {
  it("has issue.ts as the only module that writes an invoice to issued", () => {
    const issue = code(read("lib/invoices/issue.ts"));
    expect(issue, "the pattern must match the one place that does issue").toMatch(ISSUE_WRITE);

    const offenders = walk(src)
      .filter((path) => !path.endsWith(join("lib", "invoices", "issue.ts")))
      .filter((path) => !path.includes(join("app", "design-preview")))
      .filter((path) => ISSUE_WRITE.test(code(readFileSync(path, "utf8"))))
      .map((path) => relative(src, path));
    expect(offenders).toEqual([]);
  });

  it("checks the invoice details before it reads or writes anything", () => {
    const issue = code(read("lib/invoices/issue.ts"));
    const body = issue.slice(issue.indexOf("export async function issueOneInvoice"));
    const gate = body.indexOf("ready.blocked");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf(".from(\"invoices\")"));
    expect(gate).toBeLessThan(body.indexOf("recalculate_invoice"));
  });

  it("refuses a bulk issue once, before the loop, rather than forty times", () => {
    const bulk = code(read("app/(app)/invoices/bulk-actions.ts"));
    const body = bulk.slice(bulk.indexOf("export async function issueSelectedInvoices"));
    expect(body.indexOf("loadIssueReadiness")).toBeGreaterThan(-1);
    expect(body.indexOf("loadIssueReadiness")).toBeLessThan(body.indexOf("for (const id of ids)"));
  });

  it("draws every Issue button through the gated control", () => {
    for (const file of [
      "app/(app)/invoices/[id]/page.tsx",
      "app/(app)/invoices/page.tsx",
      "app/(app)/invoices/drafts/draft-card.tsx",
    ]) {
      expect(code(read(file)), `${file} draws Issue through IssueControl`).toMatch(/<IssueControl\b/);
    }
    // The bulk lists confirm and carry the block.
    for (const file of ["app/(app)/invoices/page.tsx", "app/(app)/invoices/drafts/page.tsx"]) {
      const source = code(read(file));
      const issueList = source.slice(source.indexOf("action={issueSelectedInvoices}"));
      expect(issueList.slice(0, 600), `${file}'s bulk issue confirms`).toMatch(/confirmIssue/);
      expect(issueList.slice(0, 600), `${file}'s bulk issue carries the block`).toMatch(/blocked=/);
    }
  });
});
