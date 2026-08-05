import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import type { Customer } from "@/lib/db/types";
import {
  ButtonLink, DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";

export const metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; page?: string; error?: string; ok?: string };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const session = await requireCapability("customers.read");

  return (
    <div>
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title="Customers"
        description="Businesses you collect from and deliver to, with their sites and contacts."
        actions={can(session.role, "customers.write")
          ? <ButtonLink href="/customers/new" variant="primary">New customer</ButtonLink>
          : null}
      />
      <ListControls
        action="/customers"
        q={params.q}
        filters={[{
          name: "status", label: "Status", value: params.status,
          options: [
            { value: "active", label: "Active" },
            { value: "prospect", label: "Prospect" },
            { value: "on_hold", label: "On hold" },
            { value: "inactive", label: "Inactive" },
            { value: "archived", label: "Archived" },
          ],
        }]}
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <CustomerList params={params} canWrite={can(session.role, "customers.write")} />
      </Suspense>
    </div>
  );
}

async function CustomerList({ params, canWrite }: { params: Search; canWrite: boolean }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("customers")
    .select(
      "id, customer_number, business_name, trading_name, abn, billing_suburb, billing_state, " +
      "billing_email, phone, payment_terms_days, purchase_order_number, special_instructions, " +
      "notes, status, depot_id, created_at",
      { count: "exact" },
    )
    .is("deleted_at", null)
    .order("business_name")
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(
      `business_name.ilike.${term},trading_name.ilike.${term},customer_number.ilike.${term}`,
    );
  }

  const { data, count, error } = await query.returns<Customer[]>();
  if (error) throw new Error(error.message);

  return (
    <>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/customers/${row.id}`}
        empty={
          <EmptyState
            title={params.q || params.status ? "No customers match those filters" : "No customers yet"}
            description={params.q || params.status
              ? "Try a broader search."
              : "Add your first customer to start building routes and agreements."}
            action={canWrite && !params.q && !params.status
              ? <ButtonLink href="/customers/new" variant="primary">New customer</ButtonLink>
              : null}
          />
        }
        columns={[
          { header: "Customer", cell: (row) => row.business_name },
          { header: "Number", cell: (row) => row.customer_number, hideBelow: "sm" },
          {
            header: "Location",
            cell: (row) => [row.billing_suburb, row.billing_state].filter(Boolean).join(", ") || "—",
            hideBelow: "md",
          },
          { header: "Terms", cell: (row) => `${row.payment_terms_days} days`, hideBelow: "lg" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/customers" />
    </>
  );
}
