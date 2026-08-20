import { CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { preferredRunDate } from "@/lib/domain/run-assignment";
import { formatAdelaideDate } from "@/lib/domain/timezone";
import { assignJobToBoard } from "./actions";

/**
 * Assign Board — two answers, one button.
 *
 * The whole user-facing assignment model is in this form: *who* is taking the
 * job, and *when*. There is no run to pick, no stop to place it at and no
 * sequence to set; the action resolves all of that behind the scenes. That is
 * the point of the simplification, and it is why this form works on a phone,
 * before hydration, with no JavaScript.
 *
 * **Expected delivery date and assigned delivery date are different questions**
 * and are shown as such. The first is what the customer was promised; the second
 * is the day the job is scheduled to a round. They are usually the same, which
 * is why the promise seeds the field — but an authorised user can move the
 * schedule without moving the promise, and seeing both is what stops that being
 * done by accident.
 */
export function AssignForm({
  orderId, defaultBoardId, defaultDate, expectedDeliveryDate, boards, returnTo,
  currentAssignment, compact = false,
}: {
  orderId: string;
  defaultBoardId: string | null;
  /** The day in view — the fallback when the promised date has already gone. */
  defaultDate: string;
  expectedDeliveryDate: string | null;
  boards: Array<{ id: string; name: string }>;
  returnTo: string;
  /** Set when the job already has a board: the form becomes a reassignment. */
  currentAssignment?: { boardName: string; deliveryDate: string } | null;
  compact?: boolean;
}) {
  const date = preferredRunDate({ due_date: expectedDeliveryDate }, defaultDate);
  const reassigning = !!currentAssignment;

  if (boards.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There are no active boards to assign this to yet.
      </p>
    );
  }

  return (
    <form action={assignJobToBoard} className={cx("space-y-3", compact && "space-y-2")}>
      <input type="hidden" name="order_id" value={orderId} />
      <input type="hidden" name="return_to" value={returnTo} />

      {reassigning ? (
        <p className="text-sm text-muted-foreground">
          Currently with <span className="font-medium text-foreground">
            {currentAssignment.boardName}
          </span>{" "}
          for {formatAdelaideDate(currentAssignment.deliveryDate, "medium")}.
        </p>
      ) : expectedDeliveryDate ? (
        <p className="text-sm text-muted-foreground">
          Expected delivery date:{" "}
          <span className="font-medium text-foreground">
            {formatAdelaideDate(expectedDeliveryDate, "medium")}
          </span>
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`board-${orderId}`} className="mb-1 block text-sm font-medium">
            Board
          </label>
          <select
            id={`board-${orderId}`}
            name="board_id"
            defaultValue={defaultBoardId ?? ""}
            className={cx(CONTROL, SELECT_CHEVRON)}
            required
          >
            <option value="">Select Board…</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>{board.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`assigned-date-${orderId}`} className="mb-1 block text-sm font-medium">
            Assigned delivery date
          </label>
          <input
            id={`assigned-date-${orderId}`}
            type="date"
            name="assigned_delivery_date"
            defaultValue={date}
            className={CONTROL}
            required
          />
        </div>
      </div>

      <SubmitButton size="lg" pendingLabel={reassigning ? "Reassigning…" : "Assigning…"}>
        {reassigning ? "Reassign" : "Assign"}
      </SubmitButton>
    </form>
  );
}
