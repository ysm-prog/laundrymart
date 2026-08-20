import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { money } from "@/lib/format";
import type { Supplier } from "@/lib/db/types";
import {
  Card, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";

export const metadata = { title: "Suppliers" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; page?: string };

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
        filters={[{
          name: "status", label: "Status", value: params.status,
          options: [
            { value: "active", label: "Active" },
            { value: "inactive", label: "Inactive" },
            { value: "archived", label: "Archived" },
          ],
        }]}
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
    .select("id, supplier_number, name, phone, email, opening_balance, notes, status",
            { count: "exact" })
    .is("deleted_at", null)
    .order("name")
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(`name.ilike.${term},supplier_number.ilike.${term},email.ilike.${term}`);
  }

  const { data, count, error } = await query.returns<Supplier[]>();
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
          { header: "Supplier", cell: (row) => row.name },
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
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/suppliers" />
    </Card>
  );
}
