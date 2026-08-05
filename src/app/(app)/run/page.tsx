import { Suspense } from "react";
import Link from "next/link";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { date, dateTime, today } from "@/lib/format";
import type { DailyRoute, Item } from "@/lib/db/types";
import {
  Button, Card, EmptyState, FlashMessages, Notice, PageHeader, SkeletonRows,
  StatusBadge, humanise,
} from "@/components/ui";
import { Checkbox, Field, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { OfflineCapture, ServiceWorkerRegistrar } from "@/components/offline-capture";
import { MediaUploadField } from "@/components/media-upload-field";
import { CHECKLIST_KEYS, CHECKLIST_LABELS } from "./checklist";
import { closeRun, confirmLoad, markReturning, startRun, submitInspection, unloadRun } from "./actions";

export const metadata = { title: "My run" };
export const dynamic = "force-dynamic";

type Stop = {
  id: string;
  job_number: string;
  sequence: number;
  service_type: string;
  status: string;
  progress_status: string;
  customers: { business_name: string; phone: string | null; special_instructions: string | null } | null;
  customer_locations: { name: string; address_line1: string | null; suburb: string | null; access_notes: string | null } | null;
};

export default async function RunPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; stop?: string }>;
}) {
  const params = await searchParams;
  const session = await requireCapability("run.execute");
  const routeDate = today();

  const supabase = await createClient();
  const { data: driver } = await supabase
    .from("drivers").select("id, full_name").eq("user_id", session.userId).maybeSingle();

  if (!driver) {
    return (
      <div className="space-y-4">
        <PageHeader title="My run" />
        <Notice tone="warning" title="No driver profile linked to your login">
          A dispatcher needs to link your account to a driver record before your run appears here.
        </Notice>
      </div>
    );
  }

  const { data: route } = await supabase
    .from("daily_routes")
    .select("id, route_date, code, name, status, driver_id, vehicle_id, depot_id, template_id, inspection_id, load_confirmed_at, started_at, returned_at, unloaded_at, closed_at, odometer_start_km, odometer_end_km, notes")
    .eq("driver_id", driver.id).eq("route_date", routeDate)
    .maybeSingle<DailyRoute>();

  return (
    <div className="space-y-6">
      <ServiceWorkerRegistrar />
      <FlashMessages error={params.error} ok={params.ok} />
      <PageHeader
        title={`Today's run · ${date(routeDate)}`}
        description={driver.full_name}
        actions={route ? <StatusBadge status={route.status} /> : null}
      />

      {!route ? (
        <EmptyState
          title="No run assigned for today"
          description="Once a dispatcher assigns you a route it will appear here — including offline."
        />
      ) : (
        <>
          <RunWorkflow route={route} />
          <Suspense fallback={<SkeletonRows rows={5} />}>
            <Stops routeId={route.id} activeStopId={params.stop} routeStatus={route.status} />
          </Suspense>
        </>
      )}
    </div>
  );
}

/**
 * The guided workflow from spec §7.8, in order, with the next step actionable.
 *
 * The inspection is step 1 and stays the expected start of the day, but it no
 * longer blocks the load confirmation — a run whose inspection went on paper,
 * or whose driver is not linked to a driver record, used to be unstartable by
 * anyone. The database rule went with it (migration 0012).
 */
