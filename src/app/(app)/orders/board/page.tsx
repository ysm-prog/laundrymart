import { requireCapability } from "@/lib/auth/context";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import {
  addDays, formatAdelaideDate, getAdelaideDayRange, getAdelaideToday, toZonedDate,
} from "@/lib/domain/timezone";
import { boardBillingLabel, boardColumn } from "@/lib/domain/laundry-board";
import { ButtonLink, CONTROL, Card, Notice, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { BoardView, type BoardCard } from "./board-view";
import { markSelectedReady, scanDocket } from "./actions";
import { reassignJobsToBoard } from "../../runs/actions";
import { approveSelectedJobs } from "../../invoices/bulk-actions";

export const metadata = { title: "Laundry board" };
export const dynamic = "force-dynamic";

/** Finished jobs stay on the board this long; older ones are on All jobs. */
const FINISHED_DAYS = 14;
const LIMIT = 600;

type Row = {
  id: string; order_number: string; status: string; billing_status: string;
  billing_hold_reason: string | null; delivery_required: boolean;
  expected_delivery_date: string | null; due_date: string | null;
  assigned_board_id: string | null; assigned_delivery_date: string | null;
  completed_at: string | null;
  customers: { business_name: string } | null;
  board: { name: string } | null;
  job_charge_snapshots: Array<{ count: number }> | null;
};

/**
 * The Laundry board (brief 3.3): every live job in five columns, a selection
 * with three bulk actions, and a docket scan that marks a job Ready.
 *
 * Two reads, both naming the tenant (§23 — the bulk actions post these ids
 * back into writes scoped to this laundry): the live jobs, and finished ones
 * from the last fortnight so Delivered and Billed show the recent work rather
 * than the whole history. The charge count rides along so Approve is only
 * offered on a job that has charges; for a role that cannot read prices RLS
 * returns none, which is right — that role cannot approve either.
 */
export default async function LaundryBoardPage() {
  const session = await requireCapability("orders.read");
  const supabase = await createClient();
  const today = getAdelaideToday();
  const since = addDays(today, -FINISHED_DAYS);

  const columns =
    "id, order_number, status, billing_status, billing_hold_reason, delivery_required, " +
    "expected_delivery_date, due_date, assigned_board_id, assigned_delivery_date, completed_at, " +
    "customers(business_name), board:boards!laundry_orders_assigned_board_id_fkey(name), " +
    "job_charge_snapshots(count)";

  const [live, finished, boards] = await Promise.all([
    supabase.from("laundry_orders").select(columns)
      .eq("tenant_id", session.tenantId)
      .in("status", ["new", "in_progress", "ready_for_delivery", "assigned", "out_for_delivery"])
      .order("due_date", { ascending: true, nullsFirst: false }).limit(LIMIT)
      .returns<Row[]>(),
    supabase.from("laundry_orders").select(columns)
      .eq("tenant_id", session.tenantId).eq("status", "completed")
      .gte("completed_at", getAdelaideDayRange(since).start)
      .order("completed_at", { ascending: false }).limit(LIMIT)
      .returns<Row[]>(),
    supabase.from("boards").select("id, name")
      .eq("tenant_id", session.tenantId).eq("status", "active").is("deleted_at", null)
      .order("name").returns<Array<{ id: string; name: string }>>(),
  ]);

  const failed = live.error || finished.error;
  const cards: BoardCard[] = [...(live.data ?? []), ...(finished.data ?? [])].flatMap((row) => {
    const column = boardColumn(row);
    if (!column) return [];
    return [{
      id: row.id,
      orderNumber: row.order_number,
      customer: row.customers?.business_name ?? "Unknown customer",
      column,
      status: row.status,
      billingStatus: row.billing_status,
      deliveryRequired: row.delivery_required,
      assignedBoardId: row.assigned_board_id,
      chargeCount: row.job_charge_snapshots?.[0]?.count ?? 0,
      detail: detailFor(row),
      billing: boardBillingLabel(row),
      overdue: Boolean(row.due_date && row.due_date < today
        && row.status !== "completed"),
    }];
  });

  const may = {
    markReady: can(session.role, "orders.status"),
    assign: can(session.role, "routes.write"),
    approve: can(session.role, "invoices.approve") && can(session.role, "invoices.bulk"),
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Laundry board"
        description="Every job, in the column it is up to. Tick jobs to move them together."
        actions={
          <>
            <ButtonLink href="/orders" variant="secondary">All jobs</ButtonLink>
            {can(session.role, "orders.write")
              ? <ButtonLink href="/orders/new" variant="primary">Take in laundry</ButtonLink> : null}
          </>
        }
      />

      {may.markReady ? (
        <Card>
          {/* The scanner types the number and presses Enter; autofocus so a
              docket can be scanned the moment the board opens. */}
          <form action={scanDocket} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <label htmlFor="docket" className="mb-1.5 block text-sm font-medium">Scan a docket</label>
              <input id="docket" name="docket" autoFocus autoComplete="off" spellCheck={false}
                     placeholder="LJ00032" className={CONTROL} />
            </div>
            <SubmitButton size="md" pendingLabel="Marking…">Mark ready</SubmitButton>
            <p className="w-full text-xs text-muted-foreground">
              Scan the barcode on a job&rsquo;s docket, or type its number. It is marked ready and,
              if the customer has a round, put on it.
            </p>
          </form>
        </Card>
      ) : null}

      {failed ? (
        <Notice tone="danger" title="The board could not be loaded">
          Try again in a moment.
        </Notice>
      ) : (
        <BoardView
          cards={cards}
          boards={boards.data ?? []}
          today={today}
          returnTo="/orders/board"
          may={may}
          actions={{ markReady: markSelectedReady, assign: reassignJobsToBoard, approve: approveSelectedJobs }}
        />
      )}
    </div>
  );
}

function detailFor(row: Row): string {
  if (row.status === "assigned" || row.status === "out_for_delivery") {
    const day = row.assigned_delivery_date ? formatAdelaideDate(row.assigned_delivery_date, "medium") : null;
    return [row.board?.name ? `On ${row.board.name}` : "On a round", day].filter(Boolean).join(" · ");
  }
  if (row.status === "completed") {
    return row.completed_at ? `Finished ${formatAdelaideDate(toZonedDate(row.completed_at), "medium")}` : "Finished";
  }
  if (!row.delivery_required) return row.due_date ? `Customer collecting ${formatAdelaideDate(row.due_date, "medium")}` : "Customer collecting";
  return row.due_date ? `Due ${formatAdelaideDate(row.due_date, "medium")}` : "No date set";
}
