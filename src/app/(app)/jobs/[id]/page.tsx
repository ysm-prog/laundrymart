import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date, dateTime, number } from "@/lib/format";
import type { Delivery, Item, Job, Pickup } from "@/lib/db/types";
import {
  Button, ButtonLink, Card, DataTable, EmptyState, Notice,
  PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { Field, Input, Select, SubmitButton, Textarea } from "@/components/form";
import { MediaUploadField } from "@/components/media-upload-field";
import { ProofOfService } from "@/components/proof-of-service";
import { parseExceptionNotes } from "@/lib/exceptions";
import { EXCEPTION_REASONS } from "../exception-reasons";
import { flagException, recordDelivery, recordPickup, setJobProgress } from "../actions";

export const dynamic = "force-dynamic";

const PROGRESS_STEPS = [
  { value: "travelling", label: "Travelling" },
  { value: "at_customer", label: "At customer" },
  { value: "completed", label: "Complete job" },
];


type JobDetail = Job & {
  customers: { business_name: string; customer_number: string; phone: string | null; special_instructions: string | null } | null;
  customer_locations: { name: string; address_line1: string | null; suburb: string | null; access_notes: string | null } | null;
  daily_routes: { id: string; code: string; route_date: string; status: string } | null;
};

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("operations.read");
  const writable = can(session.role, "operations.write");

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("jobs")
    .select(
      "id, job_number, scheduled_date, sequence, service_type, status, progress_status, " +
      "customer_id, location_id, route_id, driver_id, agreement_id, arrived_at, completed_at, " +
      "exception_reason, exception_notes, notes, " +
      "customers(business_name, customer_number, phone, special_instructions), " +
      "customer_locations(name, address_line1, suburb, access_notes), " +
      "daily_routes(id, code, route_date, status)",
    )
    .eq("id", id)
    .maybeSingle<JobDetail>();

  if (!job) notFound();

  const doesPickup = job.service_type === "pickup" || job.service_type === "both";
  const doesDelivery = job.service_type === "delivery" || job.service_type === "both";

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${job.job_number} · ${job.customers?.business_name ?? "Unknown customer"}`}
        description={`${date(job.scheduled_date)} · ${humanise(job.service_type)}${
          job.daily_routes ? ` · route ${job.daily_routes.code}` : " · no route"}`}
        actions={
          <>
            <StatusBadge status={job.status} />
            <StatusBadge status={job.progress_status} />
            <ButtonLink href={`/customers/${job.customer_id}`}>Customer</ButtonLink>
            {job.daily_routes ? <ButtonLink href={`/routes/daily/${job.daily_routes.id}`}>Route</ButtonLink> : null}
          </>
        }
      />

      {job.status === "exception" ? (
        <ExceptionNotice
          reason={job.exception_reason}
          rawNotes={job.exception_notes}
          tenantId={session.tenantId}
        />
      ) : null}

      {job.customers?.special_instructions ? (
        <Notice tone="info" title="Customer instructions">{job.customers.special_instructions}</Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Stop details" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="Site" value={job.customer_locations?.name ?? "Primary"} />
            <Row label="Address" value={[job.customer_locations?.address_line1, job.customer_locations?.suburb]
              .filter(Boolean).join(", ") || "—"} />
            <Row label="Access" value={job.customer_locations?.access_notes ?? "—"} />
            <Row label="Phone" value={job.customers?.phone ?? "—"} />
            <Row label="Arrived" value={dateTime(job.arrived_at)} />
            <Row label="Completed" value={dateTime(job.completed_at)} />
          </dl>
        </Card>

        {writable ? (
          <Card title="Progress" className="lg:col-span-2">
            <div className="flex flex-wrap gap-2">
              {PROGRESS_STEPS.map((step) => (
                <form key={step.value} action={setJobProgress}>
                  <input type="hidden" name="id" value={job.id} />
                  <input type="hidden" name="progress_status" value={step.value} />
                  <Button variant={step.value === "completed" ? "primary" : "secondary"}>{step.label}</Button>
                </form>
              ))}
            </div>

            <form action={flagException} className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-3">
              <input type="hidden" name="id" value={job.id} />
              <Field label="Exception reason" name="exception_reason">
                <Select name="exception_reason" options={EXCEPTION_REASONS} defaultValue="customer_closed" />
              </Field>
              <Field label="Notes" name="exception_notes" className="sm:col-span-2">
                <Input name="exception_notes" placeholder="Gate locked, no answer on the intercom" />
              </Field>
              <div className="sm:col-span-3">
                <SubmitButton variant="danger">Flag exception</SubmitButton>
              </div>
            </form>
          </Card>
        ) : null}
      </div>

      {doesPickup ? (
        <Suspense fallback={<SkeletonRows rows={4} />}>
          <PickupSection jobId={id} writable={writable} tenantId={session.tenantId} />
        </Suspense>
      ) : null}

      {doesDelivery ? (
        <Suspense fallback={<SkeletonRows rows={4} />}>
          <DeliverySection jobId={id} writable={writable} tenantId={session.tenantId} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * The exception, with any photo the driver took at the kerb. The photo path
 * rides inside `exception_notes` as a marker (see `lib/exceptions.ts`), so the
 * raw column never renders directly.
 */
function ExceptionNotice({
  reason, rawNotes, tenantId,
}: { reason: string | null; rawNotes: string | null; tenantId: string }) {
  const { note, photos } = parseExceptionNotes(rawNotes);
  return (
    <Notice tone="danger" title={`Exception: ${humanise(reason)}`}>
      {note || "No further detail recorded."}
      {photos.length > 0 ? (
        <ProofOfService photoPaths={photos} tenantId={tenantId} />
      ) : null}
    </Notice>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

async function activeItems() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("items").select("id, name, sku, category")
    .eq("status", "active").is("deleted_at", null).order("name")
    .returns<Pick<Item, "id" | "name" | "sku" | "category">[]>();
  return data ?? [];
}

async function PickupSection({
  jobId, writable, tenantId,
}: {
  jobId: string; writable: boolean; tenantId: string;
}) {
  const supabase = await createClient();
  const [{ data: pickups }, items] = await Promise.all([
    supabase.from("pickups")
      .select("id, job_id, customer_id, pickup_date, bag_count, total_weight_kg, notes, signed_by, completed_at, " +
              "photo_urls, signature_url, " +
              "pickup_lines(id, item_id, quantity, damaged_quantity, missing_quantity)")
      .eq("job_id", jobId).order("completed_at", { ascending: false })
      .returns<Array<Pickup & { pickup_lines: Array<{ id: string; item_id: string; quantity: number; damaged_quantity: number; missing_quantity: number }> }>>(),
    activeItems(),
  ]);

  const itemName = new Map(items.map((item) => [item.id, item.name]));

  return (
    <Card title="Pickup" description="Dirty linen collected from the customer.">
      {pickups?.length ? (
        <div className="space-y-4">
          {pickups.map((pickup) => (
            <div key={pickup.id} className="rounded-md border p-3">
              <p className="text-sm font-medium">
                {dateTime(pickup.completed_at)} · {pickup.bag_count} bag(s)
                {pickup.total_weight_kg ? ` · ${number(pickup.total_weight_kg)} kg` : ""}
                {pickup.signed_by ? ` · signed by ${pickup.signed_by}` : ""}
              </p>
              <DataTable
                rows={pickup.pickup_lines ?? []}
                empty={<p className="text-sm text-muted-foreground">No lines.</p>}
                columns={[
                  { header: "Item", cell: (line) => itemName.get(line.item_id) ?? "Unknown item" },
                  { header: "Collected", cell: (line) => line.quantity, align: "right" },
                  { header: "Damaged", cell: (line) => line.damaged_quantity, align: "right" },
                  { header: "Missing", cell: (line) => line.missing_quantity, align: "right" },
                ]}
              />
              {pickup.notes ? <p className="mt-2 text-sm text-muted-foreground">{pickup.notes}</p> : null}
              <ProofOfService
                photoPaths={pickup.photo_urls}
                signaturePath={pickup.signature_url}
                signedBy={pickup.signed_by}
                tenantId={tenantId}
              />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No pickup recorded yet" />
      )}

      {writable ? (
        <form action={recordPickup} className="mt-4 space-y-4 border-t pt-4">
          <input type="hidden" name="job_id" value={jobId} />
          <CountGrid items={items} showDamage />
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Bags" name="bag_count">
              <Input name="bag_count" type="number" min={0} defaultValue="0" />
            </Field>
            <Field label="Total weight (kg)" name="total_weight_kg">
              <Input name="total_weight_kg" type="number" step="0.001" min={0} />
            </Field>
            <Field label="Signed by" name="signed_by">
              <Input name="signed_by" placeholder="Name of the person signing" />
            </Field>
            <Field label="Notes" name="notes">
              <Input name="notes" />
            </Field>
          </div>
          <MediaUploadField
            scope="pickup"
            photosName="photo_paths"
            signatureName="signature_path"
            photoLabel="Collection photos"
            signatureLabel="Customer signature"
          />
          <SubmitButton>Record pickup</SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}

async function DeliverySection({
  jobId, writable, tenantId,
}: {
  jobId: string; writable: boolean; tenantId: string;
}) {
  const supabase = await createClient();
  const [{ data: deliveries }, items] = await Promise.all([
    supabase.from("deliveries")
      .select("id, job_id, customer_id, delivery_date, notes, signed_by, completed_at, " +
              "photo_urls, signature_url, " +
              "delivery_lines(id, item_id, quantity)")
      .eq("job_id", jobId).order("completed_at", { ascending: false })
      .returns<Array<Delivery & { delivery_lines: Array<{ id: string; item_id: string; quantity: number }> }>>(),
    activeItems(),
  ]);

  const itemName = new Map(items.map((item) => [item.id, item.name]));

  return (
    <Card title="Delivery" description="Clean linen handed over at this stop.">
      {deliveries?.length ? (
        <div className="space-y-4">
          {deliveries.map((delivery) => (
            <div key={delivery.id} className="rounded-md border p-3">
              <p className="text-sm font-medium">
                {dateTime(delivery.completed_at)}
                {delivery.signed_by ? ` · signed by ${delivery.signed_by}` : ""}
              </p>
              <DataTable
                rows={delivery.delivery_lines ?? []}
                empty={<p className="text-sm text-muted-foreground">No lines.</p>}
                columns={[
                  { header: "Item", cell: (line) => itemName.get(line.item_id) ?? "Unknown item" },
                  { header: "Delivered", cell: (line) => line.quantity, align: "right" },
                ]}
              />
              {delivery.notes ? <p className="mt-2 text-sm text-muted-foreground">{delivery.notes}</p> : null}
              <ProofOfService
                photoPaths={delivery.photo_urls}
                signaturePath={delivery.signature_url}
                signedBy={delivery.signed_by}
                tenantId={tenantId}
              />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No delivery recorded yet" />
      )}

      {writable ? (
        <form action={recordDelivery} className="mt-4 space-y-4 border-t pt-4">
          <input type="hidden" name="job_id" value={jobId} />
          <CountGrid items={items} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Signed by" name="signed_by">
              <Input name="signed_by" />
            </Field>
            <Field label="Notes" name="notes">
              <Textarea name="notes" rows={2} />
            </Field>
          </div>
          <MediaUploadField
            scope="delivery"
            photosName="photo_paths"
            signatureName="signature_path"
            photoLabel="Delivery photos"
            signatureLabel="Customer signature"
          />
          <SubmitButton>Record delivery</SubmitButton>
        </form>
      ) : null}
    </Card>
  );
}

/** Quantity inputs keyed by item id — see `countedLines` in the job actions. */
function CountGrid({
  items, showDamage = false,
}: {
  items: Array<{ id: string; name: string; sku: string }>;
  showDamage?: boolean;
}) {
  if (!items.length) {
    return <Notice tone="warning">No active items — add items before recording quantities.</Notice>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted text-left">
          <tr>
            <th className="px-3 py-2 text-xs font-semibold text-muted-foreground">Item</th>
            <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Qty</th>
            {showDamage ? (
              <>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Damaged</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">Missing</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t">
              <td className="px-3 py-2">
                <label htmlFor={`qty_${item.id}`}>{item.name}</label>
                <span className="ml-2 text-xs text-muted-foreground">{item.sku}</span>
              </td>
              <td className="px-3 py-1 text-right">
                <input id={`qty_${item.id}`} name={`qty_${item.id}`} type="number" min={0}
                       inputMode="numeric" placeholder="0"
                       className="w-20 rounded-md border bg-surface px-2 py-1 text-right text-sm" />
              </td>
              {showDamage ? (
                <>
                  <td className="px-3 py-1 text-right">
                    <input name={`damaged_${item.id}`} type="number" min={0} inputMode="numeric" placeholder="0"
                           aria-label={`${item.name} damaged`}
                           className="w-20 rounded-md border bg-surface px-2 py-1 text-right text-sm" />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <input name={`missing_${item.id}`} type="number" min={0} inputMode="numeric" placeholder="0"
                           aria-label={`${item.name} missing`}
                           className="w-20 rounded-md border bg-surface px-2 py-1 text-right text-sm" />
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
