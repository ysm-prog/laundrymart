"use client";

import { useState } from "react";
import { Card, CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import { SubmitButton } from "@/components/form";
import { WEEKDAYS } from "@/lib/domain/collections";
import { setCustomersRound } from "./actions";

/**
 * Set the round for a page of customers at once (brief 2.2).
 *
 * A job only goes onto a round by itself once its customer has one, and on the
 * live laundry 2 of 513 did. This is the panel that fixes that without 511 edit
 * forms: tick the customers on screen, choose the round and the day, press
 * once. The **No round** filter above narrows the list to the ones still to do.
 *
 * One press is one request, re-checked by the action — the same contract as
 * Move to board and the billing bulk forms. The checkbox wears the shared skin
 * and a `min-h-11` label rather than a bare 16px box, for the reason given there.
 */

const CHECKBOX = "size-[1.15rem] shrink-0 rounded border-strong accent-primary";

export type RoundRow = { id: string; name: string; number: string; round: string | null };
export type RoundBoard = { id: string; name: string };

export function SetRound({
  customers, boards, returnTo,
}: {
  customers: RoundRow[];
  boards: RoundBoard[];
  returnTo: string;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [boardId, setBoardId] = useState("");
  if (customers.length === 0) return null;

  const allSelected = customers.every((row) => selected.has(row.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card
      title="Set the round"
      description="Tick customers on this page, choose their round and the day it calls. Their laundry then goes onto that round as soon as it is ready for delivery."
    >
      <form action={setCustomersRound} className="space-y-3">
        <input type="hidden" name="return_to" value={returnTo} />

        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
          <input
            type="checkbox" className={CHECKBOX} checked={allSelected}
            onChange={() =>
              setSelected(allSelected ? new Set() : new Set(customers.map((row) => row.id)))}
          />
          Select all {customers.length} on this page
        </label>

        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {customers.map((row) => (
            <li key={row.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox" name="selected" value={row.id} className={CHECKBOX}
                  checked={selected.has(row.id)} onChange={() => toggle(row.id)}
                />
                <span className="min-w-0 flex-1 font-medium">{row.name}</span>
                <span className="text-muted-foreground">{row.round ?? "No round"}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-48">
            <label htmlFor="set-round-board" className="mb-1 block text-sm font-medium">Round</label>
            <select
              id="set-round-board" name="board_id" value={boardId}
              onChange={(event) => setBoardId(event.target.value)}
              className={cx(CONTROL, SELECT_CHEVRON)}
            >
              <option value="">No round</option>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>{board.name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-40">
            <label htmlFor="set-round-day" className="mb-1 block text-sm font-medium">Day it calls</label>
            <select
              id="set-round-day" name="weekday" defaultValue="" disabled={!boardId}
              className={cx(CONTROL, SELECT_CHEVRON)}
            >
              <option value="">Choose a day…</option>
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>{day.label}</option>
              ))}
            </select>
          </div>
          <SubmitButton pendingLabel="Saving…" disabled={selected.size === 0}>
            {boardId ? `Set round for ${selected.size}` : `Clear round for ${selected.size}`}
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
