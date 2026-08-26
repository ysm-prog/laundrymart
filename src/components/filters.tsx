import type { ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import {
  PERIOD_PRESET_LABELS, formatIso, periodFor, type IsoDate, type PeriodPreset,
  type ResolvedPeriod,
} from "@/lib/domain/dates";
import { counted, plural } from "@/lib/format";
import { filterHref, parseMulti, toggleMulti, type FilterParams } from "@/lib/filters";
import { CONTROL_AUTO, cx } from "./ui";

/**
 * The chip language every list page filters with.
 *
 * Adopted from `ysm-prog/ysm-hub`'s `.period-filter` / `.status-strip` (see
 * §10b) so the two products read as one company's software: a segmented group
 * of small pills, the active one filled, sitting above the list it narrows.
 *
 * Three departures from YSM's own implementation, each of which is this app's
 * existing rule rather than a preference:
 *
 *   - **A chip is a link, not a button wired to state.** Every list page here is
 *     an async server component; the filter has to be in the URL for the render
 *     to see it at all, and putting it there is also what makes a filtered list
 *     bookmarkable and shareable. YSM's pages are client-rendered and keep the
 *     same fact in React state synced to the URL.
 *   - **The active chip is an ink pill**, which is §10b's "this is where you
 *     are" — the same treatment as the active rail row, and deliberately not
 *     teal. Teal means *this is the action*, and a filter you have already
 *     applied is not the action.
 *   - **44px tall, not 28.** YSM's chips are a desktop console's; these are
 *     pressed on a counter tablet.
 */

const CHIP_BASE =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium " +
  "whitespace-nowrap transition-colors";
const CHIP_ON = "border-foreground bg-foreground text-background";
const CHIP_OFF = "border-border bg-surface text-foreground hover:border-strong hover:bg-surface-muted";

/** One chip, rendered as a link. Exported so a page can compose an odd one. */
export function FilterChip({
  href, active, count, title, children,
}: {
  href: string;
  active?: boolean;
  /** How many rows this chip would show. Omitted when the page cannot count cheaply. */
  count?: number;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "true" : undefined}
      className={cx(CHIP_BASE, active ? CHIP_ON : CHIP_OFF)}
    >
      <span>{children}</span>
      {typeof count === "number" ? (
        <span className={cx(
          "rounded px-1 text-2xs tabular-nums",
          active ? "bg-background/20" : "bg-surface-muted text-muted-foreground",
        )}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}

export type ChipOption = {
  value: string;
  label: string;
  /** Rows this option would show. Shown on the chip, and used to grey an empty one. */
  count?: number;
  title?: string;
};

/**
 * A single-select chip group: picking one replaces the last, and picking the
 * active one clears it.
 *
 * The leading chip is the unfiltered view and is always present, because a
 * group with no way back is a filter somebody has to reload the page to escape.
 */
export function FilterChips({
  basePath, params, name, label, options, allLabel = "All", allCount,
}: {
  basePath: string;
  params: FilterParams;
  name: string;
  label: string;
  options: readonly ChipOption[];
  allLabel?: string;
  allCount?: number;
}) {
  const active = params[name];
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <FilterChip
        href={filterHref(basePath, params, { [name]: undefined })}
        active={!active}
        count={allCount}
      >
        {allLabel}
      </FilterChip>
      {options.map((option) => (
        <FilterChip
          key={option.value}
          href={filterHref(basePath, params, {
            // Pressing the chip you are already on clears it, so the group has
            // two ways out rather than one.
            [name]: active === option.value ? undefined : option.value,
          })}
          active={active === option.value}
          count={option.count}
          title={option.title}
        >
          {option.label}
        </FilterChip>
      ))}
    </div>
  );
}

/**
 * A multi-select chip group: chips add up, and the list shows rows matching any
 * of them.
 *
 * YSM's status strip, and the reason it is worth the extra parameter shape is
 * the question it answers — *show me everything that is stuck*, which is two or
 * three statuses at once and cannot be asked with a `<select>` at all.
 */
export function ToggleChips({
  basePath, params, name, label, options, allLabel = "All", allCount,
}: {
  basePath: string;
  params: FilterParams;
  name: string;
  label: string;
  options: readonly ChipOption[];
  allLabel?: string;
  allCount?: number;
}) {
  const allowed = options.map((option) => option.value);
  const selected = parseMulti(params[name], allowed);
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <FilterChip
        href={filterHref(basePath, params, { [name]: undefined })}
        active={selected.length === 0}
        count={allCount}
      >
        {allLabel}
      </FilterChip>
      {options.map((option) => (
        <FilterChip
          key={option.value}
          href={filterHref(basePath, params, {
            [name]: toggleMulti(selected, option.value, allowed),
          })}
          active={selected.includes(option.value)}
          count={option.count}
          title={option.title}
        >
          {option.label}
        </FilterChip>
      ))}
    </div>
  );
}

/**
 * The date window a list is showing: preset chips, then a custom range.
 *
 * The custom range is its own `GET` form rather than two inputs inside the chip
 * row, because a date pair is only meaningful once both ends are filled — a
 * chip navigates on press and would take you somewhere half-answered.
 *
 * The resolved window is printed beside the chips. Without it "This quarter" is
 * a claim the reader has to take on trust, and the first thing anybody does with
 * a financial-year filter is check which one it means.
 */
export function PeriodFilter({
  basePath, params, period, presets, today, label = "Period", hideCustomWhenPreset = false,
}: {
  basePath: string;
  params: FilterParams;
  period: ResolvedPeriod;
  presets: readonly PeriodPreset[];
  today: IsoDate;
  label?: string;
  /** Keep the from/to inputs out of the way until Custom is picked (YSM's own behaviour). */
  hideCustomWhenPreset?: boolean;
}) {
  const custom = period.preset === "custom";
  const showRange = custom || !hideCustomWhenPreset;
  // Carry every other filter through a period change, and drop the dates a
  // preset does not need — a stale `from` left in the URL would out-rank the
  // preset on the next reader (`resolvePeriod` takes a bare pair as custom).
  const hrefFor = (preset: PeriodPreset) =>
    filterHref(basePath, params, {
      period: preset,
      from: undefined,
      to: undefined,
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
        {presets.map((preset) => (
          <FilterChip
            key={preset}
            href={preset === "custom"
              ? filterHref(basePath, params, {
                  period: "custom",
                  // Custom with nothing typed yet has no window, so it opens on
                  // the preset's own dates rather than on an empty pair.
                  from: period.range?.start ?? periodFor("this_month", today)!.start,
                  to: period.range?.end ?? periodFor("this_month", today)!.end,
                })
              : hrefFor(preset)}
            active={period.preset === preset}
          >
            {PERIOD_PRESET_LABELS[preset]}
          </FilterChip>
        ))}
        {period.range ? (
          <span className="text-2xs text-muted-foreground">
            {period.range.start === period.range.end
              ? formatIso(period.range.start)
              : `${formatIso(period.range.start)} – ${formatIso(period.range.end)}`}
          </span>
        ) : null}
      </div>

      {showRange ? (
        <form method="get" action={basePath} className="flex flex-wrap items-center gap-2">
          {/* Every other filter rides through as a hidden field, or picking a
              range would silently drop the status somebody had chosen. */}
          {Object.entries(params).map(([key, value]) =>
            value && !["period", "from", "to", "page"].includes(key)
              ? <input key={key} type="hidden" name={key} value={value} />
              : null)}
          <input type="hidden" name="period" value="custom" />
          <label htmlFor={`${basePath}-from`} className="text-2xs text-muted-foreground">From</label>
          <input id={`${basePath}-from`} name="from" type="date" required
                 defaultValue={period.range?.start ?? ""}
                 className={CONTROL_AUTO} />
          <label htmlFor={`${basePath}-to`} className="text-2xs text-muted-foreground">To</label>
          <input id={`${basePath}-to`} name="to" type="date" required
                 defaultValue={period.range?.end ?? ""}
                 className={CONTROL_AUTO} />
          <button type="submit"
                  className={cx(CHIP_BASE, CHIP_OFF, "px-4")}>
            Show this range
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The line under a filter bar: what is being shown, and the way out.
 *
 * The count is the half people miss. A list that has been narrowed to four rows
 * looks exactly like a list that only ever had four rows, and the difference
 * matters most to the person least sure the app is working.
 */
export function FilterSummary({
  basePath, shown, total, noun, nouns, filtered,
}: {
  basePath: string;
  /** Rows on screen after filtering. */
  shown: number;
  /** Rows before filtering, when the page knows it. */
  total?: number;
  /** What is being counted, singular — "customer", "job". */
  noun: string;
  /** The plural, where English does not simply add an "s" — "batches", "people". */
  nouns?: string;
  filtered: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {filtered && typeof total === "number" && total !== shown
          ? `Showing ${shown} of ${total} ${plural(total, noun, nouns)}`
          : counted(shown, noun, nouns)}
      </p>
      {filtered ? (
        <Link href={basePath}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-primary hover:underline">
          <X className="size-4" aria-hidden />
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
