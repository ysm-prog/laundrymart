import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date, dateTime, number, today } from "@/lib/format";
import { DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows } from "@/components/ui";

export const metadata = { title: "Deliveries" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  delivery_date: string;
  signed_by: string | null;
  completed_at: string | null;
  job_id: string;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
  delivery_lines: Array<{ quantity: number }>;
};

export default async function DeliveriesPage({
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
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader title="Deliveries" description="Clean linen handed over, with the signature captured at the stop." />

      <form method="get" action="/operations/deliveries" className="flex flex-wrap items-end gap-2">
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
        <DeliveryList from={from} to={to} />
      </Suspense>
    </div>
  );
}

async function DeliveryList({ from, to }: { from: string; to: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("deliveries")
    .select("id, delivery_date, signed_by, completed_at, job_id, " +
            "customers(business_name), drivers(full_name), delivery_lines(quantity)")
    .gte("delivery_date", from).lte("delivery_date", to)
    .order("completed_at", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  const total = (row: Row) => (row.delivery_lines ?? []).reduce((sum, line) => sum + line.quantity, 0);

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {date(from)} – {date(to)} · {data?.length ?? 0} delivery(s)
      </p>
      <DataTable
        rows={data ?? []}
        rowHref={(row) => `/jobs/${row.job_id}`}
        empty={<EmptyState title="No deliveries in this range" />}
        columns={[
          { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
          { header: "Date", cell: (row) => date(row.delivery_date) },
          { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
          { header: "Items", cell: (row) => number(total(row)), align: "right" },
          { header: "Signed by", cell: (row) => row.signed_by ?? "—", hideBelow: "sm" },
          { header: "Completed", cell: (row) => dateTime(row.completed_at), hideBelow: "lg" },
        ]}
      />
    </>
  );
}
