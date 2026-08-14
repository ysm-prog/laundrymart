import Link from "next/link";
import { Card, Notice } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { createClient } from "@/lib/supabase/server";
import { checkAssignable } from "@/lib/domain/run-assignment";
import { formatAdelaideDate, getAdelaideToday } from "@/lib/domain/timezone";
import { listActiveDrivers } from "@/lib/runs/my-runs";
import { AssignForm } from "@/app/(app)/my-runs/assign-form";
import { removeJobFromRun } from "@/app/(app)/my-runs/actions";

/**
 * "Assign to run" on the job's own page (§23).
 *
 * Only rendered for `routes.write` — the existing plan-and-assign capability.
 * Everyone else sees the read-only half, because "who is bringing this and
 * when" is a useful answer for the counter to have when a customer rings, even
 * though changing it is not their job.
 */
export async function DispatchCard({
  order, canAssign,
}: {
  order: {
    id: string; order_number: string; status: string;
    delivery_required: boolean; stop_id: string | null; due_date: string | null;
  };
  canAssign: boolean;
}) {
  const supabase = await createClient();
  const assignment = order.stop_id ? await loadAssignment(supabase, order.stop_id) : null;

  // A customer pickup has no dispatch story at all, so the card says the one
  // useful thing rather than offering a control the database would refuse.
  if (!order.delivery_required) {
    return (
      <Card title="Delivery run" className="lg:col-span-3">
        <Notice tone="info">
          The customer is collecting this job, so it never goes on a delivery run.
        </Notice>
      </Card>
    );
  }

  const eligible = checkAssignable(order, { allowAssigned: true });
  const drivers = canAssign ? await listActiveDrivers(supabase) : [];
  const returnTo = `/orders/${order.id}`;

  return (
    <Card
      title="Delivery run"
      description="Which driver is taking this job out, and on which day."
      className="lg:col-span-3"
    >
      {assignment ? (
        <div className="mb-4 rounded-lg bg-surface-sunken px-4 py-3">
          <p className="text-sm">
            On{" "}
            <Link href={`/routes/daily/${assignment.runId}`} className="font-medium hover:underline">
              {assignment.runCode} · {assignment.runName}
            </Link>{" "}
            with{" "}
            <span className="font-medium">{assignment.driverName}</span>, due out{" "}
            {formatAdelaideDate(assignment.runDate, "long")}.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Stop {assignment.sequence} · {assignment.stopNumber}
            {assignment.driverId ? (
              <>
                {" · "}
                <Link
                  href={`/my-runs?date=${assignment.runDate}&driver=${assignment.driverId}`}
                  className="hover:underline"
                >
                  See the whole run
                </Link>
              </>
            ) : null}
          </p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted-foreground">
          This job is not on a run.
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
            defaultDriverId={assignment?.driverId ?? null}
            defaultDriverName={assignment?.driverName ?? null}
            defaultDate={getAdelaideToday()}
            dueDate={order.due_date}
            drivers={drivers}
            returnTo={returnTo}
            currentAssignment={
              assignment
                ? {
                    driverName: assignment.driverName,
                    runCode: assignment.runCode,
                    runDate: assignment.runDate,
                  }
                : null
            }
          />

          {assignment ? (
            <form action={removeJobFromRun} className="border-t pt-4">
              <input type="hidden" name="order_id" value={order.id} />
              <input type="hidden" name="return_to" value={returnTo} />
              <p className="mb-2 text-sm text-muted-foreground">
                Taking it off the run changes nothing else — the job keeps its status,
                its laundry and its history.
              </p>
              <SubmitButton variant="secondary" size="md" pendingLabel="Removing…">
                Remove from run
              </SubmitButton>
            </form>
          ) : null}
        </div>
      )}
    </Card>
  );
}

async function loadAssignment(
  supabase: Awaited<ReturnType<typeof createClient>>, stopId: string,
) {
  const { data } = await supabase
    .from("jobs")
    .select(
      "id, job_number, sequence, " +
      "daily_routes(id, code, name, route_date, driver_id, drivers(id, full_name))",
    )
    .eq("id", stopId)
    .maybeSingle<{
      id: string; job_number: string; sequence: number;
      daily_routes: {
        id: string; code: string; name: string; route_date: string; driver_id: string | null;
        drivers: { id: string; full_name: string } | null;
      } | null;
    }>();

  const run = data?.daily_routes;
  if (!data || !run) return null;
  return {
    stopNumber: data.job_number,
    sequence: data.sequence,
    runId: run.id,
    runCode: run.code,
    runName: run.name,
    runDate: run.route_date,
    driverId: run.driver_id,
    driverName: run.drivers?.full_name ?? "no driver yet",
  };
}
