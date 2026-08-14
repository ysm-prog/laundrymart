import Link from "next/link";
import { MapPin, Phone } from "lucide-react";
import {
  Badge, ButtonLink, Card, StatusBadge, cx, humanise,
} from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { formatAdelaideDate, formatAdelaideDateTime } from "@/lib/domain/timezone";
import { ORDER_STATUS_LABELS, summariseItems, type OrderStatus } from "@/lib/domain/laundry-orders";
import { describeProgress } from "@/lib/domain/run-assignment";
import type { RunJob, RunStop } from "@/lib/runs/my-runs";
import { markJobDelivered, removeJobFromRun } from "./actions";

/**
 * The three things a driver actually reads: the day's totals, a stop, and the
 * laundry at it.
 *
 * Exported rather than kept private to `page.tsx` for one reason worth stating:
 * `/design-preview` renders them against fixtures. Every real screen in this app
 * is an async server component that reads Supabase, so none of them can be
 * *looked at* without a live project — which is how a doubled hairline and an
 * invisible dark-mode edge both survived a green `verify` once already. These
 * are the leaf components, they take plain props, and the gallery renders the
 * same ones the driver gets.
 */

export function Summary({
  driverName, date, runs, stops, jobs,
}: {
  driverName: string; date: string; runs: number;
  stops: { total: number; done: number }; jobs: { total: number; done: number };
}) {
  const figures = [
    { label: runs === 1 ? "Run" : "Runs", value: runs },
    { label: stops.total === 1 ? "Stop" : "Stops", value: stops.total },
    { label: jobs.total === 1 ? "Job" : "Jobs", value: jobs.total },
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

      {stops.total > 0 ? (
        <div className="mt-4">
          <ProgressBar done={stops.done} total={stops.total} />
          <p className="mt-1.5 text-sm text-muted-foreground">
            {describeProgress(stops, "stop")}
            {jobs.total > 0 ? ` · ${describeProgress(jobs, "job", "delivered")}` : null}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A subtle bar, not a chart. §34 asks for progress, and the number beside it is
 * the actual answer — the bar exists so the shape of the day is readable at a
 * glance, which is why it carries no percentage label of its own.
 */
function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
         role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}
         aria-label={`${done} of ${total} stops completed`}>
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ----------------------------------------------------------------- stops */

export function StopCard({
  stop, runStatus, returnTo, canDeliver, dispatches, showCapture,
}: {
  stop: RunStop; runStatus: string; returnTo: string;
  canDeliver: boolean; dispatches: boolean; showCapture: boolean;
}) {
  const done = stop.progress_status === "completed" || stop.status === "completed";
  const address = [
    stop.customer_locations?.address_line1,
    stop.customer_locations?.suburb,
    stop.customer_locations?.state,
    stop.customer_locations?.postcode,
  ].filter(Boolean).join(", ");

  const instructions = [
    stop.customer_locations?.access_notes,
    stop.customers?.special_instructions,
    stop.notes,
  ].filter(Boolean);

  return (
    <li className={cx(
      "rounded-xl border p-4",
      done ? "border-success/30 bg-success/5" : "bg-surface",
    )}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden
                className={cx(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                  done ? "bg-success text-on-status" : "bg-primary/10 text-primary",
                )}>
            {stop.sequence}
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold">
              <span className="sr-only">Stop {stop.sequence}: </span>
              {stop.customers?.business_name ?? "Unknown customer"}
            </p>
            {address ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{address}</p>
            ) : (
              <p className="mt-0.5 text-sm text-muted-foreground">No site address recorded</p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              {humanise(stop.service_type)}
              {stop.jobs.length > 0
                ? ` · ${stop.jobs.length} ${stop.jobs.length === 1 ? "job" : "jobs"}`
                : null}
              {stop.arrived_at ? ` · arrived ${formatAdelaideDateTime(stop.arrived_at)}` : null}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <StatusBadge status={stop.progress_status} />
          {stop.customers?.phone ? (
            <a href={`tel:${stop.customers.phone.replace(/\s+/g, "")}`}
               className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-strong
                          bg-surface px-3 text-sm font-medium shadow-xs transition
                          hover:bg-surface-muted">
              <Phone className="size-4" aria-hidden />
              {stop.customers.phone}
            </a>
          ) : null}
          {address ? (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-strong
                         bg-surface px-3 text-sm font-medium shadow-xs transition
                         hover:bg-surface-muted"
            >
              <MapPin className="size-4" aria-hidden />
              Navigate
            </a>
          ) : null}
          {showCapture ? (
            <ButtonLink href={`/run?stop=${stop.id}`} size="sm" variant="secondary">
              Record at the stop
            </ButtonLink>
          ) : (
            <ButtonLink href={`/jobs/${stop.id}`} size="sm" variant="secondary">
              View stop
            </ButtonLink>
          )}
        </div>
      </div>

      {instructions.length > 0 ? (
        <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
          <p className="text-sm font-medium">Delivery instructions</p>
          {instructions.map((line, index) => (
            <p key={index} className="mt-0.5 text-sm text-muted-foreground">{line}</p>
          ))}
        </div>
      ) : null}

      {stop.jobs.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {stop.jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              returnTo={returnTo}
              canDeliver={canDeliver}
              dispatches={dispatches}
              runStatus={runStatus}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ jobs */

function JobRow({
  job, returnTo, canDeliver, dispatches, runStatus,
}: {
  job: RunJob; returnTo: string; canDeliver: boolean; dispatches: boolean; runStatus: string;
}) {
  const finished = job.status === "completed" || job.status === "cancelled";
  // The run has to be moving before a delivery can be recorded against it —
  // the same rule `/run`'s capture card applies, for the same reason: a stop
  // completed before the van left is a record of something that did not happen.
  const rolling = ["in_progress", "returning", "unloading"].includes(runStatus);

  return (
    <li className="rounded-lg border bg-surface-muted/40 px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {/* The link is the way into the job, and it is pressed with a thumb
              in a van. `min-h-11` gives it the 44px target the rest of the app
              uses; the negative margin keeps the row as tight as it looks. */}
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Link
              href={`/my-runs/jobs/${job.id}`}
              className="-my-2 inline-flex min-h-11 items-center rounded-lg py-2 hover:underline
                         focus:outline-none focus:ring-2 focus:ring-primary/25"
            >
              {job.order_number}
            </Link>
            {job.priority === "urgent" ? <Badge tone="warning">Urgent</Badge> : null}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {summariseItems(job.laundry_order_items, 3)}
          </p>
          {job.delivery_window ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              Delivery: {humanise(job.delivery_window)}
              {job.expected_delivery_time ? ` at ${job.expected_delivery_time.slice(0, 5)}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <Badge tone={finished ? "success" : "info"}>
            {ORDER_STATUS_LABELS[job.status as OrderStatus] ?? humanise(job.status)}
          </Badge>

          {!finished && canDeliver && rolling ? (
            <form action={markJobDelivered}>
              <input type="hidden" name="order_id" value={job.id} />
              <input type="hidden" name="return_to" value={returnTo} />
              <SubmitButton size="lg" pendingLabel="Recording…">Mark delivered</SubmitButton>
            </form>
          ) : null}

          {!finished && dispatches ? (
            <form action={removeJobFromRun}>
              <input type="hidden" name="order_id" value={job.id} />
              <input type="hidden" name="return_to" value={returnTo} />
              <SubmitButton size="md" variant="secondary" pendingLabel="Removing…">Remove</SubmitButton>
            </form>
          ) : null}
        </div>
      </div>

      {job.delivery_instructions ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Note: {job.delivery_instructions}
        </p>
      ) : null}
    </li>
  );
}

