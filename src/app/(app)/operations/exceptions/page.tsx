import { Suspense } from "react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date } from "@/lib/format";
import {
  DataTable, EmptyState, FlashMessages, PageHeader, SkeletonRows, humanise,
} from "@/components/ui";
import { resolveException } from "@/app/(app)/jobs/actions";

export const metadata = { title: "Exceptions" };
export const dynamic = "force-dynamic";

type Row = {
  id: string;
  job_number: string;
  scheduled_date: string;
  exception_reason: string | null;
  exception_notes: string | null;
  customers: { business_name: string } | null;
  drivers: { full_name: string } | null;
};

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const session = await requireCapability("operations.read");

  return (
    <div className="space-y-6">
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title="Exceptions"
        description="Stops that could not be completed. Clearing one puts the job back in the queue."
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <ExceptionList writable={can(session.role, "operations.write")} />
      </Suspense>
    </div>
  );
}

async function ExceptionList({ writable }: { writable: boolean }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("jobs")
    .select("id, job_number, scheduled_date, exception_reason, exception_notes, " +
            "customers(business_name), drivers(full_name)")
    .eq("status", "exception")
    .order("scheduled_date", { ascending: false })
    .limit(200)
    .returns<Row[]>();

  return (
    <DataTable
      rows={data ?? []}
      rowHref={(row) => `/jobs/${row.id}`}
      empty={<EmptyState title="No open exceptions" description="Every stop either completed or is still in progress." />}
      columns={[
        { header: "Job", cell: (row) => row.job_number },
        { header: "Customer", cell: (row) => row.customers?.business_name ?? "—" },
        { header: "Date", cell: (row) => date(row.scheduled_date), hideBelow: "sm" },
        { header: "Reason", cell: (row) => humanise(row.exception_reason) },
        { header: "Notes", cell: (row) => row.exception_notes ?? "—", hideBelow: "lg" },
        { header: "Driver", cell: (row) => row.drivers?.full_name ?? "—", hideBelow: "md" },
        {
          header: "",
          align: "right",
          cell: (row) => (writable ? (
            <form action={resolveException}>
              <input type="hidden" name="id" value={row.id} />
              <button type="submit" className="text-xs font-medium text-primary hover:underline">
                Clear
              </button>
            </form>
          ) : null),
        },
      ]}
    />
  );
}
