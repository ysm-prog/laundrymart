import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A server action that reads a row by an id **posted from a form** must name the
 * tenant, and this walks the source to prove none forgets.
 *
 * §23 is the reason. `is_member()` is true of *every* laundry for a
 * `platform_admin` (0019), and both real owner logins hold that role — so RLS
 * does not narrow those sessions to the laundry they are working in, while every
 * write is filtered to it. A read that trusts RLS therefore answers about a
 * different business from the one the write will touch, and the two disagree:
 *
 *   - an audit `before` snapshot recorded against another laundry's row;
 *   - a precondition checked against figures that are not the ones being written;
 *   - and, twice over before this landed, `select("*")` by posted id whose result
 *     was spread straight into an `insert` — so duplicating a contract or a route
 *     template could have copied another laundry's row into this one.
 *
 * A source sweep rather than a behavioural test, for `one-door.test.ts`'s reason:
 * these are `"use server"` modules that reach `lib/env`, so vitest can neither
 * import nor render them. What is reachable is their text.
 *
 * Deliberately narrow. It does **not** flag:
 *   - display reads in pages (correct for ten of the eleven roles, and a platform
 *     admin is *allowed* to read across laundries — the hazard is mixing, not
 *     disclosure);
 *   - ids *derived* from an already-filtered read, which are safe by derivation —
 *     `invoices/prices/actions.ts` is the worked example, and a scan that flagged
 *     it would be a scan people learn to ignore;
 *   - `tenants`, `platform_admins`, `platform_settings`, which carry no
 *     `tenant_id` at all.
 */

const SRC = join(__dirname, "..", "..");

/** Tables with no `tenant_id` column: unfiltered is the only possible spelling. */
const NO_TENANT_COLUMN = new Set(["tenants", "platform_admins", "platform_settings"]);

/** An id that arrived in the request rather than from a query we already scoped. */
const POSTED = /parsed|\.data\b|formData|params|input\./;

function serverActionFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "__tests__") serverActionFiles(path, found);
    } else if (entry.endsWith(".ts")) {
      // The directive has to be the first statement, so the head is enough.
      if (readFileSync(path, "utf8").slice(0, 200).includes('"use server"')) found.push(path);
    }
  }
  return found;
}

type Offender = { file: string; table: string; key: string };

function unscopedReads(file: string): Offender[] {
  const text = readFileSync(file, "utf8");
  const out: Offender[] = [];
  for (const match of text.matchAll(/\.from\(\s*"([a-z_]+)"/g)) {
    const table = match[1];
    if (table === undefined || NO_TENANT_COLUMN.has(table)) continue;

    // The whole chained statement, which is where the filter would sit.
    const tail = text.slice(match.index ?? 0);
    const end = /;\s*\n/.exec(tail);
    const statement = end ? tail.slice(0, end.index) : tail.slice(0, 500);

    if (statement.includes("tenant_id")) continue;
    if (/\.(insert|update|upsert|delete)\(/.test(statement)) continue;

    const key = /\.eq\(\s*"id"\s*,\s*([^)\n]+)\)/.exec(statement)?.[1];
    if (key !== undefined && POSTED.test(key)) {
      out.push({ file: file.slice(SRC.length + 1), table, key: key.trim() });
    }
  }
  return out;
}

describe("a server action reading by a posted id names its tenant", () => {
  const files = serverActionFiles(SRC);

  it("found the server actions to scan", () => {
    // Non-vacuous: a walk that found nothing would pass the assertion below.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(join("orders", "actions.ts")))).toBe(true);
  });

  it("recognises the shape it exists to catch", () => {
    const posted = /\.eq\(\s*"id"\s*,\s*([^)\n]+)\)/.exec('.eq("id", parsed.data.id)')?.[1];
    expect(posted !== undefined && POSTED.test(posted)).toBe(true);
    // and leaves an id derived from an earlier scoped query alone
    const derived = /\.eq\(\s*"id"\s*,\s*([^)\n]+)\)/.exec('.eq("id", existingId)')?.[1];
    expect(derived !== undefined && POSTED.test(derived)).toBe(false);
  });

  it("has no server action reading by a posted id without a tenant filter", () => {
    const offenders = files.flatMap(unscopedReads);
    expect(offenders.map((o) => `${o.file} -> ${o.table} keyed on ${o.key}`)).toEqual([]);
  });
});
