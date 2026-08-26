/**
 * Which GL account a generated invoice line codes to.
 *
 * Shared by the two writers that raise invoices without a person typing them —
 * the month-end recurring run and the per-job generator — for the reason
 * `lib/orders/complete.ts` and `lib/routes/unload.ts` exist: two copies of one
 * rule drift, and the least-used copy is the one that stops matching.
 *
 * **The item master is the only bridge, and that is a decision.** The obvious
 * alternative is a per-charge-type map — "a fuel levy goes to 4-2000" — and it
 * was deliberately left out. It would be a second place a laundry has to keep in
 * step with its own books, this app has no way to check its answers, and the
 * first wrong entry would silently mis-post every invoice after it. An item
 * already names the income account its sales are tracked to, which is where MYOB
 * keeps exactly the same fact, so a job priced from a coded item comes out coded.
 *
 * Everything else comes out **honestly uncoded** and is counted on the invoice
 * screen. That is the same call the pricer makes about laundry nobody has priced:
 * report the gap and name it, because a silently missing code looks exactly like
 * one somebody chose.
 */

import type { createClient } from "@/lib/supabase/server";

/** The RLS-bound client, spelled the way every other module in here spells it. */
type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * Income accounts for a set of items, keyed by item id.
 *
 * `tenantId` is a **required argument** rather than being left to RLS — §23's
 * standing rule for a read that feeds a write. `is_member()` is true of every
 * laundry for a platform admin, so an unfiltered read here could resolve one
 * business's item against another's chart and code the invoice to it.
 *
 * Items with no account are simply absent from the map: the caller writes null
 * and the line is reported as uncoded, which is the honest answer.
 */
export async function incomeAccountsForItems(
  supabase: Client,
  tenantId: string,
  itemIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(itemIds.filter(Boolean))] as string[];
  const found = new Map<string, string>();
  if (wanted.length === 0) return found;

  const { data } = await supabase
    .from("items")
    .select("id, income_account_id")
    .in("id", wanted)
    .eq("tenant_id", tenantId)
    .not("income_account_id", "is", null)
    .returns<{ id: string; income_account_id: string }[]>();

  for (const row of data ?? []) found.set(row.id, row.income_account_id);
  return found;
}

/**
 * The account id to write on a line, or null.
 *
 * Trivial, and named anyway: it is the one place the fallback order is stated, so
 * a second tier added later — a customer override, a charge-type map if one is
 * ever asked for — has an obvious home instead of being inlined at two call
 * sites that then disagree.
 *
 * `account_code` is deliberately not returned. `sync_invoice_line_account()`
 * derives the text from the id inside the insert, so the two records of one fact
 * cannot disagree however the row is written.
 */
export function accountForLine(
  itemId: string | null | undefined,
  accountByItem: ReadonlyMap<string, string>,
): string | null {
  return (itemId && accountByItem.get(itemId)) || null;
}
