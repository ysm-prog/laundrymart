import Link from "next/link";
import { Search } from "lucide-react";
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
 */
export function ListControls({
  action, q, filters, placeholder = "Search this list…",
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
}) {
  return (
    <form method="get" action={action}
          className="mb-5 flex flex-col gap-3 rounded-xl border bg-surface p-3 shadow-sm
                     sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative min-w-[14rem] flex-1">
        <label htmlFor="q" className="sr-only">Search this list</label>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2
                           text-muted-foreground" aria-hidden />
        <input id="q" name="q" type="search" defaultValue={q} placeholder={placeholder}
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
    </form>
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
