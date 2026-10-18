import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { xeroAccountProblems, type AccountProblem, type UsedAccount } from "@/lib/domain/xero-readiness";
import { listXeroChartCodes } from "./accounts";

/**
 * Every account the app's own invoices use (brief 1.2): coded on an invoice line
 * of an app-raised invoice, the income account of an item the laundry sells, a
 * charge type's default (0044), or the account a job charge was coded to. These
 * are the codes that have to exist in Xero before anything is sent.
 *
 * **On the service-role client, filtered by tenant by hand** (§2). The push
 * runs this for whoever issued the invoice, and a gate that read the chart
 * through a caller's RLS would read nothing for a role without `purchases.read`
 * — and pass. A gate must not fail open.
 */
export async function loadUsedAccounts(tenantId: string, client?: SupabaseClient): Promise<UsedAccount[]> {
  const admin = client ?? createAdminClient();
  const usedBy = new Map<string, Set<string>>();
  const note = (id: string | null | undefined, where: string) => {
    if (!id) return;
    const bucket = usedBy.get(id) ?? new Set<string>();
    bucket.add(where);
    usedBy.set(id, bucket);
  };

  const [{ data: lines }, { data: items }, { data: chargeTypes }, { data: charges }] = await Promise.all([
    admin.from("invoice_lines")
      .select("gl_account_id, invoices!inner(source, status)")
      .eq("tenant_id", tenantId)
      .not("gl_account_id", "is", null)
      .eq("invoices.source", "app")
      .neq("invoices.status", "void")
      .limit(5000)
      .returns<Array<{ gl_account_id: string }>>(),
    admin.from("items")
      .select("income_account_id")
      .eq("tenant_id", tenantId)
      .eq("is_sell", true)
      .is("deleted_at", null)
      .not("income_account_id", "is", null)
      .returns<Array<{ income_account_id: string }>>(),
    admin.from("charge_type_accounts")
      .select("gl_account_id")
      .eq("tenant_id", tenantId)
      .not("gl_account_id", "is", null)
      .returns<Array<{ gl_account_id: string }>>(),
    admin.from("job_charge_snapshots")
      .select("gl_account_id")
      .eq("tenant_id", tenantId)
      .not("gl_account_id", "is", null)
      .limit(5000)
      .returns<Array<{ gl_account_id: string }>>(),
  ]);

  for (const row of lines ?? []) note(row.gl_account_id, "invoice lines");
  for (const row of items ?? []) note(row.income_account_id, "items");
  for (const row of chargeTypes ?? []) note(row.gl_account_id, "charge types");
  for (const row of charges ?? []) note(row.gl_account_id, "job charges");

  const ids = [...usedBy.keys()];
  if (ids.length === 0) return [];
  const { data: accounts } = await admin
    .from("gl_accounts")
    .select("id, code, name, xero_account_code")
    .eq("tenant_id", tenantId)
    .in("id", ids)
    .returns<Array<{ id: string; code: string; name: string; xero_account_code: string | null }>>();

  return (accounts ?? []).map((account) => ({
    id: account.id, code: account.code, name: account.name,
    xeroAccountCode: account.xero_account_code,
    usedBy: [...(usedBy.get(account.id) ?? [])],
  }));
}

/**
 * The pre-flight: the accounts in use that Xero would not post correctly. With
 * `checkChart`, the connected Xero chart is read and a mapped code it does not
 * carry is reported too; without, only a missing mapping is.
 */
export async function xeroReadiness(
  tenantId: string, options: { checkChart: boolean },
): Promise<{ used: UsedAccount[]; problems: AccountProblem[]; chartRead: boolean }> {
  const used = await loadUsedAccounts(tenantId);
  const chart = options.checkChart ? await listXeroChartCodes(tenantId) : null;
  const codes = chart && chart.length > 0 ? new Set(chart) : null;
  return { used, problems: xeroAccountProblems(used, codes), chartRead: codes !== null };
}
