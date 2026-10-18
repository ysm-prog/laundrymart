import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import type { Customer } from "@/lib/db/types";
import {
  ButtonLink, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { FilterChips } from "@/components/filters";
import { isFiltered } from "@/lib/filters";
import { listActiveBoards } from "@/lib/runs/my-runs";
import { weekdayName } from "@/lib/domain/collections";
import { SetRound } from "./set-round";

export const metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

type Search = {
  q?: string; status?: string; round?: string; page?: string; error?: string; ok?: string;
};
const FILTER_KEYS = ["q", "status", "round"] as const;

/**
 * Whether the customer is on a round (brief 2.2). "No round" is the list the
 * bulk Set the round panel exists to empty: a job only goes onto a round by
 * itself once its customer has one.
 */
const ROUND_FILTERS = [
  { value: "none", label: "No round" },
  { value: "set", label: "On a round" },
] as const;

const CUSTOMER_STATUSES = [
  { value: "active", label: "Active" },
  { value: "prospect", label: "Prospect" },
  { value: "on_hold", label: "On hold" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived" },
] as const;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const params = await searchParams;
  const session = await requireCapability("customers.read");

  return (
    <div>
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
        params={params}
        filterKeys={FILTER_KEYS}
        placeholder="Business name, trading name or customer number…"
        chips={
          /* Chips rather than a select: five statuses is a short enough
             vocabulary to read at a glance, and "who is on hold?" is then one
             press instead of open-choose-submit. The counts are deliberately
             absent — this list is paginated, so a count per status would be five
             more round trips for a number `Pagination` already gives for the one
             status you picked. */
          <>
            <FilterChips
              basePath="/customers" params={params} name="status" label="Customer status"
              allLabel="All customers" options={CUSTOMER_STATUSES}
            />
            <FilterChips
              basePath="/customers" params={params} name="round" label="Round"
              allLabel="Any round" options={ROUND_FILTERS}
            />
          </>
        }
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <CustomerList params={params} canWrite={can(session.role, "customers.write")}
                      tenantId={session.tenantId} />
      </Suspense>
    </div>
  );
}

async function CustomerList({
  params, canWrite, tenantId,
}: { params: Search; canWrite: boolean; tenantId: string }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("customers")
    .select(
      "id, customer_number, business_name, trading_name, abn, billing_suburb, billing_state, " +
      "billing_email, phone, payment_terms_days, purchase_order_number, special_instructions, " +
      "notes, status, depot_id, created_at, collection_board_id, collection_weekday",
      { count: "exact" },
    )
    .is("deleted_at", null)
    .order("business_name")
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.round === "none") query = query.is("collection_board_id", null);
  if (params.round === "set") query = query.not("collection_board_id", "is", null);
  if (params.q) {
    const term = `%${params.q}%`;
    query = query.or(
      `business_name.ilike.${term},trading_name.ilike.${term},customer_number.ilike.${term}`,
    );
  }

  const [{ data, count, error }, boards] = await Promise.all([
    query.returns<Customer[]>(),
    listActiveBoards(supabase, tenantId),
  ]);
  if (error) throw new Error(error.message);
  const boardName = new Map(boards.map((board) => [board.id, board.name]));
  const roundOf = (row: Customer): string | null => row.collection_board_id
    ? [boardName.get(row.collection_board_id) ?? "A retired round", weekdayName(row.collection_weekday)]
        .filter(Boolean).join(", ")
    : null;
  const returnTo = `/customers?${new URLSearchParams(
    Object.entries(params).filter(([key, value]) => value && key !== "error" && key !== "ok") as [string, string][],
  ).toString()}`;

  return (
    <>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/customers/${row.id}`}
        empty={
          <EmptyState
            title={isFiltered(params, FILTER_KEYS) ? "No customers match those filters" : "No customers yet"}
            description={isFiltered(params, FILTER_KEYS)
              ? "Try a broader search, or clear the filters above."
              : "Add your first customer to start building routes and agreements."}
            action={canWrite && !isFiltered(params, FILTER_KEYS)
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
          { header: "Round", cell: (row) => roundOf(row) ?? "—", hideBelow: "md" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/customers" />
      {canWrite && boards.length > 0 ? (
        <div className="mt-5">
          <SetRound
            customers={(data ?? []).map((row) => ({
              id: row.id, name: row.business_name, number: row.customer_number, round: roundOf(row),
            }))}
            boards={boards.map((board) => ({ id: board.id, name: board.name }))}
            returnTo={returnTo}
          />
        </div>
      ) : null}
    </>
  );
}
