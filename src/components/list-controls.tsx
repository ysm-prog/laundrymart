import type { ReactNode } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { isFiltered as anyFilterSet, filterHref, type FilterParams } from "@/lib/filters";
import { CONTROL, SELECT_CHEVRON, cx } from "./ui";

/**
 * The filter bar over a list. A GET form, so the filtered list lives in the URL
 * and can be bookmarked or sent to someone.
 *
 * Uses the shared `CONTROL` skin: this bar was written before the design system
 * and kept its own sizes and borders, so on every list page the search box was
 * visibly a different control than every other input on screen.
 *
 * Sits on its own card so it reads as the controls for the list beneath it
 * rather than as a stray row of inputs. On a phone the fields stack full-width;
 * the selects stay native, which is the right picker on a touch device.
 *
 * **The layout is chips, then fields, then a summary**, adopted from
 * `ysm-prog/ysm-hub` (§10b) so both products filter the same way:
 *
 *   1. `chips` — the one or two questions this list is usually narrowed by,
 *      answered in a single press. A chip is a link and applies immediately.
 *   2. the search box and any `filters` selects — the long tail, answered
 *      together and submitted once.
 *   3. `FilterSummary` — how many rows are showing, and the way back out.
 *
 * A page may use any of the three. What it must not do is hand-roll a fourth:
 * the drift this component exists to prevent is a list whose search box is a
 * different control from every other input in the app, and that has happened
 * here before.
 */
export function ListControls({
  action, q, filters, chips, summary, placeholder = "Search this list\u2026",
  params = {}, filterKeys, searchId,
}: {
  action: string;
  q?: string;
  placeholder?: string;
  filters?: ReadonlyArray<{
    name: string;
    label: string;
    value?: string;
    options: ReadonlyArray<{ value: string; label: string }>;
  }>;
  /** Chip groups rendered above the fields — `FilterChips`, `ToggleChips`, `PeriodFilter`. */
  chips?: ReactNode;
  /** The count line under the bar, usually a `FilterSummary`. */
  summary?: ReactNode;
  /** Every filter parameter currently applied, so Clear knows there is something to clear. */
  params?: FilterParams;
  /**
   * Which parameters count as a filter. Defaults to `q` plus the select names —
   * a page with chips passes their names too, or Clear never appears for them.
   */
  filterKeys?: readonly string[];
  /**
   * The search input's DOM id. Derived from `action` by default, which is unique
   * as long as one page draws one bar per list — a hard-coded `id="q"` was fine
   * until a page grew a second list, and then the label pointed at the wrong box.
   */
  searchId?: string;
}) {
  const inputId = searchId ?? `q-${action.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const keys = filterKeys ?? ["q", ...(filters ?? []).map((filter) => filter.name)];
  const filtered = anyFilterSet({ ...params, q: q ?? params.q }, keys);

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-xl border bg-surface p-3 shadow-sm">
      {chips ? <div className="flex flex-col gap-3">{chips}</div> : null}
      <form method="get" action={action}
            className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {/* Chip selections ride through the search as hidden fields, or typing a
            search term would silently throw away the chip somebody pressed. */}
        {Object.entries(params).map(([key, value]) =>
          value && key !== "q" && key !== "page" && !(filters ?? []).some((f) => f.name === key)
            ? <input key={key} type="hidden" name={key} value={value} />
            : null)}
        {/* The floor is `sm:` and not unconditional. Below `sm` the bar stacks,
            so the search box is already full width and needs no minimum — and a
            floor in `rem` grows with the reading control, so at Large on a 320px
            phone a 14rem minimum is 258px inside a 296px card and pushes the
            page sideways. A `min-w` in rem that scales with the text defeats
            itself; the same trap the 2026-08-24 accessibility pass recorded. */}
        <div className="relative flex-1 sm:min-w-[14rem]">
          <label htmlFor={inputId} className="sr-only">Search this list</label>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2
                             text-muted-foreground" aria-hidden />
          <input id={inputId} name="q" type="search" defaultValue={q} placeholder={placeholder}
                 className={cx(CONTROL, "pl-9")} />
        </div>
        {filters?.map((filter) => (
          <div key={filter.name} className="sm:w-auto">
            <label htmlFor={filter.name} className="sr-only">{filter.label}</label>
            <select id={filter.name} name={filter.name} defaultValue={filter.value ?? ""}
                    className={cx(CONTROL, SELECT_CHEVRON, "sm:w-auto")}>
              <option value="">Any {filter.label.toLowerCase()}</option>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        ))}
        <button type="submit"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-action
                           px-5 text-sm font-medium text-action-foreground shadow-xs transition
                           hover:brightness-110">
          Search
        </button>
        {/* Only when there is no summary beneath. A `FilterSummary` carries its
            own Clear, and two of them a few pixels apart is one control drawn
            twice — the reader has to work out whether they do the same thing. */}
        {filtered && !summary ? (
          <Link href={filterHref(action, {})}
                className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium
                           text-primary hover:underline">
            <X className="size-4" aria-hidden />
            Clear
          </Link>
        ) : null}
      </form>
      {summary}
    </div>
  );
}

export const PAGE_SIZE = 25;

export function Pagination({
  page, total, params, basePath, pageSize = PAGE_SIZE,
}: {
  page: number;
  total: number;
  params: Record<string, string | undefined>;
  basePath: string;
  pageSize?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  const href = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "page") search.set(key, value);
    }
    search.set("page", String(target));
    return `${basePath}?${search.toString()}`;
  };

  const link =
    "inline-flex min-h-10 items-center rounded-lg border border-strong bg-surface px-4 " +
    "text-sm font-medium shadow-xs transition hover:bg-surface-muted";
  return (
    <nav aria-label="Pagination"
         className="mt-4 flex flex-wrap items-center justify-between gap-3">
      {/* "record" is the developer's word for it. The operator is looking at
          customers, or invoices, or stops — so the caller names them. */}
      <p className="text-sm text-muted-foreground">
        Page {page} of {pages} · {total} in total
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={link}>Previous</Link>
        ) : (
          <span className={cx(link, "pointer-events-none opacity-40")}>Previous</span>
        )}
        {page < pages ? (
          <Link href={href(page + 1)} className={link}>Next</Link>
        ) : (
          <span className={cx(link, "pointer-events-none opacity-40")}>Next</span>
        )}
      </div>
    </nav>
  );
}

/** `?page=` → a 1-based integer, tolerant of junk. */
export function pageFrom(value: string | undefined): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function rangeFor(page: number, pageSize = PAGE_SIZE): [number, number] {
  const from = (page - 1) * pageSize;
  return [from, from + pageSize - 1];
}
