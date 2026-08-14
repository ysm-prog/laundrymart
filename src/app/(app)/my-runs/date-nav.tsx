import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CONTROL, SELECT_CHEVRON, cx } from "@/components/ui";
import {
  addDays, formatAdelaideDate, getAdelaideToday, isAdelaideToday,
} from "@/lib/domain/timezone";
import type { RunDriver } from "@/lib/runs/my-runs";

/**
 * The operational date control, and the driver picker beside it.
 *
 * Deliberately three links and a native date input rather than a calendar
 * component. Previous / Today / Next is what a driver actually presses — on a
 * phone, in a hurry, possibly with one hand — and `<input type="date">` opens
 * the platform's own picker, which is a better date picker than anything that
 * could be built here and is the control the rest of the app already uses.
 *
 * It works with JavaScript disabled and before hydration, because it is three
 * anchors and a GET form. That matters more here than anywhere else in the app:
 * this screen is opened on a phone with one bar of signal.
 *
 * Every date in it is Adelaide's. "Today" is Adelaide's today, not the
 * browser's — a driver whose phone is still on Sydney time after a trip must
 * not be shown tomorrow's run.
 */
export function DateNav({
  date, driverParam, drivers, canChooseDriver,
}: {
  date: string;
  /** The `?driver=` value to carry through the links: an id, or "me". */
  driverParam: string;
  drivers: RunDriver[];
  canChooseDriver: boolean;
}) {
  const today = getAdelaideToday();
  const href = (target: string) =>
    `/my-runs?date=${target}${driverParam === "me" ? "" : `&driver=${driverParam}`}`;

  const step =
    "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg border " +
    "border-strong bg-surface px-3 text-sm font-medium shadow-xs transition " +
    "hover:bg-surface-muted focus:outline-none focus:ring-2 focus:ring-primary/25";

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

        {/* A GET form: changing the date is a navigation, so it belongs in the
            URL where it can be bookmarked, shared with a dispatcher and used by
            the back button. */}
        <form method="get" action="/my-runs" className="flex items-center gap-2">
          {driverParam !== "me" ? (
            <input type="hidden" name="driver" value={driverParam} />
          ) : null}
          <label className="sr-only" htmlFor="my-runs-date">Show another date</label>
          <input
            id="my-runs-date"
            type="date"
            name="date"
            defaultValue={date}
            className={cx(CONTROL, "w-auto min-w-[9.5rem]")}
          />
          <button type="submit" className={step}>Go</button>
        </form>
      </div>

      {canChooseDriver ? (
        <form method="get" action="/my-runs" className="flex items-end gap-2">
          <input type="hidden" name="date" value={date} />
          <div>
            <label htmlFor="my-runs-driver" className="mb-1 block text-sm font-medium">
              Driver
            </label>
            <select
              id="my-runs-driver"
              name="driver"
              defaultValue={driverParam}
              className={cx(CONTROL, SELECT_CHEVRON, "w-auto min-w-[12rem]")}
            >
              <option value="me">Me</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>{driver.full_name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className={step}>Show</button>
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
