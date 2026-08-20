"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import {
  addDays, formatAdelaideDate, getAdelaideToday, isAdelaideToday,
} from "@/lib/domain/timezone";
import type { RunBoard } from "@/lib/runs/my-runs";

/**
 * The operational date control, and the board picker beside it.
 *
 * Deliberately three links and a native date input rather than a calendar
 * component. Previous / Today / Next is what a round actually presses — on a
 * phone, in a hurry, possibly with one hand — and `<input type="date">` opens
 * the platform's own picker, which is a better date picker than anything that
 * could be built here and is the control the rest of the app already uses.
 *
 * **Nothing here has a "Show" or a "Go" button.** Choosing a day is not a query
 * you compose and then run; it is a navigation, and asking for a second press to
 * confirm the first was the single most-reported friction on this screen. The
 * arrows are plain anchors, and the date and board controls submit themselves
 * the moment they change. A `sr-only` submit stays in each form so the flow
 * still completes by keyboard and before hydration — the control degrades, it
 * does not disappear.
 *
 * Every date in it is Adelaide's. "Today" is Adelaide's today, not the
 * browser's — a phone still on eastern time after a trip must
 * not be shown tomorrow's work.
 */
export function DateNav({
  date, boardParam, boards, canChooseBoard, pending,
}: {
  date: string;
  /** The `?board=` value to carry through the links: an id, or "me". */
  boardParam: string;
  boards: RunBoard[];
  canChooseBoard: boolean;
  /** True while the day behind it is still loading, so the control can say so. */
  pending?: boolean;
}) {
  const today = getAdelaideToday();
  const href = (target: string) =>
    `/my-runs?date=${target}${boardParam === "me" ? "" : `&board=${boardParam}`}`;

  const step =
    "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg border " +
    "border-strong bg-surface px-3 text-sm font-medium shadow-xs transition " +
    "hover:bg-surface-muted focus:outline-none focus:ring-2 focus:ring-primary/25";

  /** Submit the enclosing GET form as soon as the control changes. */
  const submitOnChange = (event: { currentTarget: HTMLElement & { form: HTMLFormElement | null } }) => {
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {/* Previous / Today / Next are one group and stay one group. Letting
            them wrap put the two arrows on different lines at 390px, which is
            the width this control is used at most. */}
        <div className="flex items-center gap-2">
          <Link href={href(addDays(date, -1))} className={step} aria-label="Previous day">
            <ChevronLeft className="size-4" aria-hidden />
            <span className="hidden sm:inline">Previous</span>
          </Link>

          <Link
            href={href(today)}
            aria-current={isAdelaideToday(date) ? "page" : undefined}
            className={cx(step, isAdelaideToday(date) && "border-primary text-primary")}
          >
            Today
          </Link>

          <Link href={href(addDays(date, 1))} className={step} aria-label="Next day">
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4" aria-hidden />
          </Link>
        </div>

        {/* A GET form: the chosen day is a navigation, so it belongs in the URL
            where it can be bookmarked, shared and used by the back button. */}
        <form method="get" action="/my-runs" className="flex items-center gap-2">
          {boardParam !== "me" ? (
            <input type="hidden" name="board" value={boardParam} />
          ) : null}
          <label className="sr-only" htmlFor="my-runs-date">Show another date</label>
          <input
            id="my-runs-date"
            type="date"
            name="date"
            defaultValue={date}
            onChange={submitOnChange}
            className={cx(CONTROL, "w-auto min-w-[9.5rem]")}
          />
          <button type="submit" className="sr-only">Show this date</button>
        </form>

        <p aria-live="polite" className="text-sm text-muted-foreground">
          {pending ? "Loading…" : <span className="sr-only">{formatAdelaideDate(date, "long")}</span>}
        </p>
      </div>

      {canChooseBoard ? (
        <form method="get" action="/my-runs" className="flex items-end gap-2">
          <input type="hidden" name="date" value={date} />
          <div>
            <label htmlFor="my-runs-board" className="mb-1 block text-sm font-medium">
              Board
            </label>
            <select
              id="my-runs-board"
              name="board"
              defaultValue={boardParam}
              onChange={submitOnChange}
              className={cx(CONTROL, SELECT_CHEVRON, "w-auto min-w-[12rem]")}
            >
              <option value="me">Me</option>
              {boards.map((board) => (
                <option key={board.id} value={board.id}>{board.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="sr-only">Show this board</button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The date, spelled out. Its own component because the heading, the empty state
 * and the sticky phone bar all have to say the same day the same way.
 */
export function SelectedDate({ date }: { date: string }) {
  return <>{formatAdelaideDate(date, "long")}</>;
}
