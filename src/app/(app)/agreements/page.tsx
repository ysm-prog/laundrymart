import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, money } from "@/lib/format";
import { HOLIDAY_RULE_LABELS, describePattern, parsePattern } from "@/lib/domain/service-calendar";
import type { HolidayRule } from "@/lib/domain/service-calendar";
import {
  ButtonLink, DataTable, EmptyState, PageHeader, SkeletonRows, StatusBadge,
} from "@/components/ui";
import { ListControls, Pagination, pageFrom, rangeFor } from "@/components/list-controls";
import { FilterChips } from "@/components/filters";

export const metadata = { title: "Contracts" };
export const dynamic = "force-dynamic";

type Search = { q?: string; status?: string; page?: string; error?: string; ok?: string };

type Row = {
  id: string;
  agreement_number: string;
  version: number;
  status: string;
  start_date: string;
  end_date: string | null;
  minimum_charge: number;
  holiday_rule: string;
  pickup_pattern: unknown;
  customers: { business_name: string; customer_number: string } | null;
};

export default async function AgreementsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const session = await requireCapability("agreements.read");

  return (
    <div>
      <PageHeader
        title="Contracts"
        description="The contract that decides when a customer is serviced and what they are charged."
        actions={can(session.role, "agreements.write")
          ? <ButtonLink href="/agreements/new" variant="primary">New agreement</ButtonLink>
          : null}
      />
      <ListControls
        action="/agreements"
        q={params.q}
        params={params}
        filterKeys={["q", "status"]}
        placeholder="Contract number or customer…"
        chips={
          <FilterChips
            basePath="/agreements" params={params} name="status" label="Contract status"
            allLabel="All contracts"
            options={[
              { value: "draft", label: "Draft" },
              { value: "active", label: "Active" },
              { value: "suspended", label: "Suspended" },
              { value: "expired", label: "Expired" },
              { value: "terminated", label: "Terminated" },
            ]}
          />
        }
      />
      <Suspense key={JSON.stringify(params)} fallback={<SkeletonRows rows={6} />}>
        <AgreementList params={params} />
      </Suspense>
    </div>
  );
}

async function AgreementList({ params }: { params: Search }) {
  const supabase = await createClient();
  const page = pageFrom(params.page);
  const [from, to] = rangeFor(page);

  let query = supabase
    .from("service_agreements")
    .select(
      "id, agreement_number, version, status, start_date, end_date, minimum_charge, " +
      "holiday_rule, pickup_pattern, customers(business_name, customer_number)",
      { count: "exact" },
    )
    .is("deleted_at", null)
    .order("agreement_number", { ascending: false })
    .range(from, to);

  if (params.status) query = query.eq("status", params.status);
  if (params.q) query = query.ilike("agreement_number", `%${params.q}%`);

  const { data, count } = await query.returns<Row[]>();

  return (
    <>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/agreements/${row.id}`}
        empty={
          <EmptyState
            title="No contracts yet"
            description="Every run and every invoice traces back to a contract — start here."
            action={<ButtonLink href="/agreements/new" variant="primary">Create a contract</ButtonLink>}
          />
        }
        columns={[
          { header: "Agreement", cell: (row) => `${row.agreement_number} v${row.version}` },
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          {
            header: "Pickup pattern",
            cell: (row) => describePattern(parsePattern(row.pickup_pattern)),
            hideBelow: "md",
          },
          {
            header: "Holidays",
            cell: (row) => HOLIDAY_RULE_LABELS[row.holiday_rule as HolidayRule] ?? row.holiday_rule,
            hideBelow: "lg",
          },
          { header: "Minimum", cell: (row) => money(row.minimum_charge), align: "right", hideBelow: "lg" },
          { header: "Starts", cell: (row) => date(row.start_date), hideBelow: "sm" },
          { header: "Status", cell: (row) => <StatusBadge status={row.status} /> },
        ]}
      />
      <Pagination page={page} total={count ?? 0} params={params} basePath="/agreements" />
    </>
  );
}
