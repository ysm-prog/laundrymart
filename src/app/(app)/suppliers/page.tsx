import { Suspense } from "react";
import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import type { Supplier } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { FilterChips } from "@/components/filters";
import { SUPPLIER_COLUMNS } from "./columns";

export const metadata = { title: "Suppliers" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; page?: string };

/** A supplier plus the code of the account its bills post to. */
type SupplierRow = Supplier & { gl_accounts: { code: string } | null };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  await requireCapability("purchases.read");

  return (
    <div>
      <PageHeader
        title="Suppliers" eyebrow="Money out"
        description="Businesses you buy from — linen, fuel, utilities, services — and what you owe each of them."
      />
      <ListControls
        action="/suppliers"
        q={params.q}
        placeholder="Search suppliers…"
        params={params}
        filterKeys={["q", "status"]}
        chips={
          <FilterChips
            basePath="/suppliers" params={params} name="status" label="Supplier status"
            allLabel="All suppliers"
            options={[
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
              { value: "archived", label: "Archived" },
            ]}
          />
        }
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={8} />}>
        <SupplierList params={params} />
      </Suspense>
    </div>
  );
}

async function SupplierList({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("suppliers")
    // The default account is embedded rather than joined by hand: one FK to
    // `gl_accounts` (0045 asserts exactly one), so the embed is unambiguous.
    .select(`${SUPPLIER_COLUMNS}, gl_accounts(code)`, { count: "exact" })
    .is("deleted_at", null)
    .order("name")
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(
      `name.ilike.${term},supplier_number.ilike.${term},email.ilike.${term},` +
      `contact_name.ilike.${term},abn.ilike.${term}`,
    );
  }

  const { data, count, error } = await query.returns<SupplierRow[]>();
  if (error) throw new Error(error.message);

  const filtered = Boolean(params.q || params.status);

  return (
    <Card>
      <DataTable
        rows={data ?? []}
        empty={
          <EmptyState
            title={filtered ? "No suppliers match those filters" : "No suppliers yet"}
            description={filtered
              ? "Try a broader search."
              : "Suppliers appear here once they are entered or imported."}
          />
        }
        columns={[
          {
            header: "Supplier",
            cell: (row) => (
              <Link
                href={`/suppliers/${row.id}`}
                className="font-medium text-primary underline underline-offset-2"
              >
                {row.name}
              </Link>
            ),
          },
          { header: "Contact", cell: (row) => row.contact_name ?? "—", hideBelow: "lg" },
          {
            header: "Number",
            cell: (row) => <span className="font-mono">{row.supplier_number}</span>,
            hideBelow: "md",
          },
          { header: "Phone", cell: (row) => <span className="font-mono">{row.phone ?? "—"}</span>, hideBelow: "md" },
          { header: "Email", cell: (row) => row.email ?? "—", hideBelow: "lg" },
          {
            // Says where it came from rather than implying a live figure: the
            // running balance lives on the bills, and this is the number the
            // previous books closed with.
            header: "Opening balance",
            cell: (row) => (Number(row.opening_balance) === 0 ? "—" : money(row.opening_balance)),
            align: "right",
            hideBelow: "sm",
          },
          {
            // MYOB's "Category" — where this supplier's bills post by default.
            header: "Account",
            cell: (row) => (row.gl_accounts
              ? <span className="font-mono">{row.gl_accounts.code}</span>
              : <span className="text-muted-foreground">—</span>),
            hideBelow: "lg",
          },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/suppliers" />
    </Card>
  );
}
