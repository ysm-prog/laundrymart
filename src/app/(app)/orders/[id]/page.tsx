import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { date as formatDate, dateTime, time as formatTime } from "@/lib/format";
import {
  defaultStaffId, listMembers, memberNames, staffMembers, withCurrentHolder,
} from "@/lib/directory";
import {
  DELIVERY_WINDOW_LABELS, PRIORITY_LABELS, RECEIVED_VIA_LABELS,
  actionsFor, buildStatusTrack, describeItem, isOrderStatus, isOverdue,
  type DeliveryWindow, type OrderPriority, type ReceivedVia,
} from "@/lib/domain/laundry-orders";
import { businessToday } from "@/lib/domain/timezone";
import { isBillingStatus } from "@/lib/domain/billing";
import type { LaundryOrder, LaundryOrderActivity, LaundryOrderItem } from "@/lib/db/types";
import {
  Badge, ButtonLink, Card, DataTable, EmptyState, Eyebrow,
  Notice, PageHeader, SkeletonRows, StatusBadge, humanise,
} from "@/components/ui";
import { Select, SubmitButton } from "@/components/form";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { CompleteJob } from "../complete-job";
import { ChargesCard } from "./charges-card";
import { DispatchCard } from "./dispatch-card";
import { StatusTrack } from "./status-track";
import { advanceOrder, assignOrder, cancelOrder, completeOrder } from "../actions";

export const dynamic = "force-dynamic";

