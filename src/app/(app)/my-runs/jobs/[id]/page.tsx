import { notFound } from "next/navigation";
import Link from "next/link";
import { MapPin, Phone } from "lucide-react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  Badge, ButtonLink, Card, Notice, PageContainer, PageHeader, cx, humanise,
} from "@/components/ui";
import { SubmitButton } from "@/components/form";
import {
  ORDER_STATUS_LABELS, describeItem, type OrderStatus,
} from "@/lib/domain/laundry-orders";
import { formatAdelaideDate, formatAdelaideDateTime } from "@/lib/domain/timezone";
import { markJobDelivered } from "../../actions";

export const metadata = { title: "Job" };
export const dynamic = "force-dynamic";

/**
 * The driver's view of a job: everything they need, nothing they can change.
 *
 * A deliberately separate screen from `/orders/:id`, which is the counter's and
 * the manager's — that page carries the status controls, the cancel action, the
 * edit link and the whole activity trail, and §17 asks that a driver not be
 * surrounded by editing forms. This one is read-only by construction: it
 * renders no form except the single "Mark delivered", and there is nothing on
 * it to press that changes what was agreed with the customer.
 *
 * The read-only-ness is not enforced *here*, though, and that is the point.
 * `/orders/:id/edit` is gated on `orders.write`, `cancelOrder` on
 * `orders.manage`, and a driver holds neither, so opening those URLs by hand or
 * posting to those actions is refused by the guards those screens already have.
 * Since 0015, RLS refuses even the read unless the job is on one of the
 * driver's own stops. This page is a kindness on top of three real boundaries,
 * not a substitute for them.
 */
type JobDetail = {
  id: string;
  order_number: string;
  status: OrderStatus;
  priority: string;
  delivery_required: boolean;
  due_date: string | null;
  received_at: string;
  delivery_window: string | null;
  expected_delivery_time: string | null;
  expected_delivery_date: string | null;
  delivery_address: string | null;
  delivery_instructions: string | null;
  special_instructions: string | null;
  stop_id: string | null;
  completed_at: string | null;
  customers: {
    id: string; business_name: string; trading_name: string | null;
    phone: string | null; email: string | null;
  } | null;
  laundry_order_items: Array<{
    item_type: string; custom_description: string | null; quantity_type: string;
    exact_quantity: number | null; bag_count: number | null;
    estimated_quantity: number | null; notes: string | null;
  }>;
};

