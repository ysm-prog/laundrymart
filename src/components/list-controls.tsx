import Link from "next/link";
import { CONTROL, cx } from "./ui";

/**
 * The filter bar over a list. A GET form, so the filtered list lives in the URL
 * and can be bookmarked or sent to someone.
 *
 * Uses the shared `CONTROL` skin: this bar was written before the design system
 * and kept its own sizes and borders, so on every list page the search box was
 * visibly a different control than every other input on screen.
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
    <form method="get" action={action} className="mb-4 flex flex-wrap items-end gap-2">
      <div className="min-w-[12rem] flex-1">
        <label htmlFor="q" className="sr-only">Search this list</label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder={placeholder}
               className={CONTROL} />
      </div>
      {filters?.map((filter) => (
        <div key={filter.name}>
          <label htmlFor={filter.name} className="sr-only">{filter.label}</label>
          <select id={filter.name} name={filter.name} defaultValue={filter.value ?? ""}
                  className={cx(CONTROL, "w-auto")}>
            <option value="">Any {filter.label.toLowerCase()}</option>
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      ))}
      <button type="submit"
              className="inline-flex min-h-9 items-center border border-strong bg-surface px-3 py-1.5
                         text-[12.5px] font-medium transition hover:bg-surface-muted">
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

  const link = "inline-flex min-h-9 items-center border border-strong px-3 py-1.5 text-[12.5px]";
  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center justify-between gap-2">
      {/* "record" is the developer's word for it. The operator is looking at
          customers, or invoices, or stops — so the caller names them. */}
      <p className="text-xs text-muted-foreground">
        Showing page {page} of {pages} · {total} in total
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} className={link}>Previous</Link>
        ) : (
          <span className={cx(link, "opacity-40")}>Previous</span>
        )}
        {page < pages ? (
          <Link href={href(page + 1)} className={link}>Next</Link>
        ) : (
          <span className={cx(link, "opacity-40")}>Next</span>
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
