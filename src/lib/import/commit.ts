import { createClient } from "@/lib/supabase/server";
import type { ExistingParties, ImportPlan } from "@/lib/domain/myob";

/**
 * Executing an import plan.
 *
 * Everything here goes through the **RLS-bound** client, so the tenant boundary
 * is enforced by the database rather than by this file remembering to filter.
 * `tenant_id` is still stamped on every row from the session, in one place, so
 * no row can carry a different one — and the `with check` half of the policy
 * would refuse it if one did.
 *
 * The write is not a transaction. PostgREST has no way to hold one across
 * requests, so a failure part-way leaves the rows already written in place.
 * That is survivable here and nowhere near as bad as it sounds: every statement
 * is an upsert keyed on a natural key, so the fix for a partial import is to
 * upload the same files again.
 */

type Client = Awaited<ReturnType<typeof createClient>>;

/** The ordinary path: one upsert per batch on a real unique index. */
async function writeByUpsert(
  supabase: Client, tenantId: string, table: ImportPlan["tables"][number],
): Promise<number> {
  let rows = 0;
  for (let at = 0; at < table.rows.length; at += BATCH) {
    const batch = table.rows.slice(at, at + BATCH).map((row) => ({ ...row, tenant_id: tenantId }));
    const { error } = await supabase
      .from(table.table)
      .upsert(batch, { onConflict: table.conflict, ignoreDuplicates: false });
    if (error) {
      throw new Error(
        `${table.label}: ${error.message} (rows ${at + 1}–${at + batch.length} of ${table.rows.length})`,
      );
    }
    rows += batch.length;
  }
  return rows;
}

/**
 * Read what is there, update by id, insert the rest.
 *
 * For a table whose uniqueness is an expression index, which PostgREST cannot
 * name in `on_conflict=` — see `PlannedTable.matchBy`. Every read and write here
 * still goes through the RLS-bound client, and the read names its tenant anyway
 * (§23) because a platform admin's session reads every laundry and an id matched
 * across the boundary would update somebody else's row.
 */
async function writeByMatch(
  supabase: Client, tenantId: string, table: ImportPlan["tables"][number],
): Promise<number> {
  const match = table.matchBy!;
  const fold = (value: unknown) =>
    match.caseInsensitive ? String(value ?? "").toLowerCase() : String(value ?? "");

  const { data: existing, error: readError } = await supabase
    .from(table.table)
    .select(`id, ${match.column}`)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .returns<Array<Record<string, unknown> & { id: string }>>();
  if (readError) throw new Error(`${table.label}: ${readError.message}`);

  const idByKey = new Map<string, string>();
  for (const row of existing ?? []) idByKey.set(fold(row[match.column]), row.id);

  let written = 0;
  const inserts: Record<string, unknown>[] = [];
  for (const row of table.rows) {
    const id = idByKey.get(fold(row[match.column]));
    if (id === undefined) { inserts.push({ ...row, tenant_id: tenantId }); continue; }
    const { error } = await supabase
      .from(table.table).update(row).eq("id", id).eq("tenant_id", tenantId);
    if (error) throw new Error(`${table.label}: ${error.message} (updating ${row[match.column]})`);
    written += 1;
  }

  for (let at = 0; at < inserts.length; at += BATCH) {
    const batch = inserts.slice(at, at + BATCH);
    const { error } = await supabase.from(table.table).insert(batch);
    if (error) {
      throw new Error(
        `${table.label}: ${error.message} (rows ${at + 1}–${at + batch.length} of ${inserts.length})`,
      );
    }
    written += batch.length;
  }
  return written;
}

/** Rows per request. Small enough that a failure names a findable batch. */
const BATCH = 400;
/** Rows per page when reading existing parties back. */
const PAGE = 1000;

export type CommitResult = {
  written: { table: string; label: string; rows: number }[];
  openingsCleared: number;
  sequences: { kind: string; next: number }[];
};

/** Every party the tenant already holds, so a re-import keeps their numbers. */
export async function readExistingParties(
  supabase: Client, tenantId: string,
): Promise<ExistingParties> {
  const [customers, suppliers] = await Promise.all([
    page<{ id: string; customer_number: string }>(supabase, "customers", "id, customer_number", tenantId),
    page<{ id: string; supplier_number: string }>(supabase, "suppliers", "id, supplier_number", tenantId),
  ]);
  return {
    customers: customers.map((row) => ({ id: row.id, number: row.customer_number })),
    suppliers: suppliers.map((row) => ({ id: row.id, number: row.supplier_number })),
  };
}

async function page<T>(supabase: Client, table: string, columns: string, tenantId: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(columns).eq("tenant_id", tenantId).range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read existing ${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

export async function commitPlan(
  supabase: Client, tenantId: string, plan: ImportPlan,
): Promise<CommitResult> {
  const written: CommitResult["written"] = [];

  for (const table of plan.tables) {
    const rows = table.matchBy
      ? await writeByMatch(supabase, tenantId, table)
      : await writeByUpsert(supabase, tenantId, table);
    written.push({ table: table.table, label: table.label, rows });
  }

  // Openings, once the documents that supersede them exist. One statement in the
  // database rather than a page-by-page sweep back through this process.
  let openingsCleared = 0;
  if (plan.clearOpenings) {
    const { data, error } = await supabase.rpc("clear_superseded_openings", { t: tenantId });
    if (error) throw new Error(`Clearing superseded opening balances: ${error.message}`);
    openingsCleared = Number(data ?? 0);
  }

  // Park each sequence past what this import used, so the first number the app
  // issues cannot collide with an imported one.
  const sequences: CommitResult["sequences"] = [];
  for (const sequence of plan.sequences) {
    const { data, error } = await supabase.rpc("park_number_sequence", {
      t: tenantId, k: sequence.kind, p: sequence.prefix, n: sequence.next,
    });
    if (error) throw new Error(`Parking the ${sequence.kind} number sequence: ${error.message}`);
    sequences.push({ kind: sequence.kind, next: Number(data ?? sequence.next) });
  }

  return { written, openingsCleared, sequences };
}