export default async function DriverJobPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date } = await searchParams;
  const session = await requireCapability("routes.read");

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("laundry_orders")
    .select(
      "id, order_number, status, priority, delivery_required, due_date, received_at, " +
      "delivery_window, expected_delivery_time, expected_delivery_date, delivery_address, " +
      "delivery_instructions, special_instructions, stop_id, completed_at, " +
      "customers(id, business_name, trading_name, phone, email), " +
      "laundry_order_items(item_type, custom_description, quantity_type, exact_quantity, " +
      "bag_count, estimated_quantity, notes)",
    )
    .eq("id", id)
    .maybeSingle<JobDetail>();

  // Not found *or* not theirs — RLS makes those the same answer, which is the
  // right one to give: a 404 tells an attacker nothing a 403 would not.
  if (!job) notFound();

  const stop = job.stop_id ? await loadStop(supabase, job.stop_id) : null;
  const backTo = `/my-runs${date ? `?date=${date}` : ""}`;
  const finished = job.status === "completed" || job.status === "cancelled";
  const rolling = ["in_progress", "returning", "unloading"].includes(stop?.run?.status ?? "");
  const canDeliver = can(session.role, "orders.status") || can(session.role, "run.execute");

  return (
    <PageContainer width="form">
      <PageHeader
        title={job.order_number}
        description={job.customers?.business_name ?? "Unknown customer"}
        eyebrow={stop?.run ? `${stop.run.code} · stop ${stop.sequence}` : "Not on a run"}
        back={{ href: backTo, label: "Back to my runs" }}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {job.priority === "urgent" ? <Badge tone="warning">Urgent</Badge> : null}
            <Badge tone={finished ? "success" : "info"}>
              {ORDER_STATUS_LABELS[job.status] ?? humanise(job.status)}
            </Badge>
          </div>
        }
      />

      <div className="space-y-5">
        <Card title="Where it goes">
          <div className="space-y-2 text-sm">
            <p className="text-base font-semibold">
              {job.customers?.business_name ?? "Unknown customer"}
              {job.customers?.trading_name ? ` (${job.customers.trading_name})` : null}
            </p>
            <p className="text-muted-foreground">
              {job.delivery_address
                ?? stop?.address
                ?? "No delivery address recorded on this job."}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              {job.customers?.phone ? (
                <a href={`tel:${job.customers.phone.replace(/\s+/g, "")}`}
                   className={contactLink}>
                  <Phone className="size-4" aria-hidden />
                  {job.customers.phone}
                </a>
              ) : null}
              {(job.delivery_address ?? stop?.address) ? (
                <a
                  href={"https://www.google.com/maps/dir/?api=1&destination="
                    + encodeURIComponent((job.delivery_address ?? stop?.address)!)}
                  target="_blank" rel="noreferrer" className={contactLink}
                >
                  <MapPin className="size-4" aria-hidden />
                  Navigate
                </a>
              ) : null}
            </div>
          </div>
        </Card>

        <Card title="Laundry" description="What is in this job, as it was taken in at the counter.">
          {job.laundry_order_items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No laundry items recorded.</p>
          ) : (
            <ul className="divide-y">
              {job.laundry_order_items.map((item, index) => (
                <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5">
                  <span className="text-sm font-medium">{describeItem(item)}</span>
                  {item.notes ? (
                    <span className="text-sm text-muted-foreground">{item.notes}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={job.delivery_required ? "Delivery" : "Customer pickup"}>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Fact label={job.delivery_required ? "Expected delivery" : "Expected collection"}>
              {formatAdelaideDate(job.due_date, "long")}
            </Fact>
            {job.delivery_required ? (
              <Fact label="Window">
                {job.delivery_window
                  ? humanise(job.delivery_window)
                    + (job.expected_delivery_time
                      ? ` at ${job.expected_delivery_time.slice(0, 5)}` : "")
                  : "No specific time"}
              </Fact>
            ) : null}
            <Fact label="Taken in">{formatAdelaideDateTime(job.received_at)}</Fact>
            {job.completed_at ? (
              <Fact label="Completed">{formatAdelaideDateTime(job.completed_at)}</Fact>
            ) : null}
          </dl>

          {job.delivery_instructions ? (
            <div className="mt-4 rounded-lg bg-surface-sunken px-3 py-2.5">
              <p className="text-sm font-medium">Delivery instructions</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{job.delivery_instructions}</p>
            </div>
          ) : null}
          {job.special_instructions ? (
            <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2.5">
              <p className="text-sm font-medium">Machine instructions</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{job.special_instructions}</p>
            </div>
          ) : null}
        </Card>

        <Card title="Assignment">
          {stop?.run ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="Run">{stop.run.code} · {stop.run.name}</Fact>
              <Fact label="Run date">{formatAdelaideDate(stop.run.route_date, "long")}</Fact>
              <Fact label="Driver">{stop.run.driverName ?? "Not assigned"}</Fact>
              <Fact label="Stop">
                <Link href={`/jobs/${stop.id}`} className="hover:underline">
                  {stop.job_number} (stop {stop.sequence})
                </Link>
              </Fact>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              This job is not on a run yet.
            </p>
          )}
        </Card>

        {finished ? (
          <Notice tone="success" title="Nothing left to do">
            This job is {ORDER_STATUS_LABELS[job.status].toLowerCase()}.
          </Notice>
        ) : !job.delivery_required ? (
          <Notice tone="info" title="The customer is collecting this one">
            It is handed over at the counter, so it never goes out on a van.
          </Notice>
        ) : canDeliver && rolling ? (
          <Card title="At the door">
            <form action={markJobDelivered} className="space-y-3">
              <input type="hidden" name="order_id" value={job.id} />
              <input type="hidden" name="return_to" value={backTo} />
              <label htmlFor="delivery-note" className="block text-sm font-medium">
                Anything worth noting? (optional)
              </label>
              <textarea
                id="delivery-note"
                name="note"
                rows={2}
                placeholder="Left with reception"
                className="min-h-11 w-full rounded-lg border border-strong bg-surface px-3 py-2
                           text-sm shadow-xs focus:border-primary focus:outline-none
                           focus:ring-2 focus:ring-primary/25"
              />
              <SubmitButton size="lg" pendingLabel="Recording…">Mark delivered</SubmitButton>
            </form>
          </Card>
        ) : canDeliver ? (
          <Notice tone="info">
            Start the run before recording a delivery against it.
          </Notice>
        ) : null}

        {can(session.role, "orders.read") ? (
          <div>
            <ButtonLink href={`/orders/${job.id}`}>Open the full job record</ButtonLink>
          </div>
        ) : null}
      </div>
    </PageContainer>
  );
}

const contactLink = cx(
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-strong bg-surface",
  "px-3 text-sm font-medium shadow-xs transition hover:bg-surface-muted",
);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

async function loadStop(
  supabase: Awaited<ReturnType<typeof createClient>>, stopId: string,
) {
  const { data } = await supabase
    .from("jobs")
    .select(
      "id, job_number, sequence, " +
      "customer_locations(address_line1, suburb, state, postcode), " +
      "daily_routes(id, code, name, route_date, status, drivers(full_name))",
    )
    .eq("id", stopId)
    .maybeSingle<{
      id: string; job_number: string; sequence: number;
      customer_locations: {
        address_line1: string | null; suburb: string | null;
        state: string | null; postcode: string | null;
      } | null;
      daily_routes: {
        id: string; code: string; name: string; route_date: string; status: string;
        drivers: { full_name: string } | null;
      } | null;
    }>();

  if (!data) return null;
  const address = [
    data.customer_locations?.address_line1, data.customer_locations?.suburb,
    data.customer_locations?.state, data.customer_locations?.postcode,
  ].filter(Boolean).join(", ");

  return {
    id: data.id,
    job_number: data.job_number,
    sequence: data.sequence,
    address: address || null,
    run: data.daily_routes
      ? { ...data.daily_routes, driverName: data.daily_routes.drivers?.full_name ?? null }
      : null,
  };
}
