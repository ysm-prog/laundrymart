import { notFound } from "next/navigation";
import { MapPin, Phone } from "lucide-react";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  Badge, ButtonLink, Card, Notice, PageContainer, PageHeader, cx, humanise,
} from "@/components/ui";
import {
  ORDER_STATUS_LABELS, describeItemWithOwnership, type OrderStatus,
} from "@/lib/domain/laundry-orders";
import {
  formatAdelaideDate, formatAdelaideDateTime, getAdelaideToday, isCalendarDate,
} from "@/lib/domain/timezone";
import { boardById, loadBoardJob } from "@/lib/runs/my-runs";
import { DriverInstructions } from "@/components/driver-instructions";
import { DeliverButton } from "../../deliver-sheet";
import { deliverableLines } from "../../run-view";
import { DeliveryProof } from "@/components/delivery-proof";

export const metadata = { title: "Job" };
export const dynamic = "force-dynamic";

/**
 * The round's view of a job: everything it needs, nothing it can change.
 *
 * A deliberately separate screen from `/orders/:id`, which is the counter's and
 * the manager's — that page carries the status controls, the assignment
 * controls, the cancel action, the edit link and the whole activity trail, and a
 * round should not be surrounded by editing forms while standing at a door.
 * This one is read-only by construction: it renders no form except the single
 * "Mark Delivered", and there is nothing on it to press that changes what was
 * agreed with the customer.
 *
 * The read-only-ness is not enforced *here*, though, and that is the point.
 * `/orders/:id/edit` is gated on `orders.write`, `cancelOrder` on
 * `orders.manage`, `assignJobToBoard` on `routes.write`, and a board holds
 * none of them — so opening those URLs by hand or posting to those actions is
 * refused by the guards those screens already have. Since 0016, RLS refuses even
 * the read unless the job is on this round. This page is a kindness on
 * top of several real boundaries, not a substitute for one.
 */
