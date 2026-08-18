import Link from "next/link";
import { Card, Notice } from "@/components/ui";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { requireSession } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { checkAssignable, checkAssignmentRemovable } from "@/lib/domain/run-assignment";
import { formatAdelaideDate, getAdelaideToday } from "@/lib/domain/timezone";
import { driverById, listActiveDrivers } from "@/lib/runs/my-runs";
import { AssignForm } from "@/app/(app)/my-runs/assign-form";
import { removeJobAssignment } from "@/app/(app)/my-runs/actions";

/**
 * Assign Driver, on the job's own page.
 *
 * The assignment controls are only rendered for `routes.write` — the existing
 * plan-and-assign capability. Everyone else, drivers included, sees the
 * read-only half, because "who is bringing this and when" is a useful answer for
 * the counter to have when a customer rings even though changing it is not their
 * job. That is a display decision; the actions behind it carry their own guards.
 *
 * No run appears anywhere on this card. The `daily_routes` row underneath is
 * still created and maintained by the action, but naming it here would put the
 * user back in the mental model this change removed.
 */
export async function DispatchCard({
  order, canAssign, foreign = false,
}: {
  order: {
    id: string; order_number: string; status: string; tenant_id?: string;
    delivery_required: boolean; due_date: string | null;
    expected_delivery_date: string | null;
    assigned_driver_id: string | null;
    assigned_delivery_date: string | null;
  };
  canAssign: boolean;
  /**
   * True when this job belongs to a different laundry from the one the viewer
   * is working in — only reachable by a platform admin, whose session reads
   * every laundry (0019). Every write is filtered to the active laundry, so the
   * assignment controls could only ever fail here; the card says which business
   * it belongs to instead of offering a driver who works somewhere else.
   */
  foreign?: boolean;
}) {
  const session = await requireSession();
  const supabase = await createClient();

  // A customer pickup has no delivery story at all, so the card says the one
  // useful thing rather than offering a control the database would refuse.
  if (!order.delivery_required) {
    return (
      <Card title="Delivery" className="lg:col-span-3">
        <Notice tone="info">
          The customer is collecting this job, so it is never assigned to a delivery driver.
        </Notice>
      </Card>
    );
  }

  if (foreign) {
    return (
      <Card title="Delivery" className="lg:col-span-3">
        <Notice tone="warning" title="This job belongs to another laundry">
          You are working in a different business right now, so this job cannot be
          given a driver from here. Switch laundry in the account menu, then open
          the job again.
        </Notice>
      </Card>
    );
  }

  const [driver, drivers] = await Promise.all([
    order.assigned_driver_id
      ? driverById(supabase, session.tenantId, order.assigned_driver_id) : null,
    // This laundry's drivers, not every laundry's. A platform admin's session
    // reads across all of them (0019), and offering another laundry's driver is
    // how a run got crewed by somebody who works somewhere else.
    canAssign ? listActiveDrivers(supabase, session.tenantId) : Promise.resolve([]),
  ]);

  const eligible = checkAssignable(order, { allowAssigned: true });
  const removable = checkAssignmentRemovable(order);
  const returnTo = `/orders/${order.id}`;

  return (
    <Card
      title="Delivery"
      description="Which driver is taking this job out, and on which day."
      className="lg:col-span-3"
    >
      {order.assigned_driver_id ? (
        <div className="mb-4 rounded-lg bg-surface-sunken px-4 py-3">
          <p className="text-sm">
            Assigned to:{" "}
            <span className="font-semibold">{driver?.full_name ?? "a driver"}</span>
          </p>
          <p className="mt-0.5 text-sm">
            Assigned delivery date:{" "}
            <span className="font-semibold">
              {formatAdelaideDate(order.assigned_delivery_date, "medium")}
            </span>
          </p>
          {order.assigned_delivery_date && order.assigned_driver_id ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              <Link
                href={`/my-runs?date=${order.assigned_delivery_date}&driver=${order.assigned_driver_id}`}
                className="hover:underline"
              >
                See that driver&apos;s day
              </Link>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">
          This job has not been assigned to a driver.
        </p>
      )}

      {!canAssign ? (
        <p className="text-sm text-muted-foreground">
          Assigning work to a driver is done by dispatch.
        </p>
      ) : !eligible.ok ? (
        <Notice tone="info">{eligible.reason}</Notice>
      ) : (
        <div className="space-y-4">
          <AssignForm
            orderId={order.id}
            defaultDriverId={order.assigned_driver_id}
            defaultDate={getAdelaideToday()}
            expectedDeliveryDate={order.expected_delivery_date ?? order.due_date}
            drivers={drivers}
            returnTo={returnTo}
            currentAssignment={
              order.assigned_driver_id
                ? {
                    driverName: driver?.full_name ?? "a driver",
                    deliveryDate: order.assigned_delivery_date ?? "",
                  }
                : null
            }
          />

          {removable.ok ? (
            <form action={removeJobAssignment} className="border-t pt-4">
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="return_to" value={returnTo} />
              <ConfirmSubmit
                label="Remove Assignment"
                eyebrow="Take it off this driver"
                consequence={
                  "The job goes back to Ready for delivery and into the unassigned queue. "
                  + "It is not cancelled: the laundry, the customer, the instructions and the "
                  + "whole history stay exactly as they are."
                }
                pendingLabel="Removing…"
              />
            </form>
          ) : order.assigned_driver_id ? (
            <p className="border-t pt-4 text-sm text-muted-foreground">{removable.reason}</p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
