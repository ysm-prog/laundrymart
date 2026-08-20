import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARCHIVE_TABLE_LABELS, archiveTableLabel } from "@/lib/archive";

/**
 * The database owns the list of archived tables; this file owns their names.
 * Pinned from both directions, the way `RUN_NOT_STARTED_STATUSES` is pinned to
 * `runStage()`: a table added to one and forgotten in the other is exactly the
 * kind of drift that ships green and shows up as a raw schema name on a screen
 * an owner is looking at.
 */
const MIGRATION = fileURLToPath(
  new URL("../../../supabase/migrations/0017_archive_records.sql", import.meta.url),
);

/** The `archivable_tables()` array, read out of the migration itself. */
function tablesFromMigration(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const body = sql.match(/create or replace function public\.archivable_tables\(\)[\s\S]*?select array\[([\s\S]*?)\]::text\[\]/);
  const array = body?.[1];
  if (!array) throw new Error("could not find archivable_tables() in 0017");
  return [...array.matchAll(/'([a-z_]+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe("the archive's table list", () => {
  const tables = tablesFromMigration();

  it("is not empty, so a broken parse cannot pass this file", () => {
    expect(tables.length).toBeGreaterThan(10);
  });

  it("covers the three record kinds the archive is named for", () => {
    expect(tables).toEqual(expect.arrayContaining(["customers", "laundry_orders", "invoices"]));
  });

  it("leaves configuration and reference data alone", () => {
    // An archived tenant has to come back to an app that still knows its own
    // setup: its sites, its linen, its fleet and its people.
    for (const table of ["depots", "items", "vehicles", "drivers", "memberships", "tenants",
                         "public_holidays", "inventory_pools", "route_templates"]) {
      expect(tables).not.toContain(table);
    }
  });

  it("gives every archived table a label", () => {
    const unlabelled = tables.filter((t) => !(t in ARCHIVE_TABLE_LABELS));
    expect(unlabelled).toEqual([]);
  });

  it("labels no table the archive does not cover", () => {
    const stale = Object.keys(ARCHIVE_TABLE_LABELS).filter((t) => !tables.includes(t));
    expect(stale).toEqual([]);
  });

  it("keeps Jobs and Stops the right way round", () => {
    // /orders is the customer's laundry; /jobs is a visit on a run (§6).
    expect(archiveTableLabel("laundry_orders")).toBe("Jobs");
    expect(archiveTableLabel("jobs")).toBe("Stops");
  });

  it("falls back to something readable rather than blank", () => {
    expect(archiveTableLabel("some_new_table")).toBe("some new table");
  });
});