export default async function BoardJobPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date } = await searchParams;
  const session = await requireCapability("routes.read");

  const supabase = await createClient();
  const job = await loadBoardJob(supabase, session.tenantId, id);

  // Not found *or* not theirs — RLS makes those the same answer, which is the
  // right one to give: a 404 tells an attacker nothing a 403 would not.
  if (!job) notFound();

  // The day to come back to is the one the round was looking at. It falls back
  // to the job's own assigned date rather than to today, so completing a job on
  // a day you navigated to never bounces you to this morning.
  const backDate = date && isCalendarDate(date)
    ? date
    : job.assigned_delivery_date ?? getAdelaideToday();
  // And the board: without it a manager who marked the job delivered landed on
  // their default board's day — Board 1's, usually empty — and the job seemed
  // to vanish (2026-10-12). For the round itself `board=<its own id>` resolves
  // to "me", so carrying it costs the round nothing.
  const backTo = job.assigned_board_id
    ? `/my-runs?date=${backDate}&board=${job.assigned_board_id}`
    : `/my-runs?date=${backDate}`;

  const board = job.assigned_board_id
    ? await boardById(supabase, session.tenantId, job.assigned_board_id)
    : null;
  const deliveredBoard = job.delivered_board_id && job.delivered_board_id !== job.assigned_board_id
    ? await boardById(supabase, session.tenantId, job.delivered_board_id)
    : job.delivered_board_id ? board : null;
  const { data: deliveredDriver } = job.delivered_driver_id
    ? await supabase.from("drivers").select("full_name")
        .eq("tenant_id", session.tenantId).eq("id", job.delivered_driver_id)
        .maybeSingle<{ full_name: string }>()
    : { data: null };

  const finished = job.status === "completed" || job.status === "cancelled";
  const deliverable = job.status === "assigned" || job.status === "out_for_delivery";
  const canDeliver = can(session.role, "orders.status") || can(session.role, "run.execute");
  const address = job.delivery_address;

  return (
    <PageContainer width="form">
      <PageHeader
        title={job.order_number}
        description={job.customers?.business_name ?? "Unknown customer"}
        eyebrow={
          job.assigned_delivery_date
            ? `Assigned for ${formatAdelaideDate(job.assigned_delivery_date, "medium")}`
            : "Not assigned"
        }
        back={{ href: backTo, label: "Back to My Runs" }}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {job.priority === "urgent" ? <Badge tone="warning">Urgent</Badge> : null}
            <Badge tone={finished ? "success" : "info"}>
              {ORDER_STATUS_LABELS[job.status as OrderStatus] ?? humanise(job.status)}
            </Badge>
          </div>
        }
      />

      <div className="space-y-5">
        {/* **First on the page, above the address.** These used to sit at the
            foot of the Delivery card, under six dates, in muted grey — which is
            where a driver looks last. What is unusual about this delivery is the
            thing to read before setting off, so it leads. */}
        <DriverInstructions job={job} />

        <Card title="Where it goes">
          <div className="space-y-2 text-sm">
            <p className="text-base font-semibold">
              {job.customers?.business_name ?? "Unknown customer"}
            </p>
            <p className="text-muted-foreground">
              {address ?? "No delivery address recorded on this job."}
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              {job.customers?.phone ? (
                <a href={`tel:${job.customers.phone.replace(/\s+/g, "")}`} className={contactLink}>
                  <Phone className="size-4" aria-hidden />
                  {job.customers.phone}
                </a>
              ) : null}
              {address ? (
                <a
                  href={"https://www.google.com/maps/dir/?api=1&destination="
                    + encodeURIComponent(address)}
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
                  <span className="text-sm font-medium">{describeItemWithOwnership(item)}</span>
                  {item.notes ? (
                    <span className="text-sm text-muted-foreground">{item.notes}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Delivery">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Fact label="Expected delivery date">
              {formatAdelaideDate(job.expected_delivery_date, "long")}
            </Fact>
            <Fact label="Assigned delivery date">
              {formatAdelaideDate(job.assigned_delivery_date, "long")}
            </Fact>
            <Fact label="Assigned to">{board?.name ?? "Not assigned"}</Fact>
            <Fact label="Delivery window">
              {job.delivery_window
                ? humanise(job.delivery_window)
                  + (job.expected_delivery_time ? ` at ${job.expected_delivery_time.slice(0, 5)}` : "")
                : "No specific time"}
            </Fact>
            {job.load_confirmed_at ? (
              <Fact label="Load confirmed">{formatAdelaideDateTime(job.load_confirmed_at)}</Fact>
            ) : null}
            {job.completed_at ? (
              <Fact label="Completed">{formatAdelaideDateTime(job.completed_at)}</Fact>
            ) : null}
          </dl>

        </Card>

        <DeliveryProof
          tenantId={session.tenantId}
          deliveredAt={job.status === "completed" ? job.completed_at : null}
          receivedBy={job.delivery_received_by ?? null}
          signaturePath={job.delivery_signature_path ?? null}
          photoPaths={job.delivery_photo_paths ?? null}
          short={job.delivery_short ?? null}
          quantities={job.delivery_quantities ?? null}
          boardName={deliveredBoard?.name ?? null}
          driverName={deliveredDriver?.full_name ?? null}
        />

        {finished ? (
          <Notice tone="success" title="Nothing left to do">
            This job is {ORDER_STATUS_LABELS[job.status as OrderStatus]?.toLowerCase()}.
          </Notice>
        ) : !job.delivery_required ? (
          <Notice tone="info" title="The customer is collecting this one">
            It is handed over at the counter, so it never goes out on a run.
          </Notice>
        ) : canDeliver && deliverable ? (
          <Card title="At the door"
                description="Take a signature, a photo if it helps, and check the counts. The time, the round and the driver are recorded for you.">
            <DeliverButton
              orderId={job.id} orderNumber={job.order_number}
              customerName={job.customers?.business_name ?? "Unknown customer"}
              lines={deliverableLines(job)} returnTo={backTo} size="lg"
            />
          </Card>
        ) : canDeliver ? (
          <Notice tone="info">
            This job is not ready to be delivered yet.
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
