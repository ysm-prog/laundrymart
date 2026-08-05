import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date, dateTime, number, today } from "@/lib/format";
import {
  DataTable, EmptyState, PageHeader, SkeletonRows,
} from "@/components/ui";

export const metadata = { title: "Pickups" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  pickup_date: string;
  bag_count: number;
  total_weight_kg: number | null;
  signed_by: string | null;
  completed_at: string | null;
  job_id: string;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
  pickup_lines: Array<{ quantity: number; damaged_quantity: number; missing_quantity: number }>;
};

export default async function PickupsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  await requireCapability("operations.read");

  const to = params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : today();
  const from = params.from && /^\d{4}-\d{2}-\d{2}$/.test(params.from) ? params.from : to;

  return (
    <div className="space-y-6">
      <PageHeader title="Pickups" description="Every collection recorded in the field, with damage and shortfalls." />

      <form method="get" action="/operations/pickups" className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">From</span>
          <input type="date" name="from" defaultValue={from} className="rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">To</span>
          <input type="date" name="to" defaultValue={to} className="rounded-md border bg-surface px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="rounded-md border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted">
          Show
        </button>
      </form>

      <Suspense key={`${from}:${to}`} fallback={<SkeletonRows rows={8} />}>
        <PickupList from={from} to={to} />
      </Suspense>
    </div>
  );
}

async function PickupList({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pickups")
    .select("id, pickup_date, bag_count, total_weight_kg, signed_by, completed_at, job_id, " +
            "customers(business_name), drivers(full_name), " +
            "pickup_lines(quantity, damaged_quantity, missing_quantity)")
    .gte("pickup_date", from).lte("pickup_date", to)
    .order("completed_at", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  const totals = (row: Row) => (row.pickup_lines ?? []).reduce(
    (acc, line) => ({
      quantity: acc.quantity + line.quantity,
      damaged: acc.damaged + line.damaged_quantity,
      missing: acc.missing + line.missing_quantity,
    }),
    { quantity: 0, damaged: 0, missing: 0 },
  );

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {date(from)} – {date(to)} · {data?.length ?? 0} pickup(s)
      </p>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/jobs/${row.job_id}`}
        empty={<EmptyState title="No pickups in this range" />}
        columns={[
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Date", cell: (row) => date(row.pickup_date) },
          { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
          { header: "Items", cell: (row) => number(totals(row).quantity), align: "right" },
          { header: "Damaged", cell: (row) => number(totals(row).damaged), align: "right", hideBelow: "sm" },
          { header: "Missing", cell: (row) => number(totals(row).missing), align: "right", hideBelow: "sm" },
          { header: "Bags", cell: (row) => number(row.bag_count), align: "right", hideBelow: "lg" },
          { header: "Completed", cell: (row) => dateTime(row.completed_at), hideBelow: "lg" },
        ]}
      />
    </>
  );
}
