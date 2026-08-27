import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { CHARGE_TYPES } from "@/lib/domain/pricing";
import type { PickableAccount } from "@/lib/domain/accounts";
import { PageContainer, PageHeader, Card, Notice } from "@/components/ui";
import { ChargeAccountTable } from "./charge-account-table";
import { saveChargeTypeAccounts } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Charge accounts" };

/**
 * Where each kind of charge posts, when nothing more specific says.
 *
 * The third tier of the coding ladder, and the one that answers for the lines
 * that name no item — a fuel levy, a minimum service fee, a delivery charge.
 * Those reached the books uncoded however carefully the item master was set up,
 * because the item master was the only bridge there was.
 */
export default async function ChargeAccountsPage() {
  const session = await requireCapability("purchases.read");
  const writable = can(session.role, "purchases.write");
  const supabase = await createClient();

  const [{ data: accounts }, { data: rows }] = await Promise.all([
    supabase
      .from("gl_accounts")
      .select("id, code, name, account_type, tax_code, is_header")
      // §23: the id chosen here is written onto a charge and from there onto an
      // invoice line, so the read that offers it names its tenant.
      .eq("tenant_id", session.tenantId)
      .is("deleted_at", null)
      .eq("is_header", false)
      .order("code")
      .limit(1000)
      .returns<PickableAccount[]>(),
    supabase
      .from("charge_type_accounts")
      .select("charge_type, gl_account_id")
      .eq("tenant_id", session.tenantId)
      .returns<Array<{ charge_type: string; gl_account_id: string | null }>>(),
  ]);

  const current: Record<string, string | null> = {};
  for (const type of CHARGE_TYPES) current[type] = null;
  for (const row of rows ?? []) current[row.charge_type] = row.gl_account_id;

  return (
    <PageContainer width="form">
      <PageHeader
        title="Charge accounts"
        description="Where each kind of charge lands in your books when nothing more specific says."
        back={{ href: "/invoices", label: "Money" }}
      />

      {writable ? (
        <ChargeAccountTable
          accounts={accounts ?? []} current={current} action={saveChargeTypeAccounts}
        />
      ) : (
        /*
          The auditor reads and does not write, which is the whole reason
          `can_read_purchases` and `can_write_purchases` are two role lists. A
          disabled form would be a control whose only possible outcome is a
          refusal — §29's rule about a chip nothing matches, one screen over.
        */
        <Card title="Default account per kind of charge">
          <Notice tone="info" title="You can read these, not change them">
            Ask the Owner or the Office manager to change where a kind of charge posts.
          </Notice>
          <ul className="mt-4 space-y-1 text-sm">
            {CHARGE_TYPES.map((type) => (
              <li key={type} className="flex justify-between gap-4">
                <span>{type}</span>
                <span className="font-mono text-muted-foreground">
                  {(accounts ?? []).find((account) => account.id === current[type])?.code ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </PageContainer>
  );
}
