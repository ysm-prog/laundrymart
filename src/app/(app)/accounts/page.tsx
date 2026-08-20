import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import type { GlAccount } from "@/lib/db/types";
import { Card, DataTable, EmptyState, Eyebrow, PageHeader, SkeletonRows } from "@/components/ui";
import { ListControls } from "@/components/list-controls";

export const metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

type Search = { q?: string; type?: string };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("purchases.read");

  return (
    <div>
      <PageHeader
        title="Accounts" eyebrow="Chart of accounts"
        description="Every account the books are kept in. Invoices, bills and payments are each coded to one of these."
      />
      <ListControls
        action="/accounts"
        q={params.q}
        placeholder="Search by code or name…"
        filters={[{
          name: "type", label: "Type", value: params.type,
          options: [
            { value: "Asset", label: "Asset" },
            { value: "Bank", label: "Bank" },
            { value: "Liability", label: "Liability" },
            { value: "Equity", label: "Equity" },
            { value: "Income", label: "Income" },
            { value: "Cost of sales", label: "Cost of sales" },
            { value: "Expense", label: "Expense" },
          ],
        }]}
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={10} />}>
        <AccountList params={params} />
      </Suspense>
    </div>
  );
}

async function AccountList({ params }: { params: Search }) {
  const supabase = await createClient();

  // The whole chart in one read, deliberately unpaginated: it is a few hundred
  // rows of reference data that people scan rather than page through, and the
  // indent below only makes sense with the parent rows present.
  let query = supabase
    .from("gl_accounts")
    .select("id, code, name, account_type, tax_code, is_linked, is_header, level, current_balance")
    .is("deleted_at", null)
    .order("code")
    .limit(1000);

  if (params.type) query = query.eq("account_type", params.type);
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(`code.ilike.${term},name.ilike.${term}`);
  }

  const { data, error } = await query.returns<GlAccount[]>();
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const filtered = Boolean(params.q || params.type);

  return (
    <Card>
      <div className="border-b px-4 py-2">
        <Eyebrow>{rows.length} accounts</Eyebrow>
      </div>
      <DataTable
        rows={rows}
        label="Chart of accounts"
        empty={
          <EmptyState
            title={filtered ? "No accounts match those filters" : "No accounts yet"}
            description={filtered
              ? "Try a broader search."
              : "The chart of accounts appears here once it is imported from your accounting system."}
          />
        }
        rowClassName={(row) => (row.is_header ? "bg-surface-muted font-medium" : "")}
        columns={[
          {
            // Indent carries the depth. The source gives a level, not a parent,
            // so this is presentation only — no hierarchy is asserted that the
            // business did not state.
            header: "Code",
            cell: (row) => (
              <span className="font-mono" style={{ paddingLeft: `${(row.level - 1) * 12}px` }}>
                {row.is_header ? "—" : row.code}
              </span>
            ),
          },
          { header: "Name", cell: (row) => row.name },
          { header: "Type", cell: (row) => row.account_type, hideBelow: "sm" },
          {
            header: "Tax",
            cell: (row) => <span className="font-mono">{row.tax_code ?? "—"}</span>,
            hideBelow: "lg",
          },
          {
            header: "Balance",
            cell: (row) => (Number(row.current_balance) === 0 ? "—" : money(row.current_balance)),
            align: "right",
          },
        ]}
      />
    </Card>
  );
}
