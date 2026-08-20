import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date } from "@/lib/format";
import { ButtonLink, humanise } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

export const metadata = { title: "Route sheet" };
export const dynamic = "force-dynamic";

type SheetJob = {
  id: string;
  job_number: string;
  sequence: number;
  service_type: string;
  notes: string | null;
  customers: { business_name: string; phone: string | null; special_instructions: string | null } | null;
  customer_locations: {
    name: string; address_line1: string | null; suburb: string | null;
    state: string | null; postcode: string | null; access_notes: string | null;
  } | null;
};

/**
 * Print-first route sheet. Rendered as HTML and printed by the browser rather
 * than generated server-side as a PDF — no headless browser in the request path,
 * and drivers can print from any device.
 */
export default async function RouteSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCapability("routes.read");

  const supabase = await createClient();
  const [{ data: route }, { data: jobs }] = await Promise.all([
    supabase.from("daily_routes")
      .select("id, code, name, route_date, status, notes, drivers(full_name), vehicles!daily_routes_vehicle_id_fkey(registration)")
      .eq("id", id).maybeSingle<{
        id: string; code: string; name: string; route_date: string; status: string; notes: string | null;
        drivers: { full_name: string } | null; vehicles: { registration: string } | null;
      }>(),
    supabase.from("jobs")
      .select("id, job_number, sequence, service_type, notes, " +
              "customers(business_name, phone, special_instructions), " +
              "customer_locations(name, address_line1, suburb, state, postcode, access_notes)")
      .eq("route_id", id).order("sequence")
      .returns<SheetJob[]>(),
  ]);

  if (!route) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <ButtonLink href={`/routes/daily/${id}`}>← Back to route</ButtonLink>
        <PrintButton />
      </div>

      <article className="rounded-lg border bg-surface p-6 print:border-0 print:p-0">
        <header className="mb-4 border-b pb-3">
          <h1 className="text-xl font-semibold">Route sheet · {route.code}</h1>
          <p className="text-sm text-muted-foreground">{route.name}</p>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Meta label="Date" value={date(route.route_date)} />
            <Meta label="Driver" value={route.drivers?.full_name ?? "Unassigned"} />
            <Meta label="Vehicle" value={route.vehicles?.registration ?? "Unassigned"} />
            <Meta label="Stops" value={String(jobs?.length ?? 0)} />
          </dl>
        </header>

        <ol className="divide-y">
          {(jobs ?? []).map((job) => (
            <li key={job.id} className="break-inside-avoid py-3">
              <div className="flex items-baseline gap-3">
                <span className="text-lg font-semibold tabular-nums">{job.sequence}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{job.customers?.business_name ?? "Unknown customer"}</p>
                  <p className="text-sm text-muted-foreground">
                    {[
                      job.customer_locations?.name,
                      job.customer_locations?.address_line1,
                      job.customer_locations?.suburb,
                      job.customer_locations?.state,
                      job.customer_locations?.postcode,
                    ].filter(Boolean).join(", ") || "No site address recorded"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {humanise(job.service_type)} · {job.job_number}
                    {job.customers?.phone ? ` · ${job.customers.phone}` : ""}
                  </p>
                  {job.customer_locations?.access_notes ? (
                    <p className="mt-1 text-xs">Access: {job.customer_locations.access_notes}</p>
                  ) : null}
                  {job.customers?.special_instructions ? (
                    <p className="mt-1 text-xs">Instructions: {job.customers.special_instructions}</p>
                  ) : null}
                  {job.notes ? <p className="mt-1 text-xs">Note: {job.notes}</p> : null}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <SignLine label="Bags out" />
                <SignLine label="Bags in" />
                <SignLine label="Signature" />
              </div>
            </li>
          ))}
        </ol>

        {route.notes ? (
          <footer className="mt-4 border-t pt-3 text-sm">
            <p className="font-medium">Route notes</p>
            <p className="text-muted-foreground">{route.notes}</p>
          </footer>
        ) : null}
      </article>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function SignLine({ label }: { label: string }) {
  return (
    <div>
      <div className="mt-4 border-b border-dotted" />
      <span>{label}</span>
    </div>
  );
}
