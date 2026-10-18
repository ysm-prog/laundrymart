"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, CONTROL_AUTO, SELECT_CHEVRON, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import {
  BOARD_COLUMNS, canApprove, canAssign, canMarkReady, type BoardColumn,
} from "@/lib/domain/laundry-board";

export type BoardCard = {
  id: string;
  orderNumber: string;
  customer: string;
  column: BoardColumn;
  status: string;
  billingStatus: string;
  deliveryRequired: boolean;
  assignedBoardId: string | null;
  chargeCount: number;
  /** "On Board 1 · Tue 21 Oct", "Due Mon 20 Oct", "Customer collecting". */
  detail: string;
  /** Billing word on a finished job, or null. */
  billing: string | null;
  overdue: boolean;
};

type Action = (formData: FormData) => void | Promise<void>;

/**
 * The Laundry board's columns and its one selection (brief 3.3).
 *
 * The selection is client state and each bulk action is its own small form
 * carrying only the ticked jobs **that action applies to** — so pressing
 * Approve with a plant job ticked posts only the finished ones, and a button
 * whose count is 0 is disabled rather than offered to fail. The actions re-check
 * every job; this is the courtesy, they are the guard.
 */
export function BoardView({
  cards, boards, today, returnTo, may, actions,
}: {
  cards: BoardCard[];
  boards: Array<{ id: string; name: string }>;
  today: string;
  returnTo: string;
  may: { markReady: boolean; assign: boolean; approve: boolean };
  actions: { markReady: Action; assign: Action; approve: Action };
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const byColumn = useMemo(() => {
    const map = new Map<BoardColumn, BoardCard[]>();
    for (const column of BOARD_COLUMNS) map.set(column.key, []);
    for (const card of cards) map.get(card.column)?.push(card);
    return map;
  }, [cards]);

  const chosen = cards.filter((card) => selected.has(card.id));
  const job = (card: BoardCard) => ({
    status: card.status, billing_status: card.billingStatus,
    delivery_required: card.deliveryRequired, assigned_board_id: card.assignedBoardId,
    charge_count: card.chargeCount,
  });
  const readyIds = chosen.filter((card) => canMarkReady(job(card))).map((card) => card.id);
  const assignIds = chosen.filter((card) => canAssign(job(card))).map((card) => card.id);
  const approveIds = chosen.filter((card) => canApprove(job(card))).map((card) => card.id);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleColumn(ids: string[]) {
    setSelected((current) => {
      const next = new Set(current);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (all) next.delete(id); else next.add(id);
      }
      return next;
    });
  }

  const hidden = (ids: string[]) => (
    <>
      <input type="hidden" name="return_to" value={returnTo} />
      {ids.map((id) => <input key={id} type="hidden" name="selected" value={id} />)}
    </>
  );

  return (
    <div className="space-y-4">
      {(may.markReady || may.assign || may.approve) ? (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-3 rounded-xl border bg-surface
                        px-4 py-3 shadow-sm">
          <p className="text-sm font-medium">
            {chosen.length === 0 ? "Tick jobs to act on them together." : `${chosen.length} ticked`}
          </p>
          {may.markReady ? (
            <form action={actions.markReady}>
              {hidden(readyIds)}
              <SubmitButton size="md" variant="secondary" disabled={readyIds.length === 0}
                            pendingLabel="Marking…">
                Mark ready{readyIds.length ? ` (${readyIds.length})` : ""}
              </SubmitButton>
            </form>
          ) : null}
          {may.assign && boards.length > 0 ? (
            <form action={actions.assign} className="flex flex-wrap items-center gap-2">
              {hidden(assignIds)}
              <label className="sr-only" htmlFor="board-assign-board">Board</label>
              <select id="board-assign-board" name="board_id" defaultValue={boards[0]!.id}
                      className={cx(CONTROL_AUTO, SELECT_CHEVRON)}>
                {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
              </select>
              <label className="sr-only" htmlFor="board-assign-date">Delivery day</label>
              <input id="board-assign-date" type="date" name="date" defaultValue={today} min={today}
                     className={CONTROL_AUTO} />
              <SubmitButton size="md" variant="secondary" disabled={assignIds.length === 0}
                            pendingLabel="Assigning…">
                Assign{assignIds.length ? ` (${assignIds.length})` : ""}
              </SubmitButton>
            </form>
          ) : null}
          {may.approve ? (
            <form action={actions.approve}>
              {hidden(approveIds)}
              <SubmitButton size="md" variant="secondary" disabled={approveIds.length === 0}
                            pendingLabel="Approving…">
                Approve{approveIds.length ? ` (${approveIds.length})` : ""}
              </SubmitButton>
            </form>
          ) : null}
          {chosen.length > 0 ? (
            <button type="button" onClick={() => setSelected(new Set())}
                    className="min-h-10 text-sm font-medium text-muted-foreground hover:text-foreground">
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Five columns on a wide screen, scrolled sideways on anything narrower —
          a column squeezed under 15rem cannot show a customer's name. */}
      <div className="overflow-x-auto pb-2">
        <div className="grid min-w-[75rem] grid-cols-5 gap-3">
          {BOARD_COLUMNS.map((column) => {
            const list = byColumn.get(column.key) ?? [];
            const ids = list.map((card) => card.id);
            const allTicked = ids.length > 0 && ids.every((id) => selected.has(id));
            return (
              <section key={column.key} aria-labelledby={`col-${column.key}`}
                       className="relative flex min-w-0 flex-col rounded-xl border bg-surface-muted/40">
                <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
                  <div className="min-w-0">
                    <h2 id={`col-${column.key}`} className="text-sm font-semibold">
                      {column.label} <span className="font-normal text-muted-foreground">{list.length}</span>
                    </h2>
                    <p className="truncate text-xs text-muted-foreground">{column.hint}</p>
                  </div>
                  {ids.length > 0 ? (
                    <label className="flex min-h-10 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <input type="checkbox" checked={allTicked} onChange={() => toggleColumn(ids)}
                             className="size-[1.15rem] rounded border-control-border accent-primary" />
                      All
                    </label>
                  ) : null}
                </header>
                <ul className="flex flex-col gap-2 p-2">
                  {list.length === 0 ? (
                    <li className="px-1 py-3 text-xs text-muted-foreground">Nothing here.</li>
                  ) : list.map((card) => (
                    <li key={card.id}
                        className={cx("rounded-lg border bg-surface p-2.5",
                                      selected.has(card.id) && "border-primary ring-1 ring-primary/40")}>
                      <div className="flex items-start gap-2">
                        <input type="checkbox" checked={selected.has(card.id)} onChange={() => toggle(card.id)}
                               aria-label={`Tick ${card.orderNumber}`}
                               className="mt-0.5 size-[1.15rem] shrink-0 rounded border-control-border accent-primary" />
                        <div className="min-w-0 flex-1">
                          <Link href={`/orders/${card.id}`}
                                className="block truncate text-sm font-semibold hover:underline">
                            {card.customer}
                          </Link>
                          <p className="text-xs text-muted-foreground">{card.orderNumber} · {card.detail}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {card.overdue ? <Badge tone="danger">Overdue</Badge> : null}
                            {card.billing ? (
                              <Badge tone={card.billing === "Needs a price" ? "warning" : "neutral"}>
                                {card.billing}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
