/**
 * Which GL account an invoice line codes to.
 *
 * Shared by every writer that puts a line on an invoice without a person typing
 * it — the month-end recurring run, the per-job generator and the running
 * draft's rebuild — for the reason `lib/orders/complete.ts` and
 * `lib/routes/unload.ts` exist: two copies of one rule drift, and the least-used
 * copy is the one that stops matching.
 *
 * **Three tiers, most specific first** (`resolveChargeAccount`):
 *
 * 1. the charge's own account, chosen by hand on the job (0039);
 * 2. the item's income account, which is where MYOB keeps the same fact;
 * 3. the **charge type's default**, so a fuel levy lands somewhere without
 *    anybody picking anything.
 *
 * Tier 3 is new, and this file used to argue against it in as many words: *"a
 * per-charge-type map … was deliberately left out. It would be a second place a
 * laundry has to keep in step with its own books, this app has no way to check
 * its answers, and the first wrong entry would silently mis-post every invoice
 * after it."* The owner overruled that on 2026-08-26, and the reason the
 * objection no longer bites is that the two halves of it were both answered
 * rather than waved away:
 *
 * - **It is not a second place, for the lines that had a first one.** An item's
 *   account still wins, so nothing coded through the item master changes. The
 *   map only ever answers where the item master *cannot* — a fuel levy, a
 *   minimum service fee, a delivery charge: the lines that name no item at all
 *   and so reached the books uncoded however carefully the items were set up.
 * - **A wrong entry cannot silently mis-post, because the map is a real table
 *   with a real foreign key** (`charge_type_accounts`, 0044), gated on
 *   `can_write_purchases()` and refused by `guard_charge_type_account` if it
 *   names a heading or another laundry's account. The failure the old comment
 *   feared was a dangling id in a settings blob; there is no blob.
 *
 * A charge that matches no tier still comes out **honestly uncoded** and is
 * counted on the invoice screen. That is the same call the pricer makes about
 * laundry nobody has priced: report the gap and name it, because a silently
 * missing code looks exactly like one somebody chose.
 */

import type { createClient } from "@/lib/supabase/server";

/** The RLS-bound client, spelled the way every other module in here spells it. */
type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * Everything `resolveChargeAccount` needs that came out of the database.
 *
 * One object rather than two positional maps, because a caller passing them the
 * wrong way round would compile cleanly and code every line to nothing — both
 * are `Map<string, string>`.
 */
export type AccountLookups = {
  /** Item id → income account id. Absent means the item names no account. */
  readonly accountByItem: ReadonlyMap<string, string>;
  /** Charge type → account id. Absent means nobody has set a default for it. */
  readonly defaultByChargeType: ReadonlyMap<string, string>;
};

/** The parts of a charge that decide where it lands. */
export type CodableCharge = {
  /** The account chosen by hand on the job's Charges card (0039). */
  readonly gl_account_id?: string | null;
  readonly source_item_id?: string | null;
  readonly charge_type?: string | null;
};

/** An empty set of lookups — the honest answer when nothing has been coded. */
export const NO_ACCOUNTS: AccountLookups = {
  accountByItem: new Map(),
  defaultByChargeType: new Map(),
};

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
 * The laundry's default account per kind of charge.
 *
 * Twelve rows at the very most, so it is read whole rather than filtered to the
 * charge types in front of it — a second query shape to save eleven rows is a
 * second thing to keep right.
 *
 * `tenantId` is a required argument for the same reason as above. A row whose
 * account has since been deleted from the chart reads back null through
 * `on delete set null` and is skipped here, so a tidied chart degrades to
 * "uncoded" rather than to an insert that raises `that account could not be
 * found` and takes a whole month's invoicing with it.
 */
export async function chargeTypeAccounts(
  supabase: Client,
  tenantId: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const { data } = await supabase
    .from("charge_type_accounts")
    .select("charge_type, gl_account_id")
    .eq("tenant_id", tenantId)
    .not("gl_account_id", "is", null)
    .returns<{ charge_type: string; gl_account_id: string }[]>();

  for (const row of data ?? []) found.set(row.charge_type, row.gl_account_id);
  return found;
}

/** Both lookups a set of charges needs, in one round trip each. */
export async function accountLookupsFor(
  supabase: Client,
  tenantId: string,
  charges: readonly CodableCharge[],
): Promise<AccountLookups> {
  const [accountByItem, defaultByChargeType] = await Promise.all([
    incomeAccountsForItems(supabase, tenantId, charges.map((c) => c.source_item_id)),
    chargeTypeAccounts(supabase, tenantId),
  ]);
  return { accountByItem, defaultByChargeType };
}

/**
 * The account id a charge codes to, or null.
 *
 * **The order is the whole of this function, and getting it the other way round
 * is the failure worth naming**: resolving the item's account ahead of the
 * charge's own would quietly send a different account from the one somebody
 * deliberately chose on the Charges card, and nobody would find out until a
 * bookkeeper reconciled. The same precedence, for the same reason, as
 * `resolveAccountCode` in the Xero payload.
 *
 * An empty string is treated as absent rather than as an answer, so a control
 * that posts `""` for "none" cannot code a line to nothing-in-particular.
 */
export function resolveChargeAccount(
  charge: CodableCharge,
  lookups: AccountLookups,
): string | null {
  const own = charge.gl_account_id || null;
  if (own) return own;

  const viaItem = charge.source_item_id
    ? lookups.accountByItem.get(charge.source_item_id) || null
    : null;
  if (viaItem) return viaItem;

  return (charge.charge_type
    ? lookups.defaultByChargeType.get(charge.charge_type) || null
    : null);
}
