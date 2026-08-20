import Link from "next/link";
import {
  PERIOD_PRESETS, PERIOD_PRESET_LABELS, periodFor, presetForRange, type IsoDate,
} from "@/lib/domain/dates";
import { cx } from "@/components/ui";
import { Field, Input } from "@/components/form";

/**
 * The period picker: four quick filters and a custom range.
 *
 * A server component, deliberately. The period lives in the URL — so a chosen
 * month survives a refresh, a bookmark and a link pasted to somebody else — and
 * the quick filters are therefore plain links, not buttons wired to state. The
 * custom range is a `GET` form for the same reason: it navigates rather than
 * posting, and lands somewhere shareable.
 *
 * The pressed filter is worked out from the dates rather than tracked
 * separately, so a bookmarked URL highlights the right one instead of always
 * falling to Custom.
 */
export function PeriodFilter({
  basePath, start, end, today, extra = {},
}: {
  basePath: string;
  start: IsoDate;
  end: IsoDate;
  today: IsoDate;
  /** Query parameters to carry through a filter change, e.g. `show`. */
  extra?: Record<string, string>;
}) {
  const active = presetForRange(start, end, today);

  const hrefFor = (from: IsoDate, to: IsoDate) => {
    const params = new URLSearchParams({ from, to, ...extra });
    return `${basePath}?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Billing period">
        {PERIOD_PRESETS.filter((preset) => preset !== "custom").map((preset) => {
          const range = periodFor(preset, today)!;
          const isActive = active === preset;
          return (
            <Link
              key={preset}
              href={hrefFor(range.start, range.end)}
              aria-current={isActive ? "true" : undefined}
              className={cx(
                "inline-flex min-h-9 items-center rounded-lg border px-3 text-sm transition-colors",
                isActive
                  ? "border-action bg-action text-action-foreground"
                  : "border-border bg-surface text-foreground hover:border-strong",
              )}
            >
              {PERIOD_PRESET_LABELS[preset]}
            </Link>
          );
        })}
        {active === "custom" ? (
          <span className="inline-flex min-h-9 items-center rounded-lg border border-action bg-action px-3 text-sm text-action-foreground">
            {PERIOD_PRESET_LABELS.custom}
          </span>
        ) : null}
      </div>

      <form method="get" action={basePath} className="flex flex-wrap items-end gap-3">
        {Object.entries(extra).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <Field label="From" name="from" className="min-w-40">
          <Input name="from" type="date" defaultValue={start} required />
        </Field>
        <Field label="To" name="to" className="min-w-40">
          <Input name="to" type="date" defaultValue={end} required />
        </Field>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-lg border border-strong bg-surface px-4 text-sm font-medium hover:bg-surface-muted"
        >
          Show this range
        </button>
      </form>
    </div>
  );
}
