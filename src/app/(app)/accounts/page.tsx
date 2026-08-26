import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import type { GlAccount } from "@/lib/db/types";
import Link from "next/link";
import { can } from "@/lib/roles";
import { Card, DataTable, EmptyState, Eyebrow, PageHeader, SkeletonRows } from "@/components/ui";
import { Field, Input, Select, SubmitButton } from "@/components/form";
import { ListControls } from "@/components/list-controls";
import { FilterChips } from "@/components/filters";
import { createAccount } from "./actions";
import { ACCOUNT_TYPES } from "./account-types";

export const metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

type Search = { q?: string; type?: string };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("purchases.read");
  const canWrite = can(session.role, "purchases.write");

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="Every account the books are kept in. Invoices, bills and payments are each coded to one of these."
      />
      <ListControls
        action="/accounts"
        q={params.q}
        placeholder="Search by code or name…"
        params={params}
        filterKeys={["q", "type"]}
        chips={
          /* Income leads because a sales invoice is coded to one, and it is the
             tier `resolveAccountCode` searches first. The rest stay in the select
             beside it — a bookkeeper offsetting against an expense account is
             doing their job, so the escape hatch is one control away. */
          <FilterChips
            basePath="/accounts" params={params} name="type" label="Account type"
            allLabel="Every account"
            options={[
              { value: "Income", label: "Income" },
              { value: "Expense", label: "Expense" },
              { value: "Bank", label: "Bank" },
            ]}
          />
        }
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
        <AccountList params={params} canWrite={canWrite} />
      </Suspense>
      {canWrite ? <NewAccountForm /> : null}
    </div>
  );
}

async function AccountList({ params, canWrite }: { params: Search; canWrite: boolean }) {
  const supabase = await createClient();

  // The whole chart in one read, deliberately unpaginated: it is a few hundred
  // rows of reference data that people scan rather than page through, and the
  // indent below only makes sense with the parent rows present.
  let query = supabase
    .from("gl_accounts")
    .select("id, code, name, account_type, tax_code, xero_account_code, " +
            "is_linked, is_header, level, current_balance")
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
              : "Import your chart from your accounting system, or add the accounts you need below."}
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
                {row.is_header ? "—" : canWrite ? (
                  // A padded hit area rather than a bare line of monospace: this
                  // is read and tapped on a tablet, and a 12px code is not a
                  // target. The same treatment the run sequencer's job links got.
                  <Link href={`/accounts/${row.id}`}
                        className="inline-flex min-h-9 items-center rounded-lg px-1
                                   hover:underline focus:ring-2 focus:ring-primary/25">
                    {row.code}
                  </Link>
                ) : row.code}
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
            // Which accounts actually reach Xero. Worth a column of its own:
            // a blank here is why an invoice line arrives uncoded, and that is
            // otherwise invisible until a bookkeeper asks.
            header: "Xero code",
            cell: (row) => (
              <span className="font-mono">{row.xero_account_code ?? "—"}</span>
            ),
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

/**
 * Adding one account.
 *
 * On the list rather than behind a "New account" page, because the chart is
 * something a bookkeeper adds two or three rows to at a sitting while looking
 * at what is already there — the same reason `/items` puts its form here.
 */
function NewAccountForm() {
  return (
    <Card
      title="Add an account"
      description="Use the code your books use. It has to be unique within this laundry."
      className="mt-4"
    >
      <form action={createAccount} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Code" name="code" required hint="As it is in your books — 200, 4-1000.">
          <Input name="code" required placeholder="200" />
        </Field>
        <Field label="Name" name="name" required>
          <Input name="name" required placeholder="Laundry income" />
        </Field>
        <Field label="Type" name="account_type">
          <Select name="account_type" defaultValue="Income"
                  options={ACCOUNT_TYPES.map((value) => ({ value, label: value }))} />
        </Field>
        <Field label="Tax code" name="tax_code" hint="As it is in your books — GST, FRE, N-T.">
          <Input name="tax_code" placeholder="GST" />
        </Field>
        <Field
          label="Xero code"
          name="xero_account_code"
          hint="The matching code in Xero. Leave blank and nothing is coded to this account in Xero."
        >
          <Input name="xero_account_code" placeholder="200" />
        </Field>
        <Field label="Heading" name="is_header"
               hint="A heading groups the accounts under it and is never coded to.">
          <Select name="is_header" defaultValue="false"
                  options={[{ value: "false", label: "No" }, { value: "true", label: "Yes" }]} />
        </Field>
        <Field label="Indent" name="level" hint="1 is top level. Presentation only.">
          <Input name="level" type="number" min={1} max={4} defaultValue="1" />
        </Field>
        <div className="flex items-end lg:col-span-2">
          <SubmitButton>Add account</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
