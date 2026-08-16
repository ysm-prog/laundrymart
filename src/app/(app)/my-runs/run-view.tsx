import Link from "next/link";
import { MapPin, Phone } from "lucide-react";
import { Badge, ButtonLink, Card, cx, humanise } from "@/components/ui";
import { formatAdelaideDate, formatAdelaideTime } from "@/lib/domain/timezone";
import { ORDER_STATUS_LABELS, summariseItems, type OrderStatus } from "@/lib/domain/laundry-orders";
import type { DayJob } from "@/lib/runs/my-runs";

/**
 * What a driver reads: the day's totals, and one card per job.
 *
 * There is no run card, no stop card and no sequence number here any more. A
 * driver's day is a list of deliveries — the run underneath is bookkeeping and
 * naming it on screen only ever made the driver responsible for understanding
 * it. What is left is the four things they need at a glance: who, where, what,
 * and whether it is done.
 *
 * Exported rather than kept private to `page.tsx` for one reason worth stating:
 * `/design-preview` renders these against fixtures. Every real screen in this
 * app is an async server component reading Supabase, so none of them can be
 * *looked at* without a live project — which is how a doubled hairline and an
 * invisible dark-mode edge both survived a green `verify` once already. These
 * are the leaf components, they take plain props, and the gallery renders the
 * same ones the driver gets.
 */

/* ---------------------------------------------------------------- summary */

export function DaySummary({
  driverName, date, toDeliver, outForDelivery, completed,
}: {
  driverName: string; date: string;
  toDeliver: number; outForDelivery: number; completed: number;
}) {
  const total = toDeliver + outForDelivery + completed;
  const done = completed;

  const figures = [
    { label: "To deliver", value: toDeliver },
    { label: "Out", value: outForDelivery },
    { label: "Completed", value: completed },
  ];

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-lg font-semibold">{driverName}</p>
          <p className="text-sm text-muted-foreground">{formatAdelaideDate(date, "long")}</p>
        </div>
        <div className="flex gap-6">
          {figures.map((figure) => (
            <div key={figure.label}>
              <p className="text-2xl font-semibold tabular-nums leading-none">{figure.value}</p>
              <p className="mt-1 text-sm text-muted-foreground">{figure.label}</p>
            </div>
          ))}
        </div>
      </div>

      {total > 0 ? (
        <div className="mt-4">
          <ProgressBar done={done} total={total} />
          <p className="mt-1.5 text-sm text-muted-foreground">
            {done} of {total} {total === 1 ? "job" : "jobs"} delivered
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A subtle bar, not a chart. The number beside it is the actual answer — the bar
 * exists so the shape of the day is readable at a glance, which is why it
 * carries no percentage label of its own.
 */
function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
         role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}
         aria-label={`${done} of ${total} jobs delivered`}>
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------- job cards */

/**
 * One delivery, as a card.
 *
 * Cards rather than a table at every width, not just on a phone: a driver's list
 * is never wide, and the address — the thing they are actually navigating by —
 * has to be the second most prominent line on it. The address and the phone are
 * real links, so a tap opens maps or dials rather than selecting text.
 */
export function JobCard({
  job, actionable,
}: {
  job: DayJob;
  /** The driver may open and work this job, rather than merely view it. */
  actionable: boolean;
}) {
  const finished = job.status === "completed";
  const address = job.delivery_address;
  const detailHref = `/my-runs/jobs/${job.id}?date=${job.assigned_delivery_date ?? ""}`;

  return (
    <li className={cx(
      "rounded-xl border p-4",
      finished ? "border-success/30 bg-success/5" : "bg-surface",
    )}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold">{job.order_number}</span>
            {job.priority === "urgent" ? <Badge tone="warning">Urgent</Badge> : null}
          </p>
          <p className="mt-0.5 text-base font-semibold">
            {job.customers?.business_name ?? "Unknown customer"}
          </p>

          {/* The address leads, because it is what the next ten minutes are
              about. Whole-address tap target, not an icon beside it. */}
          {address ? (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex min-h-11 items-start gap-1.5 rounded-lg py-1 pr-2
                         text-sm font-medium text-primary hover:underline
                         focus:outline-none focus:ring-2 focus:ring-primary/25"
            >
              <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0">{address}</span>
            </a>
          ) : (
            <p className="mt-1.5 text-sm text-muted-foreground">No delivery address recorded</p>
          )}

          <p className="mt-1 text-sm text-muted-foreground">
            {summariseItems(job.laundry_order_items, 3)}
          </p>

          <p className="mt-0.5 text-sm text-muted-foreground">
            {job.expected_delivery_date
              ? `Expected: ${formatAdelaideDate(job.expected_delivery_date, "short")}`
              : "No expected delivery date"}
            {job.assigned_delivery_date
              && job.assigned_delivery_date !== job.expected_delivery_date
              ? ` · Assigned: ${formatAdelaideDate(job.assigned_delivery_date, "short")}`
              : ""}
            {job.delivery_window && job.delivery_window !== "no_specific_time"
              ? ` · ${humanise(job.delivery_window)}`
                + (job.expected_delivery_time ? ` at ${job.expected_delivery_time.slice(0, 5)}` : "")
              : ""}
          </p>

          {finished && job.completed_at ? (
            <p className="mt-0.5 text-sm font-medium text-success">
              Completed {formatAdelaideTime(job.completed_at)}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <Badge tone={finished ? "success" : job.status === "out_for_delivery" ? "info" : "neutral"}>
            {ORDER_STATUS_LABELS[job.status as OrderStatus] ?? humanise(job.status)}
          </Badge>
          {job.customers?.phone ? (
            <a href={`tel:${job.customers.phone.replace(/\s+/g, "")}`}
               className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-strong
                          bg-surface px-3 text-sm font-medium shadow-xs transition
                          hover:bg-surface-muted">
              <Phone className="size-4" aria-hidden />
              <span className="sr-only">Call </span>{job.customers.phone}
            </a>
          ) : null}
          <ButtonLink href={detailHref} size="md" variant={finished ? "secondary" : "primary"}>
            {actionable && !finished ? "Open Job" : "View Job"}
          </ButtonLink>
        </div>
      </div>

      {job.delivery_instructions ? (
        <p className="mt-2.5 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-muted-foreground">
          {job.delivery_instructions}
        </p>
      ) : null}
    </li>
  );
}

/** A named group of job cards — To deliver, Out for delivery, Completed. */
export function JobGroup({
  title, count, children,
}: {
  title: string; count: number; children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">
        {title} <span className="font-normal text-muted-foreground">({count})</span>
      </h2>
      <ul className="space-y-3">{children}</ul>
    </section>
  );
}

/** The office's read-only view of who has a job, used on the Jobs screens. */
export function AssignmentSummary({
  driverName, deliveryDate,
}: {
  driverName: string; deliveryDate: string | null;
}) {
  return (
    <div className="rounded-lg bg-surface-sunken px-4 py-3">
      <p className="text-sm">
        Assigned to: <span className="font-semibold">{driverName}</span>
      </p>
      <p className="mt-0.5 text-sm">
        Assigned delivery date:{" "}
        <span className="font-semibold">{formatAdelaideDate(deliveryDate, "medium")}</span>
      </p>
    </div>
  );
}

/** A plain link back into a job, for lists that are not the driver's own day. */
export function JobLink({ id, label }: { id: string; label: string }) {
  return <Link href={`/orders/${id}`} className="hover:underline">{label}</Link>;
}
