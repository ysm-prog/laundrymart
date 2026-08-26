import type { createClient } from "@/lib/supabase/server";

/**
 * The accounts an invoice line can be coded to, for the item picker.
 *
 * Headings are excluded because a heading groups the accounts under it and is
 * never coded to — offering one would produce an item whose revenue lands
 * nowhere. The tenant is a **required argument** rather than left to RLS (§23):
 * a platform admin's session reads every laundry, and an id chosen here is
 * posted back into a write filtered to one.
 *
 * Every role holding `items.write` also holds `purchases.read`, so this list is
 * never empty for the person looking at it because of a policy — checked in
 * `roles.test.ts` rather than assumed, since an empty picker with no
 * explanation reads as a broken screen.
 */
export type IncomeAccount = {
  id: string;
  code: string;
  name: string;
  xero_account_code: string | null;
};

export async function listIncomeAccounts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
): Promise<IncomeAccount[]> {
  const { data } = await supabase
    .from("gl_accounts")
    .select("id, code, name, xero_account_code")
    .eq("tenant_id", tenantId)
    .eq("is_header", false)
    .is("deleted_at", null)
    .order("code")
    .limit(500)
    .returns<IncomeAccount[]>();
  return data ?? [];
}

/**
 * How an account reads in a picker.
 *
 * The Xero code is shown when it differs from ours, because "which of these
 * actually reaches Xero?" is the question somebody coding an item is asking and
 * the answer is otherwise two screens away.
 */
export function accountOptionLabel(account: IncomeAccount): string {
  const base = `${account.code} — ${account.name}`;
  if (!account.xero_account_code) return `${base} (not coded to Xero)`;
  if (account.xero_account_code === account.code) return base;
  return `${base} (Xero ${account.xero_account_code})`;
}