function RunWorkflow({ route }: { route: DailyRoute }) {
  const inspectionDone = !!route.inspection_id;
  const loadDone = !!route.load_confirmed_at;
  const started = !!route.started_at;

  return (
    <Card title={`${route.code} · ${route.name}`}>
      <ol className="space-y-3">
        <Stage index={1} label="Vehicle inspection" done={inspectionDone}
               detail={inspectionDone ? "Recorded" : "Record it before you set off"}>
          {!inspectionDone && !started ? (
            route.vehicle_id ? (
              <form action={submitInspection} className="space-y-3">
                <input type="hidden" name="route_id" value={route.id} />
                <input type="hidden" name="vehicle_id" value={route.vehicle_id} />
                <div className="grid gap-2 sm:grid-cols-2">
                  {CHECKLIST_KEYS.map((key) => (
                    <Checkbox key={key} name={`check_${key}`} label={CHECKLIST_LABELS[key]} defaultChecked />
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Odometer (km)" name="odometer_km">
                    <Input name="odometer_km" type="number" min={0} inputMode="numeric" />
                  </Field>
                  <Field label="Result" name="result">
                    <Select name="result" defaultValue="pass" options={[
                      { value: "pass", label: "Pass" },
                      { value: "pass_with_defects", label: "Pass with defects" },
                      { value: "fail", label: "Fail — do not drive" },
                    ]} />
                  </Field>
                  <Field label="Defects" name="defects">
                    <Input name="defects" placeholder="Nearside indicator intermittent" />
                  </Field>
                </div>
                <MediaUploadField scope="inspection" photosName="photo_paths" photoLabel="Defect photos" />
                <SubmitButton>Submit inspection</SubmitButton>
              </form>
            ) : (
              <Notice tone="warning">No vehicle is assigned to this run yet — contact your dispatcher.</Notice>
            )
          ) : null}
        </Stage>

        <Stage index={2} label="Load clean linen" done={loadDone}
               detail={loadDone ? `Confirmed ${dateTime(route.load_confirmed_at)}` : "Confirm once the van is loaded"}>
          {!loadDone ? (
            <form action={confirmLoad}>
              <input type="hidden" name="route_id" value={route.id} />
              <SubmitButton>Confirm load</SubmitButton>
            </form>
          ) : null}
        </Stage>

        <Stage index={3} label="Start route" done={started}
               detail={started ? `Started ${dateTime(route.started_at)}` : "Available once the load is confirmed"}>
          {loadDone && !started ? (
            <form action={startRun}>
              <input type="hidden" name="route_id" value={route.id} />
              <SubmitButton>Start route</SubmitButton>
            </form>
          ) : null}
        </Stage>

        <Stage index={4} label="Return to depot" done={!!route.returned_at}
               detail={route.returned_at ? dateTime(route.returned_at) : "Mark when you head back"}>
          {started && !route.returned_at ? (
            <form action={markReturning}>
              <input type="hidden" name="route_id" value={route.id} />
              <SubmitButton variant="secondary">I&apos;m returning</SubmitButton>
            </form>
          ) : null}
        </Stage>

        <Stage index={5} label="Unload" done={!!route.unloaded_at}
               detail={route.unloaded_at
                 ? dateTime(route.unloaded_at)
                 : "Moves everything still on the vehicle into depot receiving"}>
          {route.returned_at && !route.unloaded_at ? (
            <form action={unloadRun} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="route_id" value={route.id} />
              <Field label="Closing odometer (km)" name="odometer_end_km">
                <Input name="odometer_end_km" type="number" min={0} inputMode="numeric" />
              </Field>
              <SubmitButton>Unload vehicle</SubmitButton>
            </form>
          ) : null}
        </Stage>

        <Stage index={6} label="Close run" done={!!route.closed_at}
               detail={route.closed_at ? dateTime(route.closed_at) : "Final step for the day"}>
          {route.unloaded_at && !route.closed_at ? (
            <form action={closeRun}>
              <input type="hidden" name="route_id" value={route.id} />
              <Button variant="primary">Close run</Button>
            </form>
          ) : null}
        </Stage>
      </ol>
    </Card>
  );
}

function Stage({
  index, label, detail, done, children,
}: {
  index: number; label: string; detail: string; done: boolean; children?: React.ReactNode;
}) {
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <span aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center text-xs font-semibold ${
                done ? "bg-success/15 text-success" : "bg-surface-muted text-muted-foreground"}`}>
          {done ? "✓" : index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{detail}</p>
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </li>
  );
}

async function Stops({
  routeId, activeStopId, routeStatus,
}: {
  routeId: string; activeStopId?: string; routeStatus: string;
}) {
  const supabase = await createClient();
  const [{ data: stops }, { data: items }] = await Promise.all([
    supabase.from("jobs")
      .select("id, job_number, sequence, service_type, status, progress_status, " +
              "customers(business_name, phone, special_instructions), " +
              "customer_locations(name, address_line1, suburb, access_notes)")
      .eq("route_id", routeId).order("sequence")
      .returns<Stop[]>(),
    supabase.from("items").select("id, name, sku")
      .eq("status", "active").is("deleted_at", null).order("name")
      .returns<Pick<Item, "id" | "name" | "sku">[]>(),
  ]);

  const rows = stops ?? [];
  const active = rows.find((stop) => stop.id === activeStopId);
  const canCapture = ["in_progress", "returning"].includes(routeStatus);

  return (
    <div className="space-y-4">
      <Card title={`Stops · ${rows.filter((s) => s.status === "completed").length}/${rows.length} done`}>
        {rows.length === 0 ? (
          <EmptyState title="This run has no stops" />
        ) : (
          <ol className="space-y-2">
            {rows.map((stop) => (
              <li key={stop.id}
                  className={`rounded-md border p-3 ${stop.id === activeStopId ? "border-primary" : ""}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-6 text-sm font-semibold tabular-nums text-muted-foreground">
                    {stop.sequence}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{stop.customers?.business_name ?? "Unknown customer"}</p>
                    <p className="text-xs text-muted-foreground">
                      {[stop.customer_locations?.name, stop.customer_locations?.suburb]
                        .filter(Boolean).join(" · ") || "No site recorded"} · {humanise(stop.service_type)}
                    </p>
                  </div>
                  <StatusBadge status={stop.progress_status} />
                  <Link href={`/run?stop=${stop.id}`}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-surface-muted">
                    {stop.id === activeStopId ? "Open" : "Select"}
                  </Link>
                </div>
                {stop.customers?.special_instructions ? (
                  <p className="mt-2 text-xs">Instructions: {stop.customers.special_instructions}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {active ? (
        <Card
          title={`Capture · ${active.customers?.business_name ?? "Stop"}`}
          description="Saved on this device first, then synced. Works with no signal."
        >
          {!canCapture ? (
            <Notice tone="warning">Start the route before recording stops.</Notice>
          ) : (
            <div className="space-y-6">
              {active.service_type !== "delivery" ? (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Pickup</h3>
                  <OfflineCapture jobId={active.id} kind="pickup" items={items ?? []} />
                </section>
              ) : null}
              {active.service_type !== "pickup" ? (
                <section className="border-t pt-4">
                  <h3 className="mb-2 text-sm font-semibold">Delivery</h3>
                  <OfflineCapture jobId={active.id} kind="delivery" items={items ?? []} />
                </section>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Need to flag a problem? Open the{" "}
                <Link href={`/jobs/${active.id}`} className="text-primary hover:underline">job</Link>{" "}
                and record an exception.
              </p>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