type Detail = LaundryOrder & {
  customers: {
    id: string; customer_number: string; business_name: string; trading_name: string | null;
    phone: string | null; billing_email: string | null;
    billing_address_line1: string | null; billing_suburb: string | null;
    billing_state: string | null; billing_postcode: string | null;
  } | null;
  drivers: { full_name: string } | null;
  assigned_board: { id: string; name: string } | null;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("laundry_orders").select("order_number").eq("id", id)
    .maybeSingle<{ order_number: string }>();
  return { title: data ? `Job ${data.order_number}` : "Job" };
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireCapability("orders.read");
  const supabase = await createClient();

  const { data: order } = await supabase
    .from("laundry_orders")
    .select(
      "*, customers(id, customer_number, business_name, trading_name, phone, billing_email, " +
      "billing_address_line1, billing_suburb, billing_state, billing_postcode), " +
      // Disambiguated by constraint name: since 0016 `laundry_orders` has two
      // foreign keys to `drivers` (who collected it, and a historical delivery
      // assignment), so a bare `drivers(...)` embed is rejected by PostgREST at
      // request time. The board embed is named by the same habit.
      "drivers!laundry_orders_pickup_driver_id_fkey(full_name), " +
      "assigned_board:boards!laundry_orders_assigned_board_id_fkey(id, name)",
    )
    .eq("id", id)
    .maybeSingle<Detail>();

  if (!order || !isOrderStatus(order.status)) notFound();

  // **Whose job this is.** A platform admin's session reads every laundry
  // (0019) while every write is filtered to the one they are working in, so a
  // job from another business opens here and then refuses every action — which
  // used to surface as "somebody else changed this job's board". The page
  // stays readable, because looking is exactly what that role is for; what
  // changes is that it now says so.
  const foreign = order.tenant_id !== session.tenantId;

  const [items, activity, members] = await Promise.all([
    supabase.from("laundry_order_items")
      .select("id, order_id, item_id, item_type, custom_description, quantity_type, exact_quantity, bag_count, estimated_quantity, notes")
      .eq("order_id", id).order("created_at")
      .returns<LaundryOrderItem[]>(),
    supabase.from("laundry_order_activity")
      .select("id, order_id, actor_id, activity_type, previous_value, new_value, note, created_at")
      .eq("order_id", id).order("created_at", { ascending: false }).limit(100)
      .returns<LaundryOrderActivity[]>(),
    listMembers(),
  ]);

  // Two lists, on purpose. `names` covers every member, because a record has
  // to say who created it even when that person is not somebody you can
  // hand work to; `staff` is who this laundry can pick from, which excludes
  // platform administrators (they administer the deployment, not this
  // business).
  const names = memberNames(members);
  const staff = staffMembers(members);
  // An unrecognised value reads as `pending`, never as something further along:
  // a billing state nobody knows must not render as "approved".
  const storedBillingStatus = order.billing_status ?? "";
  const billingStatus = isBillingStatus(storedBillingStatus) ? storedBillingStatus : "pending";
  const today = businessToday();
  const late = isOverdue(order, today);
  const delivery = order.delivery_required;
  const customer = order.customers;

  // What this job's state allows, narrowed to what this person may do. Both
  // halves are re-checked in the action — a hidden button is a courtesy.
  //
  // Only the actions that open a form: finishing a job records who handed it
  // over and when, and cancelling one carries a reason. The plain status moves
  // are steps on the track, so a button for each of them here would be the same
  // choice offered twice — and with free movement there can be four at once.
  const available = foreign ? [] : actionsFor(order.status, delivery)
    .filter((action) => action.confirms && can(session.role, action.capability));

  // The track. `foreign` stops it rather than a capability check, because the
  // problem is which laundry this job belongs to and not what this person may
  // do — and every write here filters `tenant_id`, so a step offered on somebody
  // else's job would match no row and report success. (Before the track, the
  // status buttons did exactly that.)
  const track = buildStatusTrack(
    { status: order.status, deliveryRequired: delivery },
    (capability) => can(session.role, capability),
    foreign
      ? "This job belongs to another laundry — switch laundry in the account menu to move it."
      : undefined,
  );
  const canJump = track.some((step) => step.jump);

  const customerAddress = [
    customer?.billing_address_line1, customer?.billing_suburb,
    customer?.billing_state, customer?.billing_postcode,
  ].filter(Boolean).join(", ");

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Job"
        title={`${order.order_number} · ${customer?.business_name ?? "Unknown customer"}`}
        description={`${delivery ? "We deliver" : "Customer pickup"} · received ${dateTime(order.received_at)}`}
        actions={
          <>
            <StatusBadge status={order.status} />
            {order.priority === "urgent" ? <Badge tone="warning">Urgent</Badge> : null}
            {late ? <Badge tone="danger">Overdue</Badge> : null}
            {can(session.role, "orders.write") && order.status !== "cancelled"
              ? <ButtonLink href={`/orders/${order.id}/edit`}>Edit job</ButtonLink>
              : null}
          </>
        }
      />

      {order.status === "cancelled" ? (
        <Notice tone="danger" title="This job was cancelled">
          {order.cancellation_reason
            ? `Reason: ${order.cancellation_reason}`
            : "No reason was recorded."}
          {" "}Nothing was deleted — the laundry list and the history below are intact.
        </Notice>
      ) : null}

      {late ? (
        <Notice tone="warning" title="Past its date">
          This job was due {formatDate(order.due_date)} and is not finished. Overdue is
          worked out from today&apos;s date — it is not a status anyone set.
        </Notice>
      ) : null}

      {order.special_instructions ? (
        <Notice tone="info" title="Washing instructions">{order.special_instructions}</Notice>
      ) : null}

      {/* --------------------------------------------------------- actions --- */}
      {/* The job's stages, and the way to move between them. Adopted from
          `ysm-prog/ysm-hub`'s job detail — see `status-track.tsx`. It replaced
          a row of buttons offering exactly one step at a time, which is why
          this card is no longer called "What happens next": the answer to that
          question is now drawn rather than listed, and the next step is not the
          only thing on offer. */}
      <Card title="Where this job is up to">
        <StatusTrack steps={track} orderId={order.id} action={advanceOrder} />

        {available.length > 0 || canJump ? (
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
            {available.map((action) => {
              if (action.key === "cancel") {
                return (
                  <form key={action.key} action={cancelOrder} className="contents">
                    <input type="hidden" name="id" value={order.id} />
                    <ConfirmSubmit
                      label="Cancel job"
                      eyebrow="Are you sure?"
                      consequence="Are you sure you want to cancel this job? It stops appearing in the day's work. Nothing is deleted — the job, its laundry list and its history all stay."
                      reasonName="cancellation_reason"
                      reasonLabel="Reason"
                      reasonRequired={false}
                      pendingLabel="Cancelling…"
                    />
                  </form>
                );
              }
              return (
                <CompleteJob
                  key={action.key}
                  action={completeOrder}
                  orderId={order.id}
                  delivered={delivery}
                  staff={staff}
                  defaultStaffId={defaultStaffId(staff, order.assigned_to, session.userId)}
                />
              );
            })}
            {canJump ? (
              /* YSM Hub says the same thing beside its own track, and it is the
                 half people do not discover: the track goes backwards. Without
                 the sentence a stage already passed just looks like history. */
              <p className="text-xs text-muted-foreground">
                Press any stage above to move this job there — including back, if it was
                moved on by mistake.
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Only when there is genuinely nothing to do, and never for a cancelled
          job — the danger banner at the top of the page has already said that,
          and saying it twice reads as two different facts. */}
      {available.length === 0 && !canJump && order.status !== "cancelled" ? (
        <Notice tone="info">
          {foreign
            ? "This job belongs to another laundry. Switch laundry in the account menu to work on it."
            : order.status === "completed"
              ? "This job is finished. Nothing further to do."
              : "Your role cannot move this job to another stage."}
        </Notice>
      ) : null}

      {/* ------------------------------------------------------- charges --- */}
      {/* The money, for the roles that hold money capabilities. Above the
          operational cards because for a reviewer arriving from the invoice
          queue this is the only thing on the page they came for; below the
          workflow banner because the operational state is what decides whether
          it can be approved at all. RLS makes this empty for anyone else, so
          the capability check is the courtesy rather than the boundary. */}
      {can(session.role, "billing.read") ? (
        <Suspense fallback={<SkeletonRows rows={3} />}>
          <ChargesCard
            orderId={order.id}
            tenantId={session.tenantId}
            billingStatus={billingStatus}
            operationalStatus={order.status}
            customerId={order.customer_id}
            role={session.role}
            approvedAt={order.billing_approved_at ?? null}
          />
        </Suspense>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ------------------------------------------------------ delivery --- */}
        {/* Which board is taking it, and on what day. `routes.write` is the
            existing plan-and-assign capability — no new one is introduced. */}
        <DispatchCard order={order} canAssign={can(session.role, "routes.write") && !foreign}
                      foreign={foreign} />

        {/* ------------------------------------------------------ customer --- */}
        <Card
          title="Customer"
          className="lg:col-span-1"
          actions={customer
            ? <ButtonLink href={`/customers/${customer.id}`}>View customer</ButtonLink>
            : null}
        >
          <dl className="space-y-2 text-sm">
            <Row label="Business" value={customer?.business_name} />
            <Row label="Trading as" value={customer?.trading_name} />
            <Row label="Customer no." value={customer?.customer_number} />
            <Row label="Phone" value={customer?.phone} />
            <Row label="Email" value={customer?.billing_email} />
            <Row label="Address" value={customerAddress} />
            <Row label="Delivery address"
                 value={delivery ? order.delivery_address : "Customer pickup"} />
          </dl>
        </Card>

        {/* --------------------------------------------------------- dates --- */}
        <Card title="Important dates" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="Received" value={dateTime(order.received_at)} />
            <Row label="Received via"
                 value={RECEIVED_VIA_LABELS[order.received_via as ReceivedVia] ?? humanise(order.received_via)} />
            {order.received_via === "driver_pickup" ? (
              <>
                <Row label="Collected on" value={order.pickup_date ? formatDate(order.pickup_date) : null} />
                {/* No pickup time. It is out of the workflow, and showing a
                    legacy value here would be the one place a normal user still
                    met a field the forms no longer have. */}
                <Row label="Collected by" value={order.drivers?.full_name} />
              </>
            ) : null}
            {delivery ? (
              <>
                <Row label="Expected delivery"
                     value={order.expected_delivery_date ? formatDate(order.expected_delivery_date) : null} />
                <Row label="Delivery window"
                     value={order.delivery_window
                       ? DELIVERY_WINDOW_LABELS[order.delivery_window as DeliveryWindow]
                       : null} />
                <Row label="Delivery time"
                     value={order.expected_delivery_time ? formatTime(order.expected_delivery_time) : null} />
                {/* The two dates the brief is careful to keep apart: what the
                    customer was promised, and the day it is scheduled to a
                    round. Usually the same; shown separately so that when they
                    differ, somebody notices. */}
                <Row label="Assigned to"
                     value={order.assigned_board?.name ?? "Not assigned"} />
                <Row label="Assigned delivery date"
                     value={order.assigned_delivery_date
                       ? formatDate(order.assigned_delivery_date) : null} />
                <Row label="Actually delivered" value={dateTime(order.delivered_at)} />
              </>
            ) : (
              <>
                <Row label="Expected collection"
                     value={order.expected_collection_date ? formatDate(order.expected_collection_date) : null} />
                <Row label="Actually collected" value={dateTime(order.collected_at)} />
              </>
            )}
            <Row label="Completed" value={dateTime(order.completed_at)} />
            {order.cancelled_at ? <Row label="Cancelled" value={dateTime(order.cancelled_at)} /> : null}
          </dl>
        </Card>

        {/* ---------------------------------------------------- assignment --- */}
        <Card title="Who is on it" className="lg:col-span-1">
          <dl className="space-y-2 text-sm">
            <Row label="Priority"
                 value={PRIORITY_LABELS[order.priority as OrderPriority] ?? humanise(order.priority)} />
            <Row label="Assigned to"
                 value={order.assigned_to ? names.get(order.assigned_to) : "Nobody yet"} />
            <Row label="Created by" value={order.created_by ? names.get(order.created_by) : null} />
            <Row label="Created" value={dateTime(order.created_at)} />
            <Row label="Last updated" value={dateTime(order.updated_at)} />
            {delivery && order.delivered_by
              ? <Row label="Delivered by" value={names.get(order.delivered_by)} /> : null}
            {!delivery && order.collected_by
              ? <Row label="Handed over by" value={names.get(order.collected_by)} /> : null}
          </dl>

          {can(session.role, "orders.write") && order.status !== "cancelled" ? (
            <form action={assignOrder} className="mt-3 space-y-2 border-t pt-3">
              <input type="hidden" name="id" value={order.id} />
              <Eyebrow>Reassign</Eyebrow>
              <Select name="assigned_to" placeholder="Nobody" defaultValue={order.assigned_to}
                      options={withCurrentHolder(staff, members, order.assigned_to)
                        .map((member) => ({
                          value: member.id, label: `${member.label} · ${member.role}`,
                        }))} />
              <SubmitButton variant="secondary" pendingLabel="Saving…">Save</SubmitButton>
            </form>
          ) : null}
        </Card>
      </div>

      {/* ---------------------------------------------------------- laundry --- */}
      <Card title="Laundry" description="What the customer brought in.">
        <DataTable
          label="Laundry items"
          rows={items.data ?? []}
          empty={<EmptyState title="No items recorded" description="Every job should have at least one." />}
          columns={[
            { header: "Item", cell: (row) => describeItem(row) },
            {
              header: "How counted",
              cell: (row) => (row.quantity_type === "exact" ? "Counted" : "Bulk lot"),
              hideBelow: "sm",
            },
            {
              header: "Bags",
              cell: (row) => (row.bag_count == null ? "—" : String(row.bag_count)),
              hideBelow: "md",
              align: "right",
            },
            {
              header: "Rough count",
              cell: (row) => (row.estimated_quantity == null ? "—" : String(row.estimated_quantity)),
              hideBelow: "md",
              align: "right",
            },
            { header: "Notes", cell: (row) => row.notes ?? "—" },
          ]}
        />
      </Card>

      {/* --------------------------------------------------------- delivery --- */}
      <Card title={delivery ? "Delivery" : "Customer pickup"}>
        {delivery ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row label="Address" value={order.delivery_address} />
            <Row label="Address source"
                 value={order.delivery_address_source === "custom"
                   ? "One-off address for this job"
                   : "Copied from the customer"} />
            <Row label="Instructions" value={order.delivery_instructions} />
            <Row label="Expected"
                 value={order.expected_delivery_date ? formatDate(order.expected_delivery_date) : null} />
            <Row label="Delivered" value={dateTime(order.delivered_at)} />
            <Row label="Delivered by"
                 value={order.delivered_by ? names.get(order.delivered_by) : null} />
          </dl>
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <Row label="How it goes back" value="The customer collects it from the counter" />
            <Row label="Expected collection"
                 value={order.expected_collection_date ? formatDate(order.expected_collection_date) : null} />
            <Row label="Collected" value={dateTime(order.collected_at)} />
            <Row label="Handed over by"
                 value={order.collected_by ? names.get(order.collected_by) : null} />
          </dl>
        )}
      </Card>

      {/* --------------------------------------------------------- timeline --- */}
      <Card title="Activity" description="Everything that has happened to this job, newest first.">
        {(activity.data ?? []).length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <ol className="divide-y">
            {(activity.data ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:gap-4">
                <div className="sm:w-48 sm:shrink-0">
                  <span className="text-2xs text-muted-foreground">
                    {dateTime(entry.created_at)}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className="font-medium">
                      {entry.actor_id ? names.get(entry.actor_id) ?? "Someone" : "The system"}
                    </span>
                    {" "}{describeActivity(entry)}
                  </p>
                  {entry.note ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">“{entry.note}”</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{value || "—"}</dd>
    </div>
  );
}

/**
 * One timeline row, in a sentence. The stored jsonb carries whatever the change
 * touched; this reads the fields it knows and falls back to the activity type
 * rather than printing raw values at anybody.
 */
function describeActivity(entry: LaundryOrderActivity): string {
  const previous = entry.previous_value ?? {};
  const next = entry.new_value ?? {};

  switch (entry.activity_type) {
    case "created": {
      const count = typeof next.items === "number" ? next.items : null;
      return `took this job in${count === null ? "" : ` with ${count} laundry ${count === 1 ? "item" : "items"}`}.`;
    }
    case "status_changed":
      return `moved it from ${humanise(String(previous.status ?? "")).toLowerCase()} `
        + `to ${humanise(String(next.status ?? "")).toLowerCase()}.`;
    case "delivered":
      return "marked it delivered and completed the job.";
    case "collected":
      return "handed it back to the customer and completed the job.";
    case "cancelled":
      return "cancelled this job.";
    case "assigned":
      return next.assigned_to ? "assigned this job to someone." : "took the assignment off this job.";
    case "items_changed":
      return "changed the laundry list.";
    case "updated":
      return "edited this job.";
    default:
      return humanise(entry.activity_type).toLowerCase();
  }
}
